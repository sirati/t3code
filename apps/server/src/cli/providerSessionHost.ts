import * as ProviderPrivateTransport from "../provider/ProviderPrivateTransport.ts";
import * as Effect from "effect/Effect";
import { Command, Flag, GlobalFlag } from "effect/cli";
import * as ServerConfig from "../config.ts";
import * as ProviderSessionHostProcess from "../provider/ProviderSessionHostProcess.ts";
import * as ProviderHostDescriptor from "../provider/ProviderHostDescriptor.ts";
import { resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const providerSessionHostCommand = Command.make("__provider-host", {
  ...sharedServerCommandFlags,
  descriptorFile: Flag.String("descriptor-file"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("cli.providerSessionHost")(function* (flags) {
      const transport = yield* ProviderHostDescriptor.read(flags.descriptorFile);
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      });
      return yield* ProviderSessionHostProcess.run.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(ProviderPrivateTransport.HostTransportConfig, transport),
      );
    }),
  ),
);
