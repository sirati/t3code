import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderEventReceipts from "./ProviderEventReceipts.ts";

const schemaState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'orchestration_v2_provider_event_receipts'
  `;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return {
    receiptTables: tables.length,
    history: history.map((row) => [row.migration_id, row.name] as const),
  };
});

it.layer(NodeServices.layer)("ProviderEventReceipts", (it) => {
  it.effect("adds its table to an upstream database without touching migration history", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dbPath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-receipts-" }),
        "statev2.sqlite",
      );
      const upstream = yield* Effect.gen(function* () {
        yield* runMigrations();
        return yield* schemaState;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      assert.deepStrictEqual(upstream, { receiptTables: 0, history: migrationManifest });

      const boot = ProviderEventReceipts.layer.pipe(
        Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
      );
      const key = {
        incarnation: "host-1",
        sequence: 1,
        consumer: "ingestor",
        operation: "publish",
      };
      const result = { committed: true, storedEvents: [] };

      const first = yield* Effect.gen(function* () {
        const receipts = yield* ProviderEventReceipts.ProviderEventReceipts;
        yield* receipts.record(key, result);
        return yield* schemaState;
      }).pipe(Effect.provide(boot));
      assert.deepStrictEqual(first, { receiptTables: 1, history: migrationManifest });

      const restarted = yield* Effect.gen(function* () {
        const receipts = yield* ProviderEventReceipts.ProviderEventReceipts;
        return { receipt: yield* receipts.read(key), schema: yield* schemaState };
      }).pipe(Effect.provide(boot));
      assert.deepStrictEqual(restarted, {
        receipt: result,
        schema: { receiptTables: 1, history: migrationManifest },
      });
    }).pipe(Effect.scoped),
  );
});
