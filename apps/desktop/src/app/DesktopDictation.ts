// @effect-diagnostics nodeBuiltinImport:off -- The Node-API SDK runs only in the Electron main process.
import { Client } from "@dictation-api/client";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as DesktopAssets from "./DesktopAssets.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import {
  DictationSessionTargets,
  DICTATION_SESSION_TIMEOUT_ERROR,
} from "@t3tools/shared/dictationSessionTargets";
import { app, BrowserWindow, ipcMain, nativeImage, type WebContents } from "electron";

const eventChannel = "dictation:event";
const responseChannel = "dictation:respond";
const acknowledgementChannel = "dictation:acknowledge";

const { logError } = makeComponentLogger("desktop-dictation");

function connectDictation(
  icon: string | null,
  reportError: (session: string, error: string) => void,
) {
  let stopped = false;
  let client: Client | null = null;
  let lease: number | null = null;
  let lastWindow: BrowserWindow | null = BrowserWindow.getFocusedWindow();
  const targets = new DictationSessionTargets<WebContents>(
    () => {},
    (session, target) => {
      reportError(session, DICTATION_SESSION_TIMEOUT_ERROR);
      if (!target.isDestroyed()) target.send(eventChannel, { kind: "timeout", session });
      void client?.acknowledge(session, false, DICTATION_SESSION_TIMEOUT_ERROR).catch(() => {});
    },
  );
  const listeners = new Map<number, { target: WebContents; destroyed: () => void }>();
  const removeListener = (id: number) => {
    const listener = listeners.get(id);
    if (!listener) return;
    listeners.delete(id);
    listener.target.off("destroyed", listener.destroyed);
    if (lastWindow?.isDestroyed() || lastWindow?.webContents.id === id) lastWindow = null;
    for (const [session, target] of targets) {
      if (target.id === id) targets.delete(session);
    }
  };
  const activate = (_event: unknown, window: BrowserWindow) => {
    lastWindow = window;
    const current = client;
    if (!current) return;
    if (!listeners.has(window.webContents.id)) {
      deactivate(null, window);
      return;
    }
    void current
      .activate()
      .then(async (activation) => {
        lease = activation;
        if (!window.isFocused()) await current.deactivate(activation);
      })
      .catch(() => {});
  };
  const deactivate = (_event: unknown, window: BrowserWindow) => {
    if (lastWindow?.id !== window.id) return;
    const currentLease = lease;
    if (currentLease !== null) void client?.deactivate(currentLease).catch(() => {});
  };
  const listen = (event: Electron.IpcMainEvent) => {
    if (!listeners.has(event.sender.id)) {
      const id = event.sender.id;
      const destroyed = () => removeListener(id);
      listeners.set(id, { target: event.sender, destroyed });
      event.sender.once("destroyed", destroyed);
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window?.isFocused()) activate(null, window);
  };
  const unlisten = (event: Electron.IpcMainEvent) => {
    removeListener(event.sender.id);
  };
  ipcMain.on("dictation:listen", listen);
  ipcMain.on("dictation:unlisten", unlisten);
  ipcMain.handle(responseChannel, async (event, session: unknown, accept: unknown) => {
    if (
      typeof session !== "string" ||
      typeof accept !== "boolean" ||
      targets.get(session)?.id !== event.sender.id
    )
      throw new Error("Invalid dictation offer response");
    try {
      await client?.respond(session, accept);
    } catch (error) {
      targets.delete(session);
      throw error;
    } finally {
      if (!accept) targets.delete(session);
    }
  });
  ipcMain.handle(
    acknowledgementChannel,
    async (event, session: unknown, applied: unknown, error: unknown) => {
      if (
        typeof session !== "string" ||
        typeof applied !== "boolean" ||
        !(error === null || typeof error === "string") ||
        targets.get(session)?.id !== event.sender.id
      )
        throw new Error("Invalid dictation acknowledgement");
      targets.delete(session);
      if (!applied) reportError(session, error ?? "Dictation could not be delivered.");
      await client?.acknowledge(session, applied, error);
    },
  );
  app.on("browser-window-focus", activate);
  app.on("browser-window-blur", deactivate);
  const run = async () => {
    try {
      client = await Client.connect({
        id: "t3-code",
        name: app.getName(),
        icon,
        process_id: process.pid,
      });
      const window = BrowserWindow.getFocusedWindow();
      if (window) activate(null, window);
      for await (const event of client.events()) {
        if (stopped) break;
        if (event.kind === "offer") {
          const window = lastWindow;
          if (
            !window ||
            window.isDestroyed() ||
            window.webContents.isDestroyed() ||
            !listeners.has(window.webContents.id)
          ) {
            await client.respond(event.session, false);
            continue;
          }
          targets.set(event.session, window.webContents);
          window.webContents.send(eventChannel, { kind: "offer", session: event.session });
        } else if (event.kind === "transcript") {
          const target = targets.get(event.session);
          if (!target || target.isDestroyed()) {
            await client.acknowledge(event.session, false, "The original window closed.");
            targets.delete(event.session);
            continue;
          }
          target.send(eventChannel, {
            kind: "transcript",
            session: event.session,
            ...event.transcript,
          });
        } else if (event.kind === "cancelled") {
          const target = targets.get(event.session);
          const timedOut =
            event.reason === "session timed out" || event.reason === "offer timed out";
          const error = `Dictation failed because the broker reported: ${event.reason}. The original input has been released.`;
          if (timedOut && target) reportError(event.session, error);
          if (target && !target.isDestroyed())
            target.send(
              eventChannel,
              timedOut
                ? { kind: "timeout", session: event.session, error }
                : { kind: "cancelled", session: event.session },
            );
          targets.delete(event.session);
        }
      }
    } catch {
      // The broker is optional and may start after the desktop app.
    } finally {
      client?.close();
      client = null;
      lease = null;
      for (const [session, target] of targets)
        if (!target.isDestroyed()) target.send(eventChannel, { kind: "cancelled", session });
      targets.clear();
    }
  };
  return {
    run,
    stop: () => {
      stopped = true;
      lastWindow = null;
      client?.close();
      app.off("browser-window-focus", activate);
      app.off("browser-window-blur", deactivate);
      ipcMain.removeHandler(responseChannel);
      ipcMain.removeHandler(acknowledgementChannel);
      ipcMain.off("dictation:listen", listen);
      ipcMain.off("dictation:unlisten", unlisten);
      targets.clear();
      for (const id of listeners.keys()) removeListener(id);
    },
  };
}

export const start = Effect.fn("DesktopDictation.start")(function* () {
  const paths = yield* (yield* DesktopAssets.DesktopAssets).iconPaths;
  const icon = yield* Effect.sync(() => {
    const path = Option.getOrNull(paths.png);
    return path
      ? nativeImage.createFromPath(path).resize({ width: 64, height: 64 }).toDataURL()
      : null;
  });
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const resource = yield* Effect.acquireRelease(
    Effect.sync(() =>
      connectDictation(icon, (session, error) => {
        runFork(logError(error, { session }));
      }),
    ),
    (resource) => Effect.sync(resource.stop),
  );
  yield* Effect.promise(resource.run).pipe(
    Effect.repeat(Schedule.spaced("2 seconds")),
    Effect.forkScoped,
  );
});
