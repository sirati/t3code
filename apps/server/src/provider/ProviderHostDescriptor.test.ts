import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ProviderHostDescriptor from "./ProviderHostDescriptor.ts";

it.effect.each(["private", "public", "foreign", "short-token", "malformed"] as const)(
  "accepts only an owned private provider host descriptor: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const filename = path.join(directory, "descriptor.json");
        const config = {
          endpoint: "fixture-host",
          token: scenario === "short-token" ? "short" : "a".repeat(32),
        };
        yield* fs.writeFileString(
          filename,
          scenario === "malformed" ? "{" : JSON.stringify(config),
        );
        const stat = yield* fs.stat(filename);
        const result = yield* ProviderHostDescriptor.read(filename).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: () =>
              Effect.succeed({
                ...stat,
                uid: Option.some(scenario === "foreign" ? 1001 : 1000),
                mode: scenario === "public" ? 0o644 : 0o600,
              }),
          }),
          Effect.provideService(HostProcess.UserId, 1000),
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.result,
        );
        assert.equal(result._tag, scenario === "private" ? "Success" : "Failure");
        if (result._tag === "Success") assert.deepEqual(result.success, config);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
