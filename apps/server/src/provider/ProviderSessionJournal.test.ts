import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderSessionJournal from "./ProviderSessionJournal.ts";

it.effect(
  "retains unacknowledged provider output across consumer replacement and preserves dates",
  () =>
    Effect.gen(function* () {
      const journal = yield* ProviderSessionJournal.ProviderSessionJournal;
      const sessionId = ProviderSessionId.make("kept-session");
      const now = yield* DateTime.now;
      const event = {
        type: "turn.terminal" as const,
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: ProviderThreadId.make("kept-thread"),
        providerTurnId: ProviderTurnId.make("kept-turn"),
        runOrdinal: 1,
        failureItemOrdinal: 1,
        status: "failed" as const,
        failure: { class: "usage_limit" as const, message: "Paused", code: null, retryable: null },
        threadDisposition: "reusable" as const,
        retryStartedAt: now,
      };
      const first = yield* journal.append(sessionId, event);
      const second = yield* journal.append(sessionId, event);
      assert.equal(first.sequence, 1);
      assert.equal(second.sequence, 2);
      yield* journal.acknowledge(sessionId, first.sequence);
      const recovered = yield* ProviderSessionJournal.ProviderSessionJournal.pipe(
        Effect.provide(Layer.fresh(ProviderSessionJournal.layer)),
      );
      const pending = yield* recovered.read(sessionId, 0);
      assert.lengthOf(pending, 1);
      assert.equal(pending[0]?.sequence, second.sequence);
      assert.deepEqual(pending[0]?.event, event);
      yield* recovered.acknowledge(sessionId, 99);
      assert.lengthOf(yield* recovered.read(sessionId, 0), 1);
      yield* recovered.acknowledge(sessionId, second.sequence);
      assert.lengthOf(yield* recovered.read(sessionId, 0), 0);
      assert.equal((yield* recovered.append(sessionId, event)).sequence, 3);
      yield* recovered.drop(sessionId);
      assert.lengthOf(yield* recovered.read(sessionId, 0), 0);
    }).pipe(
      Effect.provide(
        ProviderSessionJournal.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
);
