import { assert, it } from "@effect/vitest";
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
import { makeSweep } from "./UsageLimitRecoveryWorker.ts";

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
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              autoArmLimitRecovery: () => Effect.die("already armed"),
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
