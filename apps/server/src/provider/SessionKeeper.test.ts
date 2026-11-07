// @effect-diagnostics nodeBuiltinImport:off -- The fixture probes a private socket and temporary session records.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProviderSessionId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as ServerConfig from "../config.ts";
import * as SessionKeeper from "./SessionKeeper.ts";

it.live("reattaches every conversation in a shared process before releasing its output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const config = yield* ServerConfig.ServerConfig;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kept-" });
      const socket =
        platform === "win32"
          ? `\\\\.\\pipe\\t3-kept-${NodeCrypto.randomUUID()}`
          : path.join(root, "s");
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = NodeNet.createServer((client) =>
            client.once("data", () => client.end("alive")),
          );
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socket, resolve);
          });
          return server;
        }),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const consumers = ["first", "second"].map((name) => ({
        threadId: ThreadId.make(`app-${name}`),
        providerThreadId: ProviderThreadId.make(`provider-${name}`),
        nativeTurnIds: [`native-${name}`],
      }));
      const sessionId = ProviderSessionId.make("shared-codex");
      const records = path.join(config.stateDir, "kept-sessions");
      yield* fs.makeDirectory(records, { recursive: true });
      yield* fs.writeFileString(
        path.join(records, "shared.json"),
        JSON.stringify({
          providerSessionId: sessionId,
          driver: "codex",
          ...consumers[1],
          nativeTurnIds: consumers.flatMap((consumer) => consumer.nativeTurnIds),
          consumers,
          socket,
          unit: null,
          pending: [],
          continueRun: true,
        }),
      );
      yield* Effect.gen(function* () {
        const keeper = yield* SessionKeeper.SessionKeeper;
        const continuations = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        yield* keeper.resumeKept;
        assert.equal((yield* continuations.take).threadId, consumers[0]!.threadId);
        assert.equal((yield* continuations.take).threadId, consumers[1]!.threadId);
        const loaded = keeper.takeReattach(sessionId)!;
        const released = yield* Deferred.make<void>();
        const waiting = keeper.holdReattached(sessionId, loaded.nativeTurnIds, loaded.consumers);
        const releaseWait = yield* Effect.promise(() => waiting).pipe(
          Effect.andThen(Deferred.succeed(released, undefined)),
          Effect.forkScoped,
        );
        const second = keeper.reattachedTurns(sessionId, consumers[1]!.providerThreadId)!;
        assert.deepEqual(second.nativeTurnIds, ["native-second"]);
        assert.isUndefined(keeper.reattachedTurns(sessionId, consumers[1]!.providerThreadId));
        assert.isUndefined(keeper.reattachedTurns(sessionId, ProviderThreadId.make("unrelated")));
        yield* second.release;
        assert.isTrue(Option.isNone(yield* Deferred.poll(released)));
        const first = keeper.reattachedTurns(sessionId, consumers[0]!.providerThreadId)!;
        assert.deepEqual(first.nativeTurnIds, ["native-first"]);
        yield* first.release;
        yield* Fiber.join(releaseWait);
      }).pipe(
        Effect.provide(Layer.merge(SessionKeeper.layer, ProviderContinuationRequests.layer)),
        Effect.provideService(HostProcess.Environment, {
          T3CODE_KEEP_SESSIONS: "1",
          T3CODE_SESSION_KEEPER_PATH: "/unused",
          XDG_RUNTIME_DIR: root,
        }),
      );
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-kept-config-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
