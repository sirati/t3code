import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  RunId,
  ThreadId,
  UsageLimitSourceId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as CliproxyRecovery from "../usage/CliproxyRecovery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Clock from "effect/Clock";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Scheduler from "../scheduling/Scheduler.ts";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitRecoveryCommand, makeSweep } from "./UsageLimitRecoveryWorker.ts";

it.effect.each([
  "available",
  "cancelled",
  "expired",
  "past-reset-available",
  "past-reset-expired",
] as const)(
  "waits without dispatching model work and handles a subscription becoming %s",
  (ending) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const outcome = yield* Deferred.make<"available" | "expired">();
      const dispatched = yield* Deferred.make<OrchestrationV2ServerCommand>();
      const commands: OrchestrationV2ServerCommand[] = [];
      const now = yield* DateTime.now;
      const resetAt = ending.startsWith("past-reset")
        ? DateTime.formatIso(DateTime.add(now, { minutes: 1 }))
        : null;
      const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
        id: ThreadId.make("recover:thread"),
        status: "failed",
        lastErrorClass: "usage_limit",
        latestRunId: RunId.make("recover:run"),
        usageLimitResetAt: resetAt,
        proxyRecoveryId: "K5wVx3M9Sq1zAx7B",
        latestRunCompletedAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        pendingRuntimeRequest: null,
        snoozedUntil: null,
        limitRecovery: {
          runId: RunId.make("recover:run"),
          resetAt,
          proxyRecoveryId: "K5wVx3M9Sq1zAx7B",
          autoResume: true,
          requestId: CommandId.make("recover:request"),
        },
      };
      const candidates = yield* Ref.make([candidate]);
      yield* Effect.gen(function* () {
        const sweep = yield* makeSweep;
        yield* sweep();
        yield* Deferred.await(started);
        yield* sweep();
        assert.lengthOf(commands, 0);
        if (resetAt !== null) {
          yield* TestClock.adjust("1 minute");
          yield* sweep();
          assert.lengthOf(commands, 0);
        }
        if (ending === "cancelled") {
          yield* Ref.set(candidates, []);
          yield* sweep();
          yield* Deferred.await(released);
          yield* Deferred.succeed(outcome, "available");
          assert.lengthOf(commands, 0);
        } else {
          yield* Deferred.succeed(outcome, ending.endsWith("available") ? "available" : "expired");
          yield* Deferred.await(released);
          if (ending.endsWith("available")) {
            const command = yield* Deferred.await(dispatched);
            if (command.type !== "message.dispatch") return assert.fail("Expected a continuation");
            assert.equal(command.threadId, candidate.id);
            assert.lengthOf(commands, 1);
          } else {
            yield* sweep();
            assert.lengthOf(commands, ending === "past-reset-expired" ? 1 : 0);
          }
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getLimitRecoveryCandidates: () => Ref.get(candidates),
              getLimitRecoveryWakeAt: () => Effect.succeed(null),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              autoArmLimitRecovery: () => Effect.die("already armed"),
              streamDomainEvents: Stream.never,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                }).pipe(
                  Effect.andThen(Deferred.succeed(dispatched, command)),
                  Effect.as({ sequence: 1, storedEvents: [] }),
                ),
            }),
            Layer.mock(CliproxyRecovery.CliproxyRecovery)({
              wait: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(outcome)),
                  Effect.ensuring(Deferred.succeed(released, undefined)),
                ),
            }),
            ServerSettings.layerTest({
              usageLimitSources: {
                [UsageLimitSourceId.make("hub")]: {
                  kind: "cliproxy",
                  url: "https://hub.test",
                  managementKey: "key",
                  enabled: true,
                },
              },
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
              usageLimitSources: {},
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});
