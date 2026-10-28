import * as Effect from "effect/Effect";
import {
  BACKEND_DAEMON_PROTOCOL,
  type BackendDaemonRole,
  type BackendDaemonReadyMessage,
} from "../backendDaemonProtocol.ts";

export const reportReady = Effect.fn("cli.backendDaemon.reportReady")((role: BackendDaemonRole) =>
  Effect.callback<void>((resume) => {
    if (!process.connected || process.send === undefined) {
      resume(Effect.void);
      return;
    }
    const message: BackendDaemonReadyMessage = {
      type: "t3-daemon-ready",
      protocol: BACKEND_DAEMON_PROTOCOL,
      role,
    };
    process.send(message, (error) => resume(error === null ? Effect.void : Effect.die(error)));
  }),
);

export const stopRequested = Effect.callback<void>((resume) => {
  if (!process.connected) return;
  const stop = () => resume(Effect.void);
  const onMessage = (message: unknown) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "t3-daemon-stop"
    )
      stop();
  };
  process.on("message", onMessage);
  process.once("disconnect", stop);
  return Effect.sync(() => {
    process.off("message", onMessage);
    process.off("disconnect", stop);
  });
});
