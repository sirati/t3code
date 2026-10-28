import {
  CommandId,
  MessageId,
  type UsageLimitSourceConfig,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as CliproxyRecovery from "../usage/CliproxyRecovery.ts";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  proxyAvailable = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    (!thread.usageLimitResetAt && !thread.proxyRecoveryId) ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetAt = thread.usageLimitResetAt ?? null;
  const reportedResetMs = resetAt === null ? Number.POSITIVE_INFINITY : Date.parse(resetAt);
  const completedMs = DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
  const resetMs =
    thread.proxyRecoveryId && reportedResetMs <= completedMs
      ? Number.POSITIVE_INFINITY
      : reportedResetMs;
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !thread.proxyRecoveryId &&
    (!Number.isFinite(resetMs) ||
      resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt))
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${thread.proxyRecoveryId ?? resetMs}`;
  const recovery = thread.limitRecovery;
  if (
    recovery?.runId !== thread.latestRunId ||
    recovery.resetAt !== resetAt ||
    (recovery.proxyRecoveryId ?? null) !== (thread.proxyRecoveryId ?? null)
  ) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt,
        autoResume,
        snooze: snooze && Number.isFinite(resetMs) && resetMs > nowMs,
        ...(thread.proxyRecoveryId ? { proxyRecoveryId: thread.proxyRecoveryId } : {}),
      },
    };
  }
  if (
    !recovery.autoResume ||
    (!proxyAvailable && resetMs > nowMs) ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(proxyAvailable && thread.proxyRecoveryId
      ? { proxyRecoveryAvailableId: thread.proxyRecoveryId }
      : {}),
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const recovery = yield* CliproxyRecovery.CliproxyRecovery;
  const scope = yield* Scope.Scope;
  const waits = new Map<
    string,
    {
      sources: ReadonlyArray<readonly [string, UsageLimitSourceConfig]>;
      state: "waiting" | "available" | "expired";
      fiber: Fiber.Fiber<void, CliproxyRecovery.CliproxyRecoveryError> | undefined;
    }
  >();
  const dispatch = Effect.fn("UsageLimitRecoveryWorker.dispatch")(
    function* (command: OrchestrationV2Command) {
      if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
        yield* orchestrator.autoArmLimitRecovery({
          commandId: command.commandId,
          threadId: command.threadId,
          limitRecovery: command.limitRecovery,
        });
      } else {
        yield* threads.dispatch(command);
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", { cause }),
    ),
  );
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    const sources = Object.entries(preferences.usageLimitSources)
      .filter(([, source]) => source.enabled && source.managementKey)
      .sort(([a], [b]) => a.localeCompare(b));
    const active = new Set<string>();
    for (const thread of candidates) {
      const waitKey = `${thread.id}:${thread.latestRunId}:${thread.proxyRecoveryId}:${thread.limitRecovery?.requestId}`;
      let wait = waits.get(waitKey);
      const waitingForProxy =
        thread.proxyRecoveryId &&
        thread.limitRecovery?.autoResume &&
        thread.limitRecovery.runId === thread.latestRunId &&
        thread.limitRecovery.resetAt === (thread.usageLimitResetAt ?? null) &&
        thread.limitRecovery.proxyRecoveryId === thread.proxyRecoveryId;
      if (waitingForProxy) {
        active.add(waitKey);
        if (
          wait &&
          !(
            wait.sources.length === sources.length &&
            sources.every(([id, config], index) => {
              const previous = wait?.sources[index];
              return (
                previous?.[0] === id &&
                previous[1].url === config.url &&
                previous[1].managementKey === config.managementKey
              );
            })
          )
        ) {
          if (wait.fiber) yield* Fiber.interrupt(wait.fiber);
          waits.delete(waitKey);
          wait = undefined;
        }
        if (!wait) {
          const entry = {
            sources,
            state: "waiting" as "waiting" | "available" | "expired",
            fiber: undefined as
              | Fiber.Fiber<void, CliproxyRecovery.CliproxyRecoveryError>
              | undefined,
          };
          waits.set(waitKey, entry);
          const id = thread.proxyRecoveryId;
          entry.fiber = yield* recovery
            .wait(
              sources.map(([, config]) => config),
              id,
            )
            .pipe(
              Effect.tap((state) =>
                Effect.gen(function* () {
                  entry.state = state;
                  if (state !== "available") return;
                  const currentTime = yield* DateTime.now;
                  const command = limitRecoveryCommand(
                    thread,
                    preferences.autoResumeLimitedThreads,
                    DateTime.toEpochMillis(currentTime),
                    preferences.snoozeLimitedThreads,
                    true,
                  );
                  if (command !== null) yield* dispatch(command);
                }),
              ),
              Effect.asVoid,
              Effect.forkIn(scope),
            );
          wait = entry;
        }
      }
      if (waitingForProxy && wait?.state === "waiting") continue;
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
        wait?.state === "available",
      );
      if (command === null) continue;
      yield* dispatch(command);
    }
    for (const [key, wait] of waits) {
      if (active.has(key)) continue;
      waits.delete(key);
      if (wait.fiber) yield* Fiber.interrupt(wait.fiber);
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
).pipe(Layer.provide(CliproxyRecovery.layer));
