import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_provider_event_receipts (
    incarnation TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    consumer TEXT NOT NULL,
    operation TEXT NOT NULL,
    result_json TEXT NOT NULL,
    PRIMARY KEY (incarnation, sequence, consumer, operation)
  ) WITHOUT ROWID`;
});
