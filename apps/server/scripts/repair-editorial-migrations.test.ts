// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EditorialDatabase from "../src/editorial/persistence/EditorialDatabase.ts";
import {
  applyOnly,
  makeTempDir,
  removeDir,
} from "../src/editorial/persistence/EditorialDatabase.testkit.ts";
import {
  EDITORIAL_MIGRATIONS_TABLE,
  editorialMigrationManifest,
} from "../src/editorial/persistence/Migrations.ts";
import { runRepairEditorialMigrations } from "./repair-editorial-migrations.ts";

const onFile = <A, E>(dbPath: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

const schemaOf = (dbPath: string) =>
  onFile(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_schema
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name
      `;
    }),
  );

const openEditorial = (dbPath: string) =>
  Layer.build(EditorialDatabase.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))).pipe(
    Effect.scoped,
  );

it.effect("repairs a development database that applied [1, 2, 4] before 003", () => {
  const dir = makeTempDir();
  const dbPath = NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
  const fresh = NodePath.join(dir, "fresh.sqlite");
  return Effect.gen(function* () {
    yield* applyOnly(dbPath, [1, 2, 4]);
    yield* onFile(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO editorial_events (
            type, aggregate_kind, aggregate_id, operation_id, actor, actor_session_id,
            payload_json, created_at
          )
          VALUES ('run.imported', 'run', 'run_a', 'run.imported:run_a:h', 'system', NULL, '{}',
            '2026-10-30')
        `;
        // An earlier draft of 004 had no 'invalid' state: the repair must replace that shape.
        yield* sql`DROP TABLE editorial_dossiers`;
        yield* sql`DROP TABLE editorial_runs`;
        yield* sql`
          CREATE TABLE editorial_runs (
            run_id TEXT PRIMARY KEY,
            import_state TEXT NOT NULL CHECK (import_state IN ('imported', 'partial'))
          )
        `;
      }),
    );
    assert.strictEqual(
      (yield* openEditorial(dbPath).pipe(Effect.flip))._tag,
      "EditorialMigrationGapError",
    );

    const result = yield* runRepairEditorialMigrations(dbPath);
    assert.deepStrictEqual(result.removedMarkers, [4]);
    // 003 and every migration after it: the repair applies what the marker of 004 had hidden.
    assert.deepStrictEqual(
      result.executedMigrations,
      editorialMigrationManifest.filter(([id]) => id >= 3).map(([id, name]) => `${id}_${name}`),
    );
    assert.ok(result.backupPath !== null && NodeFS.existsSync(result.backupPath));

    // The server opens it now, with the same schema as a new database and the events kept.
    yield* openEditorial(dbPath);
    yield* openEditorial(fresh);
    assert.deepStrictEqual(yield* schemaOf(dbPath), yield* schemaOf(fresh));
    const kept = yield* onFile(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM ${sql(EDITORIAL_MIGRATIONS_TABLE)} ORDER BY migration_id
        `;
        const events = yield* sql<{ readonly operation_id: string }>`
          SELECT operation_id FROM editorial_events
        `;
        return { history: history.map((row) => [row.migration_id, row.name]), events };
      }),
    );
    assert.deepStrictEqual(
      kept.history,
      editorialMigrationManifest.map(([id, name]) => [id, name]),
    );
    assert.deepStrictEqual(kept.events, [{ operation_id: "run.imported:run_a:h" }]);

    // A second run finds nothing to do and writes no backup.
    const again = yield* runRepairEditorialMigrations(dbPath);
    assert.strictEqual(again.backupPath, null);
    assert.deepStrictEqual(again.removedMarkers, []);
  }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(removeDir(dir)));
});
