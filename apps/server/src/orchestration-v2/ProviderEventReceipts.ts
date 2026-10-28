import { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const ProviderEventReceiptKey = Schema.Struct({
  incarnation: Schema.String,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  consumer: Schema.String,
  operation: Schema.String,
});
export type ProviderEventReceiptKey = typeof ProviderEventReceiptKey.Type;
const ReceiptResult = Schema.Struct({
  committed: Schema.Boolean,
  storedEvents: Schema.Array(OrchestrationV2StoredEvent),
});
const receiptJson = Schema.fromJsonString(Schema.toCodecJson(ReceiptResult));
const decode = Schema.decodeEffect(receiptJson);
const encode = Schema.encodeEffect(receiptJson);

export class ProviderEventReceiptError extends Schema.TaggedError<ProviderEventReceiptError>()(
  "ProviderEventReceiptError",
  { operation: Schema.Literals(["read", "write", "prune"]), cause: Schema.Defect() },
) {
  override get message() {
    return `Cannot ${this.operation} a provider event receipt.`;
  }
}
export class ProviderEventReceipts extends Context.Service<
  ProviderEventReceipts,
  {
    readonly read: (
      key: ProviderEventReceiptKey,
    ) => Effect.Effect<typeof ReceiptResult.Type | undefined, ProviderEventReceiptError>;
    readonly record: (
      key: ProviderEventReceiptKey,
      result: typeof ReceiptResult.Type,
    ) => Effect.Effect<void, ProviderEventReceiptError>;
    readonly prune: (input: {
      readonly incarnation: string;
      readonly through: number;
    }) => Effect.Effect<void, ProviderEventReceiptError>;
  }
>()("t3/orchestration-v2/ProviderEventReceipts") {}

export const layer = Layer.effect(
  ProviderEventReceipts,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Fork-private table: a numbered migration would take an id upstream's next migration needs.
    yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_provider_event_receipts (
      incarnation TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      consumer TEXT NOT NULL,
      operation TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (incarnation, sequence, consumer, operation)
    ) WITHOUT ROWID`.pipe(Effect.orDie);
    return ProviderEventReceipts.of({
      read: Effect.fn("ProviderEventReceipts.read")(
        function* (key) {
          const rows = yield* sql<{
            result_json: string;
          }>`SELECT result_json FROM orchestration_v2_provider_event_receipts
        WHERE incarnation = ${key.incarnation} AND sequence = ${key.sequence}
          AND consumer = ${key.consumer} AND operation = ${key.operation}`;
          return rows[0] === undefined ? undefined : yield* decode(rows[0].result_json);
        },
        Effect.mapError((cause) => new ProviderEventReceiptError({ operation: "read", cause })),
      ),
      record: Effect.fn("ProviderEventReceipts.record")(
        function* (key, result) {
          const json = yield* encode(result);
          yield* sql`INSERT INTO orchestration_v2_provider_event_receipts (incarnation, sequence, consumer, operation, result_json)
        VALUES (${key.incarnation}, ${key.sequence}, ${key.consumer}, ${key.operation}, ${json})`;
        },
        Effect.mapError((cause) => new ProviderEventReceiptError({ operation: "write", cause })),
      ),
      prune: Effect.fn("ProviderEventReceipts.prune")(
        function* (input) {
          yield* sql`DELETE FROM orchestration_v2_provider_event_receipts
        WHERE incarnation = ${input.incarnation} AND sequence <= ${input.through}`;
        },
        Effect.mapError((cause) => new ProviderEventReceiptError({ operation: "prune", cause })),
      ),
    });
  }),
);
