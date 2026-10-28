import { ProviderSessionId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ProviderSessionJournalError extends Schema.TaggedError<ProviderSessionJournalError>()(
  "ProviderSessionJournalError",
  {
    operation: Schema.Literals(["setup", "append", "read", "acknowledge", "drop"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider session journal failed during ${this.operation}.`;
  }
}

export const ProviderSessionEnvelope = Schema.Struct({
  sessionId: ProviderSessionId,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  event: ProviderAdapter.ProviderAdapterV2Event,
});
export type ProviderSessionEnvelope = typeof ProviderSessionEnvelope.Type;

export class ProviderSessionJournal extends Context.Service<
  ProviderSessionJournal,
  {
    readonly append: (
      sessionId: ProviderSessionId,
      event: ProviderAdapter.ProviderAdapterV2Event,
    ) => Effect.Effect<ProviderSessionEnvelope, ProviderSessionJournalError>;
    readonly read: (
      sessionId: ProviderSessionId,
      after: number,
    ) => Effect.Effect<ReadonlyArray<ProviderSessionEnvelope>, ProviderSessionJournalError>;
    readonly acknowledge: (
      sessionId: ProviderSessionId,
      through: number,
    ) => Effect.Effect<void, ProviderSessionJournalError>;
    readonly drop: (
      sessionId: ProviderSessionId,
    ) => Effect.Effect<void, ProviderSessionJournalError>;
  }
>()("t3/provider/ProviderSessionJournal") {}

const eventJson = Schema.fromJsonString(Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event));
const encodeEvent = Schema.encodeEffect(eventJson);
const decodeEvent = Schema.decodeUnknownEffect(eventJson);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.gen(function* () {
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`PRAGMA synchronous = NORMAL`;
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`CREATE TABLE IF NOT EXISTS provider_host_cursors (
      session_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL, acknowledged INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE IF NOT EXISTS provider_host_events (
      session_id TEXT NOT NULL REFERENCES provider_host_cursors(session_id),
      sequence INTEGER NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(session_id, sequence)
    )`;
  }).pipe(
    Effect.mapError((cause) => new ProviderSessionJournalError({ operation: "setup", cause })),
  );

  const append = Effect.fn("ProviderSessionJournal.append")(
    function* (sessionId: ProviderSessionId, event: ProviderAdapter.ProviderAdapterV2Event) {
      const payload = yield* encodeEvent(event);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly next_sequence: number }>`
        INSERT INTO provider_host_cursors (session_id, next_sequence, acknowledged)
        VALUES (${sessionId}, 2, 0)
        ON CONFLICT(session_id) DO UPDATE SET next_sequence = next_sequence + 1
        RETURNING next_sequence
      `;
          const sequence = rows[0]!.next_sequence - 1;
          yield* sql`INSERT INTO provider_host_events (session_id, sequence, payload_json)
        VALUES (${sessionId}, ${sequence}, ${payload})`;
          return { sessionId, sequence, event };
        }),
      );
    },
    Effect.mapError((cause) => new ProviderSessionJournalError({ operation: "append", cause })),
  );

  const read = Effect.fn("ProviderSessionJournal.read")(
    function* (sessionId: ProviderSessionId, after: number) {
      const rows = yield* sql<{ readonly sequence: number; readonly payload_json: string }>`
      SELECT sequence, payload_json FROM provider_host_events
      WHERE session_id = ${sessionId} AND sequence > ${after}
      ORDER BY sequence LIMIT 256
    `;
      return yield* Effect.forEach(rows, (row) =>
        decodeEvent(row.payload_json).pipe(
          Effect.map((event) => ({ sessionId, sequence: row.sequence, event })),
        ),
      );
    },
    Effect.mapError((cause) => new ProviderSessionJournalError({ operation: "read", cause })),
  );

  const acknowledge = Effect.fn("ProviderSessionJournal.acknowledge")(
    function* (sessionId: ProviderSessionId, through: number) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`UPDATE provider_host_cursors SET acknowledged = ${through}
        WHERE session_id = ${sessionId} AND acknowledged <= ${through} AND next_sequence > ${through}
        RETURNING session_id`;
          if (rows.length === 0) return;
          yield* sql`DELETE FROM provider_host_events WHERE session_id = ${sessionId} AND sequence <= ${through}`;
        }),
      );
    },
    Effect.mapError(
      (cause) => new ProviderSessionJournalError({ operation: "acknowledge", cause }),
    ),
  );

  const drop = Effect.fn("ProviderSessionJournal.drop")(
    function* (sessionId: ProviderSessionId) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM provider_host_events WHERE session_id = ${sessionId}`;
          yield* sql`DELETE FROM provider_host_cursors WHERE session_id = ${sessionId}`;
        }),
      );
    },
    Effect.mapError((cause) => new ProviderSessionJournalError({ operation: "drop", cause })),
  );
  return ProviderSessionJournal.of({ append, read, acknowledge, drop });
});

export const layer = Layer.effect(ProviderSessionJournal, make);
