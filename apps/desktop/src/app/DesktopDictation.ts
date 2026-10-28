// @effect-diagnostics nodeBuiltinImport:off -- The Node-API SDK runs only in the Electron main process.
import { Client } from "@dictation-api/client";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Option from "effect/Option";
import * as DesktopAssets from "./DesktopAssets.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import { DesktopDictationRoutes } from "./DesktopDictationRoutes.ts";
import { app, BrowserWindow, ipcMain, nativeImage, type WebContents } from "electron";

const eventChannel = "dictation:event";
const responseChannel = "dictation:respond";
const acknowledgementChannel = "dictation:acknowledge";
const moveChannel = "dictation:move";
const { logError } = makeComponentLogger("desktop-dictation");

function connectDictation(
  icon: string | null,
  reportError: (session: string, error: string) => void,
) {
  let stopped = false;
  let client: Client | null = null;
  let lease: number | null = null;
  let lastWindow: BrowserWindow | null = BrowserWindow.getFocusedWindow();
  const listeners = new Map<number, { target: WebContents; destroyed: () => void }>();
  const routes = new DesktopDictationRoutes((id, event) => {
    const target = listeners.get(id)?.target;
    if (target && !target.isDestroyed()) target.send(eventChannel, event);
  }, reportError);
  const removeListener = (id: number) => {
    const listener = listeners.get(id);
    if (!listener) return;
    listeners.delete(id);
    listener.target.off("destroyed", listener.destroyed);
    routes.unlisten(id);
    if (lastWindow?.isDestroyed() || lastWindow?.webContents.id === id) lastWindow = null;
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
    routes.listen(event.sender.id);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window?.isFocused()) activate(null, window);
  };
  const unlisten = (event: Electron.IpcMainEvent) => removeListener(event.sender.id);
  ipcMain.on("dictation:listen", listen);
  ipcMain.on("dictation:unlisten", unlisten);
  ipcMain.handle(responseChannel, async (event, session: unknown, accept: unknown) => {
    if (typeof session !== "string" || typeof accept !== "boolean")
      throw new Error("Invalid dictation offer response");
    const audio = routes.offered(session, event.sender.id);
    try {
      await client?.respond(session, accept, accept ? audio : { level: false, spectrum: false });
      routes.accept(session, event.sender.id, accept);
    } catch (error) {
      routes.end(session);
      throw error;
    }
  });
  ipcMain.handle(moveChannel, (event, session: unknown) => {
    if (typeof session !== "string" || !listeners.has(event.sender.id))
      throw new Error("Invalid dictation destination");
    return routes.move(session, event.sender.id);
  });
  ipcMain.handle(
    acknowledgementChannel,
    async (event, session: unknown, applied: unknown, error: unknown) => {
      if (
        typeof session !== "string" ||
        typeof applied !== "boolean" ||
        !(error === null || typeof error === "string")
      )
        throw new Error("Invalid dictation acknowledgement");
      routes.acknowledge(session, event.sender.id, applied);
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
          routes.offer(event.session, window.webContents.id, event.provider, event.audio);
        } else if (event.kind === "audio") {
          routes.audio(event.session, event.frame);
        } else if (event.kind === "transcript") {
          if (!routes.deliver(event.session, event.transcript.text, event.transcript.submit)) {
            routes.end(event.session);
            await client.acknowledge(
              event.session,
              false,
              "The destination window closed before delivery.",
            );
          }
        } else if (event.kind === "cancelled") {
          const timedOut =
            event.reason === "session timed out" || event.reason === "offer timed out";
          routes.end(
            event.session,
            timedOut
              ? "Dictation failed because the broker reported: " +
                  event.reason +
                  ". The original input has been released."
              : undefined,
          );
        }
      }
    } catch {
      // The broker is optional and may start after the desktop app.
    } finally {
      client?.close();
      client = null;
      lease = null;
      routes.clear();
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
      ipcMain.removeHandler(moveChannel);
      ipcMain.off("dictation:listen", listen);
      ipcMain.off("dictation:unlisten", unlisten);
      routes.clear();
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
