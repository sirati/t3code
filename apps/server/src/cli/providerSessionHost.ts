import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as ServerConfig from "../config.ts";
import * as ProviderSessionHostProcess from "../provider/ProviderSessionHostProcess.ts";
import * as ProviderSessionTransport from "../provider/ProviderSessionTransport.ts";
import { resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

class HostDescriptorError extends Schema.TaggedError<HostDescriptorError>()(
  "HostDescriptorError",
  {},
) {
  override get message() {
    return "The provider host requires a private descriptor owned by the current user.";
  }
}

const descriptor = Schema.fromJsonString(
  Schema.Struct({
    endpoint: Schema.String.check(Schema.isMinLength(1)),
    token: Schema.String.check(Schema.isMinLength(32)),
  }),
);

export const providerSessionHostCommand = Command.make("__provider-host", {
  ...sharedServerCommandFlags,
  descriptorFile: Flag.String("descriptor-file"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("cli.providerSessionHost")(function* (flags) {
      const fs = yield* FileSystem.FileSystem;
      const uid = yield* HostProcess.UserId;
      const platform = yield* HostProcess.Platform;
      const stat = yield* fs.stat(flags.descriptorFile);
      if (
        stat.type !== "File" ||
        (platform !== "win32" &&
          (uid === undefined ||
            Option.getOrUndefined(stat.uid) !== uid ||
            (stat.mode & 0o077) !== 0))
      )
        return yield* new HostDescriptorError();
      const transport = yield* fs
        .readFileString(flags.descriptorFile)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(descriptor)));
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      });
      return yield* ProviderSessionHostProcess.run.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(ProviderSessionTransport.HostTransportConfig, transport),
      );
    }),
  ),
);
