import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as RetainedProviderWork from "./RetainedProviderWork.ts";

it("partitions lost work without cancelling a retained historical attempt or its live callback", () => {
  const sessionId = ProviderSessionId.make("retained");
  const attemptId = RunAttemptId.make("old-attempt");
  const projection = {
    thread: { id: "thread" },
    runs: [{ id: "same-run", activeAttemptId: "new-attempt", providerThreadId: "lost-thread" }],
    attempts: [
      { id: attemptId, providerThreadId: "old-thread", rootNodeId: "old-root" },
      { id: "new-attempt", providerThreadId: "lost-thread", rootNodeId: "new-root" },
    ],
    providerSessions: [{ id: sessionId }, { id: "lost" }],
    providerThreads: [
      { id: "old-thread", providerSessionId: sessionId },
      { id: "lost-thread", providerSessionId: "lost" },
    ],
    providerTurns: [
      { id: "old-turn", providerThreadId: "old-thread", runAttemptId: attemptId },
      { id: "new-turn", providerThreadId: "lost-thread", runAttemptId: "new-attempt" },
    ],
    nodes: [
      { id: "old-root", rootNodeId: "old-root", providerThreadId: "old-thread" },
      { id: "old-child", rootNodeId: "old-root", providerThreadId: null },
      { id: "new-root", rootNodeId: "new-root", providerThreadId: "lost-thread" },
    ],
    runtimeRequests: [
      {
        id: "live-request",
        nodeId: "old-child",
        responseCapability: { type: "live", providerSessionId: sessionId },
      },
      {
        id: "lost-request",
        nodeId: "new-root",
        responseCapability: { type: "live", providerSessionId: "lost" },
      },
    ],
    subagents: [
      { id: "old-agent", parentNodeId: "old-root", providerThreadId: null },
      { id: "lost-agent", parentNodeId: "new-root", providerThreadId: null },
    ],
    turnItems: [
      { id: "live-item", nodeId: "old-child", providerTurnId: "old-turn" },
      { id: "lost-item", nodeId: "new-root", providerTurnId: "new-turn" },
    ],
    messages: [
      { id: "live-message", nodeId: "old-child" },
      { id: "lost-message", nodeId: "new-root" },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.strictEqual(
    RetainedProviderWork.lostProjection(projection, RetainedProviderWork.empty),
    projection,
  );
  const lost = RetainedProviderWork.lostProjection(projection, {
    sessionIds: [sessionId],
    attemptIds: [attemptId],
  });
  assert.deepEqual(lost.runs, projection.runs);
  assert.deepEqual(
    lost.attempts.map((row) => row.id),
    ["new-attempt"],
  );
  assert.deepEqual(
    lost.nodes.map((row) => row.id),
    ["new-root"],
  );
  assert.deepEqual(
    lost.providerSessions.map((row) => row.id),
    ["lost"],
  );
  assert.deepEqual(
    lost.providerThreads.map((row) => row.id),
    ["lost-thread"],
  );
  assert.deepEqual(
    lost.providerTurns.map((row) => row.id),
    ["new-turn"],
  );
  assert.deepEqual(
    lost.runtimeRequests.map((row) => row.id),
    ["lost-request"],
  );
  assert.deepEqual(
    lost.subagents.map((row) => row.id),
    ["lost-agent"],
  );
  assert.deepEqual(
    lost.turnItems.map((row) => row.id),
    ["lost-item"],
  );
  assert.deepEqual(
    lost.messages.map((row) => row.id),
    ["lost-message"],
  );
  assert.equal(projection.nodes.length, 3);
  const sharedSession = {
    ...projection,
    providerThreads: projection.providerThreads.map((thread) => ({
      ...thread,
      providerSessionId: sessionId,
    })),
  };
  const unadmitted = RetainedProviderWork.lostProjection(sharedSession, {
    sessionIds: [sessionId],
    attemptIds: [attemptId],
  });
  assert.deepEqual(unadmitted.runs, projection.runs);
  assert.deepEqual(
    unadmitted.attempts.map((row) => row.id),
    ["new-attempt"],
  );
  assert.deepEqual(
    unadmitted.nodes.map((row) => row.id),
    ["new-root"],
  );
  assert.deepEqual(
    unadmitted.providerTurns.map((row) => row.id),
    ["new-turn"],
  );
});

it.effect.each(["pending", "running"] as const)(
  "preserves retained starts and pending controls while releasing old leases: %s",
  (status) =>
    Effect.gen(function* () {
      const state = yield* RetainedProviderWork.RetainedProviderWork;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const sessionId = ProviderSessionId.make("retained-session");
      const threadId = ThreadId.make("mixed-thread");
      const attemptId = RunAttemptId.make("retained-attempt");
      yield* state.replace({ sessionIds: [sessionId], attemptIds: [attemptId] });
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id,thread_id,ordinal,provider,provider_instance_id,provider_thread_id,status,requested_at,completed_at,payload_json)
      VALUES ('retained-run',${threadId},1,'fixture','fixture',NULL,'running','2026-01-01',NULL,'{"activeAttemptId":"retained-attempt"}')`;
      const common = { commandId: CommandId.make("effects"), threadId };
      yield* outbox.enqueue([
        {
          ...common,
          id: "retained-start",
          request: { type: "provider-turn.start", runId: RunId.make("retained-run") },
        },
        {
          ...common,
          id: "retained-interrupt",
          request: {
            type: "provider-turn.interrupt",
            providerSessionId: sessionId,
            providerThreadId: ProviderThreadId.make("native"),
            providerTurnId: ProviderTurnId.make("turn"),
          },
        },
        {
          ...common,
          id: "lost-start",
          request: { type: "provider-turn.start", runId: RunId.make("lost-run") },
        },
      ]);
      if (status === "running")
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running', lease_owner = 'old-core' WHERE effect_id IN ('retained-start', 'retained-interrupt')`;
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, {
        requeued: 0,
        cancelled: status === "running" ? 2 : 1,
      });
      assert.equal(Option.getOrThrow(yield* outbox.get("retained-start")).status, status);
      assert.equal(
        Option.getOrThrow(yield* outbox.get("retained-interrupt")).status,
        status === "running" ? "cancelled" : "pending",
      );
      assert.equal(Option.getOrThrow(yield* outbox.get("lost-start")).status, "cancelled");
      assert.deepEqual(
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
          reason: "recovery",
          preserveRetained: true,
        }),
        [],
      );
      const cancelled = yield* outbox.cancelUnsettled({
        threadId,
        effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
        reason: "explicit user cancellation",
      });
      assert.deepEqual(
        [...cancelled].sort(),
        status === "running" ? ["retained-start"] : ["retained-interrupt", "retained-start"],
      );
      yield* outbox.enqueue([
        {
          ...common,
          id: "adopted-start",
          request: { type: "provider-turn.start", runId: RunId.make("retained-run") },
        },
        {
          ...common,
          id: "later-work",
          request: { type: "provider-turn.start", runId: RunId.make("later-run") },
        },
      ]);
      if (status === "running")
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running', lease_owner = 'old-core' WHERE effect_id = 'adopted-start'`;
      assert.equal(yield* outbox.settleRetainedStarts, 1);
      assert.equal(yield* outbox.settleRetainedStarts, 0);
      const adopted = Option.getOrThrow(yield* outbox.get("adopted-start"));
      assert.equal(adopted.status, "succeeded");
      assert.equal(adopted.attemptCount, 0);
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId: "new-core" })).id,
        "later-work",
      );
    }).pipe(
      Effect.provide(
        EffectOutbox.layer.pipe(
          Layer.provideMerge(
            Layer.merge(SqlitePersistence.layerMemory, RetainedProviderWork.layer),
          ),
        ),
      ),
    ),
);
