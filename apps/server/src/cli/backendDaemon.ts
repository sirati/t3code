import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { CONTROL_FILE, requestBackendDaemon } from "../backendDaemonControl.ts";
import { BackendDaemonSupervisor, type DaemonCommand } from "../backendDaemonSupervisor.ts";
import * as ProviderHostDescriptor from "../provider/ProviderHostDescriptor.ts";
import { resolveEntryPath } from "./invocation.ts";
import { resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

class BackendDaemonError extends Schema.TaggedError<BackendDaemonError>()("BackendDaemonError", {
  operation: Schema.Literals(["run", "reload", "status"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `The backend daemon could not ${this.operation}.`;
  }
}

const encodeStatus = Schema.encodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      state: Schema.String,
      hostPid: Schema.optionalKey(Schema.Number),
      backendPid: Schema.optionalKey(Schema.Number),
    }),
  ),
);

const run = Command.make("run", {
  ...sharedServerCommandFlags,
  backendCommand: Flag.String("backend-command").pipe(
    Flag.withDescription(
      "Executable path to resolve again on reload, such as a Nix profile's t3 executable.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Run a headless backend under a supervisor that retains active provider processes during reload.",
  ),
  Command.withHandler(
    Effect.fn("cli.backendDaemon.run")(function* (flags) {
      const config = yield* resolveServerConfig(flags, yield* GlobalFlag.LogLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
        rejectRunningServer: true,
      });
      if (config.mode === "desktop")
        return yield* new CliError.UserError({
          cause: "desktop",
          userMessage: "The daemon supervisor runs only the headless backend. Use web mode.",
        });
      const entry = yield* resolveEntryPath;
      const executable = yield* HostProcess.ExecutablePath;
      const native = yield* HostProcess.IsExecutable;
      const platform = yield* HostProcess.Platform;
      const environment = yield* HostProcess.Environment;
      const explicitCommand = Option.getOrUndefined(flags.backendCommand);
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const prefix: DaemonCommand =
        explicitCommand !== undefined || native
          ? { command: path.resolve(explicitCommand ?? entry), args: [] }
          : { command: executable, args: [yield* fs.realPath(entry)] };
      const common = [
        "--base-dir",
        config.baseDir,
        "--mode",
        "web",
        "--host",
        config.host ?? "127.0.0.1",
        "--port",
        String(config.port),
        "--log-level",
        config.logLevel.toLowerCase(),
        ...(config.devUrl === undefined ? [] : ["--dev-url", config.devUrl.href]),
      ];
      const command = async (
        role: "host" | "backend",
        descriptor: string,
      ): Promise<DaemonCommand> => {
        return {
          command: prefix.command,
          args: [
            ...prefix.args,
            role === "host" ? "__provider-host" : "serve",
            ...common,
            role === "host" ? "--descriptor-file" : "--provider-host-descriptor-file",
            descriptor,
            ...(role === "backend" && config.tailscaleServeEnabled
              ? ["--tailscale-serve", "--tailscale-serve-port", String(config.tailscaleServePort)]
              : []),
          ],
        };
      };
      const report = (cause: unknown) =>
        process.stderr.write(
          `[backend-daemon] ${cause instanceof Error ? cause.message : "Reload failed."}\n`,
        );
      const supervisor = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new BackendDaemonSupervisor({
              platform,
              stateDirectory: config.stateDir,
              workingDirectory: config.cwd,
              environment: {
                ...environment,
                T3CODE_LOG_WS_EVENTS: String(config.logWebSocketEvents),
              },
              hostCommand: (descriptor) => command("host", descriptor),
              backendCommand: (descriptor) => command("backend", descriptor),
              onError: report,
            }),
        ),
        (instance) => Effect.promise(() => instance.stop()),
      );
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const reload = () => {
            void supervisor.reload().catch(report);
          };
          process.on("SIGHUP", reload);
          return reload;
        }),
        (reload) =>
          Effect.sync(() => {
            process.off("SIGHUP", reload);
          }),
      );
      yield* Effect.tryPromise({
        try: () => supervisor.start(),
        catch: (cause) => new BackendDaemonError({ operation: "run", cause }),
      });
      const cause = yield* Effect.promise(() => supervisor.failure);
      return yield* new BackendDaemonError({ operation: "run", cause });
    }),
  ),
);

const controlCommand = (operation: "reload" | "status") =>
  Command.make(operation, { ...sharedServerCommandFlags }).pipe(
    Command.withDescription(
      operation === "reload"
        ? "Replace only the daemon backend and wait for command readiness."
        : "Print the backend supervisor and provider-host process state.",
    ),
    Command.withHandler(
      Effect.fn(`cli.backendDaemon.${operation}`)(function* (flags) {
        const config = yield* resolveServerConfig(flags, yield* GlobalFlag.LogLevel, {
          startupPresentation: "headless",
          forceAutoBootstrapProjectFromCwd: false,
        });
        const path = yield* Path.Path;
        const transport = yield* ProviderHostDescriptor.read(
          path.join(config.stateDir, CONTROL_FILE),
        );
        const status = yield* Effect.tryPromise({
          try: () => requestBackendDaemon(transport, operation),
          catch: (cause) => new BackendDaemonError({ operation, cause }),
        });
        yield* Console.log(yield* encodeStatus(status));
      }),
    ),
  );

export const backendDaemonCommand = Command.make("daemon").pipe(
  Command.withDescription("Run, reload, or inspect the headless backend daemon."),
  Command.withSubcommands([run, controlCommand("reload"), controlCommand("status")]),
);
