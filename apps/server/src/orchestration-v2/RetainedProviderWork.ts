import type { ProviderSessionId, RunAttemptId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as ProjectionStore from "./ProjectionStore.ts";

export interface Snapshot {
  readonly sessionIds: ReadonlyArray<ProviderSessionId>;
  readonly attemptIds: ReadonlyArray<RunAttemptId>;
}

export class RetainedProviderWork extends Context.Service<
  RetainedProviderWork,
  {
    readonly read: Effect.Effect<Snapshot>;
    readonly replace: (snapshot: Snapshot) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/RetainedProviderWork") {}

export const empty: Snapshot = { sessionIds: [], attemptIds: [] };
export const layer = Layer.effect(
  RetainedProviderWork,
  Effect.gen(function* () {
    const state = yield* Ref.make(empty);
    return RetainedProviderWork.of({
      read: Ref.get(state),
      replace: Effect.fn("RetainedProviderWork.replace")((snapshot: Snapshot) =>
        Ref.set(state, snapshot),
      ),
    });
  }),
);

export function lostProjection(
  projection: ProjectionStore.ProjectionRuntimeRecoveryState,
  retained: Snapshot,
): ProjectionStore.ProjectionRuntimeRecoveryState {
  if (retained.sessionIds.length === 0 && retained.attemptIds.length === 0) return projection;
  const sessionIds = new Set(retained.sessionIds);
  const attemptIds = new Set(retained.attemptIds);
  const threads = new Set(
    projection.providerThreads
      .filter(
        (thread) => thread.providerSessionId !== null && sessionIds.has(thread.providerSessionId),
      )
      .map((thread) => thread.id),
  );
  const attempts = projection.attempts.filter((attempt) => attemptIds.has(attempt.id));
  const roots = new Set(attempts.map((attempt) => attempt.rootNodeId));
  const runs = new Set(
    projection.runs
      .filter((run) => run.activeAttemptId !== null && attemptIds.has(run.activeAttemptId))
      .map((run) => run.id),
  );
  const nodes = new Set(
    projection.nodes
      .filter(
        (node) =>
          roots.has(node.id) ||
          roots.has(node.rootNodeId) ||
          (node.runId === null &&
            node.providerThreadId !== null &&
            threads.has(node.providerThreadId)),
      )
      .map((node) => node.id),
  );
  const turns = new Set(
    projection.providerTurns
      .filter((turn) =>
        turn.runAttemptId === null
          ? threads.has(turn.providerThreadId)
          : attemptIds.has(turn.runAttemptId),
      )
      .map((turn) => turn.id),
  );
  const requests = new Set(
    projection.runtimeRequests
      .filter(
        (request) =>
          nodes.has(request.nodeId) ||
          (request.responseCapability.type === "live" &&
            sessionIds.has(request.responseCapability.providerSessionId)),
      )
      .map((request) => request.id),
  );
  return {
    ...projection,
    runs: projection.runs.filter((run) => !runs.has(run.id)),
    attempts: projection.attempts.filter((attempt) => !attempts.includes(attempt)),
    nodes: projection.nodes.filter((node) => !nodes.has(node.id)),
    providerSessions: projection.providerSessions.filter((session) => !sessionIds.has(session.id)),
    providerThreads: projection.providerThreads.filter((thread) => !threads.has(thread.id)),
    providerTurns: projection.providerTurns.filter((turn) => !turns.has(turn.id)),
    runtimeRequests: projection.runtimeRequests.filter((request) => !requests.has(request.id)),
    subagents: projection.subagents.filter(
      (subagent) =>
        !nodes.has(subagent.id) &&
        !nodes.has(subagent.parentNodeId) &&
        !(subagent.providerThreadId !== null && threads.has(subagent.providerThreadId)),
    ),
    turnItems: projection.turnItems.filter(
      (item) =>
        !(item.nodeId !== null && nodes.has(item.nodeId)) &&
        !(item.providerTurnId !== null && turns.has(item.providerTurnId)),
    ),
    messages: projection.messages.filter(
      (message) => !(message.nodeId !== null && nodes.has(message.nodeId)),
    ),
  };
}
