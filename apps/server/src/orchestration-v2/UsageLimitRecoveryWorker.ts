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
import * as Stream from "effect/Stream";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { routineSpan } from "@t3tools/shared/observability";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;
// One freed route can wake many threads; they resume one at a time so no burst exhausts it again.
const PROXY_RESUME_SPACING_MS = 10_000;

/** The proxy provider and model a thread's turn needs, for drivers the proxy serves. */
function proxyRouteFor(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  providerDrivers: Readonly<Record<string, string | undefined>>,
): CliproxyRecovery.RecoveryRoute | undefined {
  if (thread.providerInstanceId === undefined) return undefined;
  const driver = providerDrivers[thread.providerInstanceId] ?? thread.providerInstanceId;
  const provider = driver === "claudeAgent" ? "claude" : driver === "codex" ? "codex" : undefined;
  return provider === undefined ? undefined : { provider, model: thread.model };
}

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
    if (!thread.proxyRecoveryId && nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
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
    createdBy: "agent",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  const recovery = yield* CliproxyRecovery.CliproxyRecovery;
  const scope = yield* Scope.Scope;
  // "fallback": the proxy forgot the ticket, so its account cooldowns are watched instead.
  type WaitState = "waiting" | "fallback" | "available" | "expired";
  const waits = new Map<
    string,
    {
      sources: ReadonlyArray<readonly [string, UsageLimitSourceConfig]>;
      state: WaitState;
      availableAt: number;
      fiber: Fiber.Fiber<void, CliproxyRecovery.CliproxyRecoveryError> | undefined;
    }
  >();
  let lastProxyResumeAt = Number.NEGATIVE_INFINITY;
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
  return Effect.fn("UsageLimitRecoveryWorker.sweep", { attributes: routineSpan })(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    let acted = false;
    const sources = Object.entries(preferences.usageLimitSources)
      .filter(([, source]) => source.enabled && source.managementKey)
      .sort(([a], [b]) => a.localeCompare(b));
    const active = new Set<string>();
    let providerDrivers: Record<string, string | undefined> | undefined;
    const driversOf = () =>
      (providerDrivers ??= Object.fromEntries(
        Object.entries(preferences.providerInstances).map(([id, instance]) => [
          id,
          instance.driver,
        ]),
      ));
    const ready: Array<{
      readonly thread: (typeof candidates)[number];
      readonly availableAt: number;
    }> = [];
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
            state: "waiting" as WaitState,
            availableAt: Number.POSITIVE_INFINITY,
            fiber: undefined as
              | Fiber.Fiber<void, CliproxyRecovery.CliproxyRecoveryError>
              | undefined,
          };
          waits.set(waitKey, entry);
          const configs = sources.map(([, config]) => config);
          const route = proxyRouteFor(thread, driversOf());
          const settle = Effect.fn("UsageLimitRecoveryWorker.settleWait")(function* (
            state: WaitState,
          ) {
            entry.state = state;
            if (state === "available")
              entry.availableAt = DateTime.toEpochMillis(yield* DateTime.now);
            yield* due.invalidate;
          });
          entry.fiber = yield* recovery.wait(configs, thread.proxyRecoveryId).pipe(
            Effect.flatMap((state) =>
              state === "expired" && route !== undefined
                ? settle("fallback").pipe(
                    Effect.andThen(recovery.waitForRoute(configs, route)),
                    Effect.flatMap(settle),
                  )
                : settle(state),
            ),
            Effect.forkIn(scope),
          );
          wait = entry;
        }
      }
      if (waitingForProxy && wait?.state === "waiting") continue;
      // The sweep resumes these below, spaced out, with the thread as it is now.
      if (waitingForProxy && wait?.state === "available") {
        ready.push({ thread, availableAt: wait.availableAt });
        continue;
      }
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      acted = true;
      yield* dispatch(command);
    }
    if (nowMs - lastProxyResumeAt >= PROXY_RESUME_SPACING_MS) {
      ready.sort((a, b) => a.availableAt - b.availableAt);
      for (const { thread } of ready) {
        const command = limitRecoveryCommand(
          thread,
          preferences.autoResumeLimitedThreads,
          nowMs,
          preferences.snoozeLimitedThreads,
          true,
        );
        if (command === null) continue;
        acted = true;
        lastProxyResumeAt = nowMs;
        yield* dispatch(command);
        break;
      }
    }
    for (const [key, wait] of waits) {
      if (active.has(key)) continue;
      waits.delete(key);
      if (wait.fiber) yield* Fiber.interrupt(wait.fiber);
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted || waits.size > 0) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
).pipe(Layer.provide(CliproxyRecovery.layer));
