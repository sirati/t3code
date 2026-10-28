// @effect-diagnostics nodeBuiltinImport:off - Real IPC fixture with a private temporary socket directory.
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";
import * as ProviderContinuationHost from "./ProviderContinuationHost.ts";
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  ProviderDriverKind,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
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
import type { McpCredentialSnapshot } from "../mcp/McpCredentialSnapshot.ts";
import * as ProviderMcpIngress from "./ProviderMcpIngress.ts";
import * as ProviderSessionJournal from "./ProviderSessionJournal.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";
import * as ProviderSessionRemoteRuntime from "./ProviderSessionRemoteRuntime.ts";
import * as HostedProviderSessionBackend from "./HostedProviderSessionBackend.ts";
import * as ProviderSessionBackend from "./ProviderSessionBackend.ts";

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
      const modelStarted = yield* Deferred.make<void>();
      const modelFinish = yield* Deferred.make<void>();
      let modelCalls = 0;
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
        const modelOperation = {
          kind: "start" as const,
          consumer: {
            threadId: input.threadId,
            runId: RunId.make("admitted-model"),
            attemptId: RunAttemptId.make("admitted-attempt"),
          },
        };
        const oldModelCaller = yield* host
          .withTurn(sessionId, first.lease, modelOperation, () =>
            Effect.gen(function* () {
              modelCalls += 1;
              yield* Deferred.succeed(modelStarted, undefined);
              yield* Deferred.await(modelFinish);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(modelStarted);
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
        assert.deepEqual((yield* host.list)[0]!.lastTerminals, [event]);
        yield* host.detach(sessionId, first.lease);
        yield* Fiber.interrupt(oldModelCaller);
        assert.equal((yield* host.list)[0]!.turnOperations[0]!.state, "pending");
        const nextTurn = {
          ...event,
          providerTurnId: ProviderTurnId.make("next-native-turn"),
          runOrdinal: 2,
        };
        yield* emit(nextTurn);
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
        assert.deepEqual(replayed.event, nextTurn);
        assert.deepEqual((yield* host.list)[0]!.lastTerminals, [event, nextTurn]);
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
            Layer.provide(ProviderMcpIngress.layer),
            Layer.provide(ProviderContinuationHost.layer.pipe(Layer.provide(PlatformCrypto.layer))),
            Layer.provide(Layer.succeed(ProviderPrivateTransport.HostTransportConfig, config)),
          ),
        );
        const clientLayer = ProviderSessionTransport.layerClient.pipe(
          Layer.provide(Layer.succeed(ProviderPrivateTransport.HostTransportConfig, config)),
        );
        const credentials: ReadonlyArray<McpCredentialSnapshot> = [
          {
            tokenHash: "a".repeat(64),
            environmentId: EnvironmentId.make("fixture"),
            requestNamespace: "mcp-fixture",
            thread: {
              threadId: input.threadId,
              providerSessionId: "mcp-fixture",
              providerInstanceId: instanceId,
              subagent: true,
            },
            capabilities: ["orchestration"],
            issuedAt: 1000,
            lastAliveAt: 1010,
          },
        ];
        const runConsumer = {
          threadId: input.threadId,
          runId: RunId.make("retained-run"),
          attemptId: RunAttemptId.make("retained-attempt"),
        };
        const firstConnection = yield* Effect.gen(function* () {
          const client = yield* ProviderSessionTransport.ProviderSessionClient;
          yield* client["mcp.checkpoint"]({ credentials });
          const ingressStatus = yield* client["mcp.status"]({});
          assert.isTrue(ingressStatus.state.paused);
          yield* client["mcp.route"]({ endpoint: "http://127.0.0.1:1/mcp" });
          assert.isFalse((yield* client["mcp.status"]({})).state.paused);
          yield* client["mcp.pause"]({});
          yield* client["mcp.drain"]({});
          const entries = yield* client["session.list"]({});
          assert.deepEqual(entries[0]!.providerSession.createdAt, now);
          const attached = yield* client["session.attach"]({ sessionId, lease: second.lease });
          const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
          const mcpConfig = {
            environmentId: EnvironmentId.make("fixture"),
            threadId: input.threadId,
            providerSessionId: sessionId,
            providerInstanceId: instanceId,
            endpoint: "http://127.0.0.1:1/mcp",
            authorizationHeader: "Bearer retained-native-token",
            browserToolsAvailable: true,
            capabilities: new Set(["orchestration"]),
          };
          yield* mcpSessions.set(mcpConfig);
          const remote = yield* ProviderSessionRemoteRuntime.connect(attached);
          yield* remote.runtime.eventDelivery!.retainRunConsumer!(runConsumer);
          yield* remote.runtime.eventDelivery!.retainRunConsumer!(runConsumer);
          assert.deepEqual((yield* client["session.list"]({}))[0]!.runConsumers, [runConsumer]);
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
          const hostMcp = yield* client["mcp.configurations"]({});
          assert.deepEqual(hostMcp, [
            {
              ...mcpConfig,
              endpoint: ingressStatus.endpoint,
              capabilities: ["orchestration"],
            },
          ]);
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
          const pending = Option.getOrThrow(yield* remote.envelopes.pipe(Stream.runHead));
          assert.deepEqual(pending.event, nextTurn);
          assert.deepEqual(remote.runtime.eventDelivery!.receiptFor(pending.event), {
            incarnation: attached.incarnation,
            sequence: pending.sequence,
          });
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
        }).pipe(Effect.provide(Layer.merge(clientLayer, McpProviderSessions.layer)));
        assert.equal(closed, 0);
        yield* emit(event);
        yield* Effect.gen(function* () {
          const client = yield* ProviderSessionTransport.ProviderSessionClient;
          assert.deepEqual(yield* client["mcp.credentials"]({}), credentials);
          assert.deepEqual((yield* client["session.list"]({}))[0]!.lastTerminals, [
            event,
            nextTurn,
          ]);
          const current = (yield* client["session.list"]({}))[0]!;
          assert.deepEqual(current.runConsumers, [runConsumer]);
          const attached = yield* client["session.attach"]({ sessionId, lease: current.lease });
          assert.equal(attached.acknowledgedThrough, received.sequence);
          const remote = yield* ProviderSessionRemoteRuntime.connect(attached, {
            startPaused: true,
          });
          assert.equal(attached.turnOperations[0]!.state, "pending");
          const accepted = yield* client["session.awaitTurn"]({
            sessionId,
            lease: attached.lease,
            operation: modelOperation,
          }).pipe(Effect.forkChild);
          yield* Deferred.succeed(modelFinish, undefined);
          yield* Fiber.join(accepted);
          yield* host.withTurn(sessionId, attached.lease, modelOperation, () =>
            Effect.die("must not execute an admitted model twice"),
          );
          assert.equal(modelCalls, 1);
          assert.equal(
            (yield* client["session.list"]({}))[0]!.turnOperations[0]!.state,
            "succeeded",
          );
          const failedOperation = {
            ...modelOperation,
            consumer: {
              ...modelOperation.consumer,
              attemptId: RunAttemptId.make("failed-admission"),
            },
          };
          const startFailure = new ProviderAdapter.ProviderAdapterProtocolError({
            driver,
            detail: "fixture startup refused",
          });
          assert.equal(
            (yield* host
              .withTurn(sessionId, attached.lease, failedOperation, () => Effect.fail(startFailure))
              .pipe(Effect.result))._tag,
            "Failure",
          );
          const retainedFailure = yield* client["session.awaitTurn"]({
            sessionId,
            lease: attached.lease,
            operation: failedOperation,
          }).pipe(Effect.result);
          assert.equal(retainedFailure._tag, "Failure");
          if (retainedFailure._tag === "Failure")
            assert.deepEqual(retainedFailure.failure, startFailure);
          assert.equal(
            (yield* host
              .withTurn(sessionId, attached.lease, failedOperation, () =>
                Effect.die("must not retry a failed admission"),
              )
              .pipe(Effect.result))._tag,
            "Failure",
          );
          const failedSnapshot = (yield* client["session.list"]({}))[0]!.turnOperations.find(
            (operation) => operation.consumer.attemptId === failedOperation.consumer.attemptId,
          );
          assert.equal(failedSnapshot?.state, "failed");
          yield* host.setRunConsumer(sessionId, attached.lease, modelOperation.consumer, false);
          yield* host.setRunConsumer(sessionId, attached.lease, failedOperation.consumer, false);
          assert.isEmpty((yield* host.list)[0]!.turnOperations);
          const finishing = {
            ...modelOperation,
            consumer: {
              ...modelOperation.consumer,
              attemptId: RunAttemptId.make("finishing-admission"),
            },
          };
          const finishingStarted = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const finishingCaller = yield* host
            .withTurn(sessionId, attached.lease, finishing, () =>
              Deferred.succeed(finishingStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(finishingStarted);
          yield* host.setRunConsumer(sessionId, attached.lease, finishing.consumer, false);
          assert.equal((yield* host.list)[0]!.turnOperations[0]!.state, "pending");
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(finishingCaller);
          assert.isEmpty((yield* host.list)[0]!.turnOperations);

          const caughtUp = yield* Deferred.make<void>();
          yield* remote.runtime.eventDelivery!.awaitCaughtUp!.pipe(
            Effect.andThen(Deferred.succeed(caughtUp, undefined)),
            Effect.forkChild,
          );
          assert.isFalse(yield* Deferred.isDone(caughtUp));
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
          assert.equal(
            (yield* remote.acknowledge(attached.journalHead + 100).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.isFalse(yield* Deferred.isDone(caughtUp));
          yield* remote.acknowledge(received.sequence + 2);
          yield* Deferred.await(caughtUp);
          assert.equal(
            (yield* client["session.list"]({}))[0]!.acknowledgedThrough,
            received.sequence + 2,
          );
          const rejected = yield* client["session.close"]({
            sessionId,
            lease: firstConnection.lease,
          }).pipe(Effect.result);
          assert.equal(rejected._tag, "Failure");
          assert.equal(
            (yield* client["session.runConsumer"]({
              sessionId,
              lease: firstConnection.lease,
              consumer: runConsumer,
              retained: false,
            }).pipe(Effect.result))._tag,
            "Failure",
          );
          assert.deepEqual((yield* client["session.list"]({}))[0]!.runConsumers, [runConsumer]);
          const otherConsumer = { ...runConsumer, runId: RunId.make("other-live-run") };
          yield* remote.runtime.eventDelivery!.retainRunConsumer!(otherConsumer);
          yield* remote.runtime.eventDelivery!.releaseRunConsumer!({
            ...runConsumer,
            providerTurnId: event.providerTurnId,
          });
          assert.deepEqual((yield* client["session.list"]({}))[0]!.runConsumers, [otherConsumer]);
          assert.deepEqual((yield* client["session.list"]({}))[0]!.lastTerminals, [nextTurn]);
          yield* remote.runtime.eventDelivery!.releaseRunConsumer!(otherConsumer);
          assert.deepEqual((yield* client["session.list"]({}))[0]!.runConsumers, []);
          assert.isEmpty((yield* client["session.list"]({}))[0]!.lastTerminals);
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
                Layer.succeed(ProviderPrivateTransport.HostTransportConfig, {
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
        yield* host.detach(sessionId, reattached.lease);
        const backendLayer = HostedProviderSessionBackend.layer.pipe(
          Layer.provide(clientLayer),
          Layer.provide(McpProviderSessions.layer),
        );
        const beforeDetach = (yield* host.list)[0]!;
        yield* Effect.gen(function* () {
          const backend = yield* ProviderSessionBackend.ProviderSessionBackend;
          const retained = yield* backend.open!({ driver, instanceId, input });
          assert.isTrue(backend.retains(retained));
          assert.equal(opened, 3);
          assert.equal(closed, 2);
          assert.equal(retained.providerSessionId, sessionId);
        }).pipe(Effect.provide(backendLayer), Effect.scoped);
        assert.equal(closed, 2);
        const afterDetach = (yield* host.list)[0]!;
        assert.equal(afterDetach.incarnation, beforeDetach.incarnation);
        assert.notEqual(afterDetach.lease, beforeDetach.lease);
        yield* Effect.gen(function* () {
          const backend = yield* ProviderSessionBackend.ProviderSessionBackend;
          const retained = yield* backend.open!({ driver, instanceId, input });
          yield* backend.terminate(retained);
          yield* backend.terminate(retained);
          assert.equal(closed, 3);
        }).pipe(Effect.provide(backendLayer), Effect.scoped);
        assert.lengthOf(yield* host.list, 0);
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
