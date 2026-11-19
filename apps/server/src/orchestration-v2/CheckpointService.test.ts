import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect("bounds baseline preparation even while another capture owns the workspace", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("scope:stalled-capture"),
      threadId: ThreadId.make("thread:stalled-capture"),
      runId: RunId.make("run:stalled-capture"),
      nodeId: NodeId.make("node:stalled-capture"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:stalled-capture"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/stalled",
      createdAt: yield* DateTime.now,
    };
    const layer = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: () => Effect.succeed(false),
            captureCheckpoint: () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const capture = yield* checkpoints
        .capture({
          scope,
          ordinalWithinScope: 1,
          runId: scope.runId,
          nodeId: scope.nodeId,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const baseline = yield* checkpoints
        .captureBaseline({ scope, ordinalWithinScope: 1 })
        .pipe(Effect.result, Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      assert.isDefined(
        baseline.pollUnsafe(),
        "baseline waited indefinitely for the workspace lock",
      );
      const result = yield* Fiber.join(baseline);
      assert.strictEqual(result._tag, "Failure");
      yield* TestClock.adjust("20 seconds");
      assert.isDefined(capture.pollUnsafe(), "turn checkpoint never settled");
      assert.strictEqual((yield* Fiber.join(capture)).status, "error");
      yield* Deferred.await(cancelled);
      const missing = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 1,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      assert.strictEqual(missing.status, "missing");
      const stalledBaseline = yield* checkpoints
        .captureBaseline({ scope, ordinalWithinScope: 2 })
        .pipe(Effect.result, Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      assert.isDefined(stalledBaseline.pollUnsafe(), "baseline Git work exceeded its deadline");
      assert.strictEqual((yield* Fiber.join(stalledBaseline))._tag, "Failure");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect.each(["detect", "ref", "capture", "diff", "baseline-ref"] as const)(
  "settles a turn checkpoint when %s stops responding",
  (stage) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const blocked = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      const layer = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => (stage === "detect" ? blocked : Effect.succeed(true)),
              hasCheckpointRef: () =>
                stage === "ref" || stage === "baseline-ref" ? blocked : Effect.succeed(true),
              captureCheckpoint: () => (stage === "capture" ? blocked : Effect.void),
              diffCheckpoints: () => blocked,
              listAuthoredPaths: () => Effect.succeed(null),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );
      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        const now = yield* DateTime.now;
        const scope = yield* checkpoints.prepareRootRunScope({
          threadId: ThreadId.make("thread:timeout"),
          runId: RunId.make("run:timeout"),
          rootNodeId: NodeId.make("node:timeout"),
          providerThreadId: ProviderThreadId.make("provider-thread:timeout"),
          cwd: "/repo",
          createdAt: now,
        });
        const capture = yield* (
          stage === "baseline-ref"
            ? checkpoints.materializeBaselineCheckpoint({
                scope,
                ordinalWithinScope: 1,
                nodeId: scope.nodeId,
                capturedAt: now,
              })
            : checkpoints.capture({
                scope,
                ordinalWithinScope: 1,
                runId: scope.runId,
                nodeId: scope.nodeId,
                appRunOrdinal: 1,
                capturedAt: now,
              })
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust(stage === "baseline-ref" ? "5 seconds" : "30 seconds");
        assert.isDefined(
          capture.pollUnsafe(),
          "checkpoint kept the worker occupied after its deadline",
        );
        const checkpoint = yield* Fiber.join(capture);
        assert.strictEqual(checkpoint.status, stage === "baseline-ref" ? "missing" : "error");
        assert.deepEqual(checkpoint.files, []);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

it.effect(
  "bounds a slow baseline snapshot but waits for an in-flight capture of the same ref",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:slow-baseline"),
        threadId: ThreadId.make("thread:slow-baseline"),
        runId: RunId.make("run:slow-baseline:1"),
        nodeId: NodeId.make("node:slow-baseline:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:slow-baseline"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/slow",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
      const snapshots = yield* Ref.make(0);
      const firstSnapshotStarted = yield* Deferred.make<void>();
      const layerTest = CheckpointService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointStore.CheckpointStore)({
              isGitRepository: () => Effect.succeed(true),
              hasCheckpointRef: ({ checkpointRef }) =>
                Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
              captureCheckpoint: ({ checkpointRef }) =>
                Effect.gen(function* () {
                  yield* Ref.update(snapshots, (count) => count + 1);
                  yield* Deferred.succeed(firstSnapshotStarted, undefined);
                  yield* Effect.sleep("10 seconds");
                  yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
                }),
            }),
          ),
        ),
        Layer.provideMerge(NodeCrypto.layer),
      );

      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        // A stopped run's post-turn capture writes the next run's baseline ref while holding the lock.
        const postTurn = yield* checkpoints
          .capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstSnapshotStarted);
        const waitingBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 1 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        assert.strictEqual((yield* Fiber.join(postTurn)).status, "ready");
        assert.strictEqual((yield* Fiber.join(waitingBaseline))._tag, "Success");

        const slowBaseline = yield* checkpoints
          .captureBaseline({ scope, ordinalWithinScope: 2 })
          .pipe(Effect.result, Effect.forkChild);
        yield* TestClock.adjust("5 seconds");
        assert.strictEqual((yield* Fiber.join(slowBaseline))._tag, "Failure");
        assert.strictEqual(yield* Ref.get(snapshots), 2);
        assert.strictEqual((yield* Ref.get(refs)).size, 1);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect("records a repository probe failure as an error checkpoint, not a missing one", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:probe-failure"),
      threadId: ThreadId.make("thread:probe-failure"),
      runId: RunId.make("run:probe-failure:1"),
      nodeId: NodeId.make("node:probe-failure:1"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:probe-failure"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/bad-config",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () =>
              Effect.fail(
                new VcsProcessExitError({
                  operation: "GitVcsDriver.detectRepository",
                  command: "git",
                  cwd: scope.cwd,
                  exitCode: 128,
                  detail: "fatal: bad config line 1 in file .git/config",
                }),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    const statuses = yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 0,
        nodeId: scope.nodeId,
        capturedAt: scope.createdAt,
      });
      const turn = yield* checkpoints.capture({
        scope,
        ordinalWithinScope: 1,
        runId: scope.runId!,
        nodeId: scope.nodeId!,
        appRunOrdinal: 1,
        capturedAt: scope.createdAt,
      });
      return { baseline: baseline.status, turn: turn.status };
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(statuses, { baseline: "error", turn: "error" });
  }),
);
