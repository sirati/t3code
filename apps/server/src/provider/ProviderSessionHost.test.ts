// @effect-diagnostics nodeBuiltinImport:off - Real IPC fixture with a private temporary socket directory.
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProviderDriverKind,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderSessionHost from "./ProviderSessionHost.ts";
import * as ProviderSessionJournal from "./ProviderSessionJournal.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";
import * as ProviderSessionRemoteRuntime from "./ProviderSessionRemoteRuntime.ts";

const eventJson = Schema.fromJsonString(Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event));
const encodeEvent = Schema.encodeSync(eventJson);
const decodeEvent = Schema.decodeUnknownEffect(eventJson);

it.live(
  "keeps a provider runtime alive through consumer replacement, replays output and rejects stale leases",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const platform = yield* HostProcess.Platform;
      const executablePath = yield* HostProcess.ExecutablePath;
      let harness: NodeChildProcess.ChildProcessWithoutNullStreams | undefined;
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              harness!.stdin.write(`${encodeEvent(event)}\n`, (error) =>
                error ? reject(error) : resolve(),
              );
            }),
        );
      const probeStarted = yield* Deferred.make<void>();
      const probeFinish = yield* Deferred.make<void>();
      const probeCompleted = yield* Deferred.make<void>();
      const openingStarted = yield* Deferred.make<void>();
      let blockProbe = false;
      let blockOpening = false;
      let opened = 0;
      let closed = 0;
      let unloaded = 0;
      const instanceId = ProviderInstanceId.make("codex");
      const driver = ProviderDriverKind.make("codex");
      const sessionId = ProviderSessionId.make("hosted-session");
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId,
        driver,
        providerSessionId: sessionId,
        providerSession: {
          id: sessionId,
          driver,
          providerInstanceId: instanceId,
          status: "running",
          cwd: "/workspace",
          model: "test",
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.empty,
        hasPendingBackgroundWork: Effect.gen(function* () {
          if (blockProbe) {
            yield* Deferred.succeed(probeStarted, undefined);
            yield* Deferred.await(probeFinish);
            yield* Deferred.succeed(probeCompleted, undefined);
          }
          return false;
        }),
        ensureThread: () => Effect.die("unused"),
        resumeThread: () => Effect.die("unused"),
        startTurn: () => Effect.die("must not restart a model turn"),
        steerTurn: () => Effect.die("unused"),
        interruptTurn: () => Effect.die("must not interrupt a model turn"),
        respondToRuntimeRequest: () => Effect.die("unused"),
        readThreadSnapshot: () => Effect.die("unused"),
        unloadThread: ({ providerThread }) =>
          Effect.sync(() => {
            assert.deepEqual(providerThread.createdAt, now);
            unloaded += 1;
          }),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
      const adapter = ProviderAdapter.ProviderAdapterV2.of({
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.die("unused"),
        openSession: () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              opened += 1;
              const child = NodeChildProcess.spawn(
                executablePath,
                ["-e", "process.stdin.pipe(process.stdout)"],
                { env: {} },
              );
              child.on("error", () => {});
              harness = child;
              return child;
            }),
            (child) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    child.once("close", () => {
                      closed += 1;
                      resolve();
                    });
                    child.kill("SIGTERM");
                  }),
              ),
          ).pipe(
            Effect.map((child) => ({
              ...runtime,
              events: NodeStream.fromReadable({ evaluate: () => child.stdout }).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.mapEffect((line) => decodeEvent(line)),
                Stream.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterEventStreamError({
                      driver,
                      providerSessionId: sessionId,
                      cause,
                    }),
                ),
              ),
            })),
            Effect.tap(() =>
              blockOpening
                ? Deferred.succeed(openingStarted, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const host = yield* ProviderSessionHost.ProviderSessionHost;
        const input = {
          threadId: ThreadId.make("hosted-thread"),
          providerSessionId: sessionId,
          modelSelection: { instanceId, model: "test" },
          runtimePolicy: {
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            cwd: "/workspace",
          },
        };
        const created = yield* host.open(instanceId, input).pipe(Effect.scoped);
        assert.equal(closed, 0);
        const first = yield* host.attach(sessionId, created.lease);
        const event: ProviderAdapter.ProviderAdapterV2Event = {
          type: "turn.terminal",
          driver,
          providerThreadId: ProviderThreadId.make("native-thread"),
          providerTurnId: ProviderTurnId.make("native-turn"),
          runOrdinal: 1,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        };
        const readFirst = yield* host
          .events(sessionId, first.lease, 0)
          .pipe(Stream.runHead, Effect.forkChild);
        yield* emit(event);
        const received = Option.getOrThrow(yield* Fiber.join(readFirst));
        yield* host.acknowledge(sessionId, first.lease, received.sequence);
        yield* host.detach(sessionId, first.lease);
        yield* emit(event);
        const existing = yield* host.open(instanceId, input);
        assert.equal(opened, 1);
        assert.equal(closed, 0);
        const second = yield* host.attach(sessionId, existing.lease);
        assert.equal(
          (yield* host.acknowledge(sessionId, first.lease, 99).pipe(Effect.result))._tag,
          "Failure",
        );
        const replayed = Option.getOrThrow(
          yield* host.events(sessionId, second.lease, 0).pipe(Stream.runHead),
        );
        assert.equal(replayed.sequence, received.sequence + 1);
        assert.deepEqual(replayed.event, event);
        assert.equal(
          (yield* host.close(sessionId, first.lease).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(closed, 0);
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-host-test-"))),
          (directory) =>
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
        const config = {
          endpoint:
            platform === "win32"
              ? `\\\\.\\pipe\\t3-host-test-${NodeCrypto.randomUUID()}`
              : NodePath.join(directory, "s"),
          token: NodeCrypto.randomUUID(),
        };
        yield* Layer.build(
          ProviderSessionTransport.layerServer.pipe(
            Layer.provide(Layer.succeed(ProviderSessionHost.ProviderSessionHost, host)),
            Layer.provide(McpProviderSessions.layer),
            Layer.provide(Layer.succeed(ProviderSessionTransport.HostTransportConfig, config)),
          ),
        );
        const clientLayer = ProviderSessionTransport.layerClient.pipe(
          Layer.provide(Layer.succeed(ProviderSessionTransport.HostTransportConfig, config)),
        );
        const firstConnection = yield* Effect.gen(function* () {
          const client = yield* ProviderSessionTransport.ProviderSessionClient;
          const entries = yield* client["session.list"]({});
          assert.deepEqual(entries[0]!.providerSession.createdAt, now);
          const attached = yield* client["session.attach"]({ sessionId, lease: second.lease });
          const remote = yield* ProviderSessionRemoteRuntime.connect(attached);
          assert.isUndefined(remote.runtime.compactThread);
          yield* remote.runtime.unloadThread!({
            providerThread: OrchestrationV2ProviderThread.make({
              id: ProviderThreadId.make("native-thread"),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: sessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          });
          assert.equal(unloaded, 1);
          assert.deepEqual(
            yield* remote.readContextPolicy({
              previous: null,
              next: input.modelSelection,
              cwd: "/workspace",
            }),
            {
              reusable: false,
              modelWindow: null,
            },
          );
          const pending = Option.getOrThrow(
            yield* client["session.events"]({ sessionId, lease: attached.lease, after: 0 }).pipe(
              Stream.runHead,
            ),
          );
          assert.deepEqual(pending.event, event);
          const policy = yield* client["session.invoke"]({
            sessionId,
            lease: attached.lease,
            method: "hasPendingBackgroundWork",
            argument: {},
          });
          assert.equal(policy, false);
          blockProbe = true;
          yield* remote.runtime.hasPendingBackgroundWork!.pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          yield* remote.detach;
          return attached;
        }).pipe(Effect.provide(clientLayer));
        assert.equal(closed, 0);
        yield* emit(event);
        yield* Effect.gen(function* () {
          const client = yield* ProviderSessionTransport.ProviderSessionClient;
          const current = (yield* client["session.list"]({}))[0]!;
          const attached = yield* client["session.attach"]({ sessionId, lease: current.lease });
          yield* Deferred.succeed(probeFinish, undefined);
          yield* Deferred.await(probeCompleted);
          const buffered = yield* client["session.events"]({
            sessionId,
            lease: attached.lease,
            after: received.sequence,
          }).pipe(Stream.take(2), Stream.runCollect);
          assert.deepEqual(
            buffered.map((entry) => entry.sequence),
            [received.sequence + 1, received.sequence + 2],
          );
          yield* client["session.acknowledge"]({
            sessionId,
            lease: attached.lease,
            through: received.sequence + 2,
          });
          const rejected = yield* client["session.close"]({
            sessionId,
            lease: firstConnection.lease,
          }).pipe(Effect.result);
          assert.equal(rejected._tag, "Failure");
          assert.equal(closed, 0);
          yield* client["session.close"]({ sessionId, lease: attached.lease });
        }).pipe(Effect.provide(clientLayer));
        yield* Effect.gen(function* () {
          const client = yield* ProviderSessionTransport.ProviderSessionClient;
          const rejected = yield* client["session.list"]({}).pipe(Effect.result);
          assert.equal(rejected._tag, "Failure");
          if (rejected._tag === "Failure")
            assert.equal(rejected.failure._tag, "HostAuthorizationError");
        }).pipe(
          Effect.provide(
            ProviderSessionTransport.layerClient.pipe(
              Layer.provide(
                Layer.succeed(ProviderSessionTransport.HostTransportConfig, {
                  ...config,
                  token: NodeCrypto.randomUUID(),
                }),
              ),
            ),
          ),
        );
        assert.equal(closed, 1);
        assert.lengthOf(yield* host.list, 0);
        blockOpening = true;
        const cancelledOpen = yield* host.open(instanceId, input).pipe(Effect.forkChild);
        yield* Deferred.await(openingStarted);
        yield* Fiber.interrupt(cancelledOpen);
        assert.equal(closed, 2);
        assert.lengthOf(yield* host.list, 0);
        blockOpening = false;
        const reopened = yield* host.open(instanceId, input);
        assert.notEqual(reopened.incarnation, created.incarnation);
        const reattached = yield* host.attach(sessionId, reopened.lease);
        assert.equal(
          (yield* host.close(sessionId, first.lease).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(harness!.exitCode, null);
        yield* host.close(sessionId, reattached.lease);
      }).pipe(
        Effect.provide(
          ProviderSessionHost.layer.pipe(
            Layer.provide(PlatformCrypto.layer),
            Layer.provide(
              Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                get: () => Effect.succeed(adapter),
                list: () => Effect.succeed([instanceId]),
              }),
            ),
            Layer.provide(
              ProviderSessionJournal.layer.pipe(
                Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
              ),
            ),
          ),
        ),
      );
      assert.equal(closed, 3);
    }),
);
