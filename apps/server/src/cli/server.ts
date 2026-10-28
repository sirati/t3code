import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import * as ServerConfig from "../config.ts";
import * as ProviderHostDescriptor from "../provider/ProviderHostDescriptor.ts";
import * as ProviderPrivateTransport from "../provider/ProviderPrivateTransport.ts";
import { CleanupLeftoverAgents } from "../process/agentScope.ts";
import { BackendDaemonReady } from "../backendDaemonReady.ts";
import { reportReady, stopRequested } from "./backendDaemonReady.ts";
import { awaitLauncherLoss } from "../launcherWatch.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

// The desktop launcher reads this process's stdout and stderr. Once it is gone,
// every log write fails, and Node turns an unhandled stream error into a crash
// that skips shutdown and leaves the ownership lock and runtime record behind.
function ignoreClosedLauncherPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
}

const runServerCommand = Effect.fn("server.runServerCommand")(function* (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
    readonly providerHostDescriptorFile?: string;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveServerConfig(flags, logLevel, options);
  let run = runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  if (options?.providerHostDescriptorFile !== undefined) {
    if (config.mode === "desktop")
      return yield* new CliError.UserError({
        cause: "desktop",
        userMessage: "Provider handover is available only for the headless backend daemon.",
      });
    const transport = yield* ProviderHostDescriptor.read(options.providerHostDescriptorFile);
    run = run.pipe(
      Effect.provideService(ProviderPrivateTransport.HostTransportConfig, transport),
      Effect.provideService(CleanupLeftoverAgents, false),
      Effect.provideService(BackendDaemonReady, reportReady("backend")),
      Effect.raceFirst(stopRequested.pipe(Effect.andThen(Effect.interrupt))),
    );
  }
  if (config.mode !== "desktop" || config.desktopBootstrapToken === undefined) return yield* run;
  yield* Effect.sync(() => {
    process.stdout.on("error", ignoreClosedLauncherPipe);
    process.stderr.on("error", ignoreClosedLauncherPipe);
  });
  return yield* Effect.raceFirst(
    run,
    awaitLauncherLoss().pipe(
      // End like SIGTERM does (interrupt-only exit, so the runtime forces process exit).
      Effect.andThen(Effect.interrupt),
    ),
  );
});

export const runDefaultServerCommand = Effect.fn("server.runDefaultServerCommand")(function* (
  flags: CliServerFlags,
) {
  if (Option.isSome(flags.cwd)) {
    const cwd = flags.cwd.value.trim();
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const explicitPath =
      cwd === "." ||
      cwd === ".." ||
      cwd === "~" ||
      /[/\\]/.test(cwd) ||
      (platform === "win32" && /^[a-z]:/i.test(cwd));
    if (!explicitPath && (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")) {
      return yield* new CliError.UserError({
        cause: cwd,
        userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "t3 --help" for commands or an explicit path such as "t3 ./my-project" for a new directory.`,
      });
    }
  }
  return yield* runServerCommand(flags, { rejectRunningServer: true });
});

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

export const serveCommand = Command.make("serve", {
  ...sharedServerCommandFlags,
  providerHostDescriptorFile: Flag.String("provider-host-descriptor-file").pipe(Flag.optional),
}).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
      ...(Option.isSome(flags.providerHostDescriptorFile)
        ? { providerHostDescriptorFile: flags.providerHostDescriptorFile.value }
        : {}),
    }),
  ),
);
