// @effect-diagnostics nodeBuiltinImport:off - Isolated authenticated IPC fixtures use private temporary directories.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as ProviderContinuationDispatcher from "../orchestration-v2/ProviderContinuationDispatcher.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderContinuationHost from "./ProviderContinuationHost.ts";
import * as ProviderContinuationRpc from "./ProviderContinuationRpc.ts";
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";

const threadId = ThreadId.make("handover-continuation-thread");
const providerThreadId = ProviderThreadId.make("handover-provider-thread");
const request: ProviderContinuationRequests.ProviderContinuationRequest = {
  threadId,
  providerThreadId,
  driver: ProviderDriverKind.make("fixture"),
  detail: null,
};
const temporaryDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-continuation-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);
const configFor = (platform: string, directory: string, suffix: string) => ({
  endpoint:
    platform === "win32"
      ? `\\\\.\\pipe\\t3-continuation-${NodeCrypto.randomUUID()}`
      : NodePath.join(directory, suffix),
  token: NodeCrypto.randomUUID(),
});
const disconnectableProxy = (endpoint: string, upstream: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const sockets = new Set<NodeNet.Socket>();
      const track = (socket: NodeNet.Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        return socket;
      };
      const server = NodeNet.createServer((incoming) => {
        const outgoing = track(NodeNet.connect(upstream));
        track(incoming).pipe(outgoing);
        outgoing.pipe(incoming);
        incoming.once("close", () => outgoing.destroy());
        outgoing.once("close", () => incoming.destroy());
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return {
        server,
        disconnect: () => {
          for (const socket of sockets) socket.destroy();
        },
      };
    }),
    (proxy) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            proxy.disconnect();
            proxy.server.close(() => resolve());
          }),
      ),
  );
const fakeProjection = (archived = false) =>
  ({
    thread: { archivedAt: archived ? "2026-01-01T00:00:00Z" : null, deletedAt: null },
    messages: [],
  }) as unknown as OrchestrationV2ThreadProjection;

it.live(
  "keeps the original guard and command identity when the core connection disappears after dispatch",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const directory = yield* temporaryDirectory;
      const host = yield* ProviderContinuationHost.ProviderContinuationHost;
      const committed = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const commands: CommandId[] = [];
      const receipts = new Set<CommandId>();
      let effects = 0;
      let blockReply = true;
      let guardCompleted = false;
      const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () => Effect.succeed(fakeProjection()),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command.commandId);
            if (!receipts.has(command.commandId)) {
              receipts.add(command.commandId);
              effects++;
            }
            if (blockReply) {
              yield* Deferred.succeed(committed, undefined);
              return yield* Effect.never;
            }
            return {} as never;
          }),
      });
      const dispatcher = ProviderContinuationDispatcher.layer.pipe(
        Layer.provide(layerThreads),
        Layer.provide(IdAllocator.layer),
      );
      const oldConfig = configFor(platform, directory, "old");
      const oldScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(oldScope, Exit.void));
      yield* Layer.buildWithScope(
        ProviderContinuationRpc.layerServer.pipe(
          Layer.provide(dispatcher),
          Layer.provide(Layer.succeed(ProviderPrivateTransport.HostTransportConfig, oldConfig)),
        ),
        oldScope,
      );
      const proxyConfig = {
        ...oldConfig,
        endpoint: configFor(platform, directory, "proxy").endpoint,
      };
      const proxy = yield* disconnectableProxy(proxyConfig.endpoint, oldConfig.endpoint);
      const pending = yield* host
        .dispatch({
          ...request,
          dispatchIfCurrent: (effect) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              const value = yield* effect;
              guardCompleted = true;
              return Option.some(value);
            }),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.equal(commands.length, 0);
      yield* host.route(proxyConfig);
      yield* Deferred.await(committed);
      const busy = yield* host.route(proxyConfig).pipe(Effect.result);
      assert.equal(busy._tag, "Failure");
      if (busy._tag === "Failure") assert.equal(busy.failure.operation, "busy");
      yield* host.pause;
      const draining = yield* host.awaitDrained.pipe(Effect.forkChild);
      assert.isUndefined(draining.pollUnsafe());
      yield* Effect.sync(proxy.disconnect);
      yield* Fiber.join(draining);
      yield* Scope.close(oldScope, Exit.void);
      assert.isFalse(guardCompleted);
      blockReply = false;
      const nextConfig = configFor(platform, directory, "new");
      yield* Layer.build(
        ProviderContinuationRpc.layerServer.pipe(
          Layer.provide(dispatcher),
          Layer.provide(Layer.succeed(ProviderPrivateTransport.HostTransportConfig, nextConfig)),
        ),
      );
      yield* host.route(nextConfig);
      yield* Fiber.join(pending);
      assert.isTrue(guardCompleted);
      assert.equal(commands.length, 2);
      assert.equal(commands[0], commands[1]);
      assert.equal(effects, 1);
    }).pipe(
      Effect.provide(ProviderContinuationHost.layer.pipe(Layer.provide(PlatformCrypto.layer))),
    ),
);

it.live(
  "drops stale wakes, clears archived wakes after releasing the guard and rejects a wrong token",
  () =>
    Effect.gen(function* () {
      const platform = yield* HostProcess.Platform;
      const directory = yield* temporaryDirectory;
      const host = yield* ProviderContinuationHost.ProviderContinuationHost;
      let reads = 0;
      let guardHeld = false;
      let cleared = 0;
      const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.sync(() => {
            reads++;
            return fakeProjection(true);
          }),
        dispatch: () => Effect.die("An archived thread must not execute a continuation"),
      });
      const config = configFor(platform, directory, "core");
      yield* Layer.build(
        ProviderContinuationRpc.layerServer.pipe(
          Layer.provide(ProviderContinuationDispatcher.layer),
          Layer.provide(layerThreads),
          Layer.provide(IdAllocator.layer),
          Layer.provide(Layer.succeed(ProviderPrivateTransport.HostTransportConfig, config)),
        ),
      );
      yield* host.route(config);
      yield* host.dispatch({ ...request, dispatchIfCurrent: () => Effect.succeedNone });
      assert.equal(reads, 0);
      yield* host.dispatch({
        ...request,
        dispatchIfCurrent: (effect) =>
          Effect.gen(function* () {
            guardHeld = true;
            const value = yield* effect;
            guardHeld = false;
            return Option.some(value);
          }),
        clearIfCurrent: () =>
          Effect.sync(() => {
            assert.isFalse(guardHeld);
            cleared++;
          }),
      });
      assert.equal(reads, 1);
      assert.equal(cleared, 1);
      yield* host.pause;
      yield* host.awaitDrained;
      yield* host.route({ ...config, token: NodeCrypto.randomUUID() });
      const rejected = yield* host.dispatch(request).pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      assert.equal(reads, 1);
    }).pipe(
      Effect.provide(ProviderContinuationHost.layer.pipe(Layer.provide(PlatformCrypto.layer))),
    ),
);
