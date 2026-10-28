import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProviderSessionAdoption from "./ProviderSessionAdoption.ts";
import type { HostedProviderSession } from "./ProviderSessionHost.ts";
import * as ProviderSessionTransport from "./ProviderSessionTransport.ts";
import * as ProviderPrivateTransport from "./ProviderPrivateTransport.ts";

it.effect.each(["success", "missing-attempt", "consumer-failure"] as const)(
  "restores all consumers before replay and rejects incomplete adoption (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const startup = yield* Deferred.make<void>();
      const order: string[] = [];
      const instanceId = ProviderInstanceId.make("fixture");
      const entries = [0, 1].map((index) => {
        const threadId = ThreadId.make(`thread-${index}`);
        const providerSessionId = ProviderSessionId.make(`session-${index}`);
        const consumer = {
          threadId,
          runId: RunId.make(`run-${index}`),
          attemptId: RunAttemptId.make(`attempt-${index}`),
        };
        return {
          openInput: { threadId, providerSessionId },
          providerSession: { id: providerSessionId },
          runConsumers: [consumer],
          lastTerminals: [],
          turnOperations: [{ consumer, kind: "start", state: "pending" }],
        } as unknown as HostedProviderSession;
      });
      const program = Effect.gen(function* () {
        const service = yield* ProviderSessionAdoption.ProviderSessionAdoption;
        if (scenario !== "success") {
          const rejected = yield* service.prepare.pipe(Effect.result);
          assert.equal(rejected._tag, "Failure");
          assert.deepEqual(order, ["credentials", "open:thread-0"]);
          assert.equal((yield* service.prepare.pipe(Effect.result))._tag, "Failure");
          assert.deepEqual(order, ["credentials", "open:thread-0"]);
          return;
        }
        const first = yield* service.prepare;
        assert.deepEqual(order, [
          "credentials",
          "open:thread-0",
          "ready:thread-0",
          "open:thread-1",
          "ready:thread-1",
        ]);
        assert.strictEqual(yield* service.prepare, first);
        yield* first.resumeReplay;
        assert.deepEqual(order.slice(-4), [
          "resume:thread-0",
          "resume:thread-1",
          "replay:thread-0",
          "replay:thread-1",
        ]);
        const finished = yield* Deferred.make<void>();
        const waiting = yield* first.awaitStartup.pipe(
          Effect.andThen(Deferred.succeed(finished, undefined)),
          Effect.forkChild,
        );
        assert.isFalse(yield* Deferred.isDone(finished));
        assert.isFalse(order.includes("settled"));
        yield* Deferred.succeed(startup, undefined);
        yield* Fiber.join(waiting);
        assert.equal(order.at(-1), "settled");
        yield* service.activate("http://127.0.0.1:12345/mcp");
        assert.deepEqual(order.slice(-2), ["continuations.route", "mcp.route"]);
        yield* service.prepareForShutdown;
        assert.deepEqual(order.slice(-5), [
          "mcp.pause",
          "continuations.pause",
          "mcp.drain",
          "continuations.drain",
          "checkpoint",
        ]);
      });
      yield* program.pipe(
        Effect.provide(
          ProviderSessionAdoption.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ProviderPrivateTransport.HostTransportConfig, {
                  endpoint: "fixture-host",
                  token: "fixture-token-with-at-least-32-characters",
                }),
                Layer.mock(EffectOutbox.EffectOutboxV2)({
                  settleRetainedStarts: Effect.sync(() => {
                    order.push("settled");
                    return 1;
                  }),
                }),
                McpProviderSessions.layer,
                Layer.mock(ProviderSessionTransport.ProviderSessionClient)({
                  "continuations.route": ((input) =>
                    Effect.sync(() => {
                      assert.equal(input.endpoint, "fixture-host.core");
                      order.push("continuations.route");
                    })) as ProviderSessionTransport.ProviderSessionClient["Service"]["continuations.route"],
                  "mcp.route": ((input) =>
                    Effect.sync(() => {
                      assert.equal(input.endpoint, "http://127.0.0.1:12345/mcp");
                      order.push("mcp.route");
                    })) as ProviderSessionTransport.ProviderSessionClient["Service"]["mcp.route"],
                  "mcp.pause": (() =>
                    Effect.sync(() => {
                      order.push("mcp.pause");
                    })) as ProviderSessionTransport.ProviderSessionClient["Service"]["mcp.pause"],
                  "continuations.pause": (() =>
                    Effect.sync(() => {
                      order.push("continuations.pause");
                    })) as ProviderSessionTransport.ProviderSessionClient["Service"]["continuations.pause"],
                  "mcp.drain": (() =>
                    Effect.sync(() => {
                      order.push("mcp.drain");
                    })) as ProviderSessionTransport.ProviderSessionClient["Service"]["mcp.drain"],
                  "continuations.drain": (() =>
                    Effect.sync(() => {
                      order.push("continuations.drain");
                    })) as ProviderSessionTransport.ProviderSessionClient["Service"]["continuations.drain"],
                  "mcp.checkpoint": (() =>
                    Effect.sync(() => {
                      order.push("checkpoint");
                    })) as ProviderSessionTransport.ProviderSessionClient["Service"]["mcp.checkpoint"],
                  "session.list": (() =>
                    Effect.succeed(
                      entries,
                    )) as ProviderSessionTransport.ProviderSessionClient["Service"]["session.list"],
                  "mcp.credentials": (() =>
                    Effect.succeed(
                      [],
                    )) as ProviderSessionTransport.ProviderSessionClient["Service"]["mcp.credentials"],
                  "mcp.configurations": (() =>
                    Effect.succeed(
                      [],
                    )) as ProviderSessionTransport.ProviderSessionClient["Service"]["mcp.configurations"],
                }),
                Layer.mock(McpSessionRegistry.McpSessionRegistry)({
                  checkpoint: Effect.succeed([]),
                  restore: () =>
                    Effect.sync(() => {
                      order.push("credentials");
                    }),
                }),
                Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                  open: (input) =>
                    Effect.sync(() => {
                      assert.equal(order[0], "credentials");
                      order.push(`open:${input.threadId}`);
                      return {
                        instanceId,
                        providerSessionId: input.providerSessionId,
                        eventDelivery: {
                          receiptFor: () => undefined,
                          acknowledge: () => Effect.void,
                          resume: Effect.sync(() => {
                            assert.equal(
                              order.filter((step) => step.startsWith("ready:")).length,
                              2,
                            );
                            order.push(`resume:${input.threadId}`);
                          }),
                          awaitCaughtUp: Effect.sync(() => {
                            order.push(`replay:${input.threadId}`);
                          }),
                        },
                      } as unknown as Adapter.ProviderAdapterV2SessionRuntime;
                    }),
                }),
                Layer.mock(ProjectionStore.ProjectionStoreV2)({
                  getThreadProjection: (threadId) =>
                    Effect.succeed({
                      attempts:
                        scenario === "missing-attempt"
                          ? []
                          : entries
                              .find((entry) => entry.openInput.threadId === threadId)!
                              .runConsumers.map((consumer) => ({
                                id: consumer.attemptId,
                                runId: consumer.runId,
                                providerTurnId: null,
                              })),
                      providerTurns: [],
                    } as unknown as import("@t3tools/contracts").OrchestrationV2ThreadProjection),
                }),
                Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({
                  adopt: (input) =>
                    Effect.gen(function* () {
                      if (scenario === "consumer-failure")
                        return yield* new ProviderTurnStartService.ProviderTurnStartError({
                          runId: input.runId,
                        });
                      assert.equal(
                        input.attemptId,
                        entries.find((entry) => entry.openInput.threadId === input.threadId)!
                          .runConsumers[0]!.attemptId,
                      );
                      order.push(`ready:${input.threadId}`);
                      yield* input.consumerReady!;
                      yield* Deferred.await(startup);
                    }),
                }),
              ),
            ),
          ),
        ),
      );
    }),
);
