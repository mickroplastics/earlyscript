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
  editorialMigrationEntries,
  editorialMigrationManifest,
  makeEditorialMigrations,
} from "../src/editorial/persistence/Migrations.ts";
import ManualWork from "../src/editorial/persistence/Migrations/009_EditorialManualWork.ts";
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

// A merge moved EditorialManualWork from 009 to 010 and put EditorialJobs (nightly) at 009. A
// database that applied ManualWork as 009 passes an id-only continuity check and the Migrator
// would skip Jobs for good; the server must refuse it, and the repair must apply Jobs for real.
const jobsAt9 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE editorial_jobs (job_id TEXT PRIMARY KEY, state TEXT NOT NULL)`;
  yield* sql`CREATE TABLE editorial_nightly_settings (key TEXT PRIMARY KEY, value TEXT)`;
});

const upToManualWork = makeEditorialMigrations(editorialMigrationEntries.filter(([id]) => id <= 9));

const mergedManifest = makeEditorialMigrations([
  ...editorialMigrationEntries.filter(([id]) => id <= 8),
  [9, "EditorialJobs", jobsAt9],
  [10, "EditorialManualWork", ManualWork],
]);

const tablesOf = (dbPath: string) =>
  onFile(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
      `;
      return rows.map((row) => row.name);
    }),
  );

const markersOf = (dbPath: string) =>
  onFile(
    dbPath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM ${sql(EDITORIAL_MIGRATIONS_TABLE)} ORDER BY migration_id
      `;
      return rows.map((row) => [row.migration_id, row.name] as const);
    }),
  );

it.effect("refuses, then repairs, a database that applied EditorialManualWork as 009", () => {
  const dir = makeTempDir();
  const dbPath = NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
  return Effect.gen(function* () {
    // The manifest up to 009 = ManualWork, as `main` had it before Jobs became 010. A manual
    // thread leaves a visit, two captures (one removed) and a decision.
    yield* onFile(dbPath, upToManualWork.run());
    yield* onFile(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO editorial_video_threads (
            thread_id, environment_id, operation_id, mode, launch_state, created_by, created_at
          )
          VALUES ('thread-m', 'env', 'op-m', 'manual', 'launched', 'operator', '2026-10-31')
        `;
        yield* sql`
          INSERT INTO editorial_browser_visits (
            visit_id, thread_id, tab_id, url, title, origin, visited_at
          )
          VALUES ('v1', 'thread-m', 'tab', 'https://news.ycombinator.com/', 'HN', 'server',
            '2026-10-31T05:25:00.000Z')
        `;
        yield* sql`
          INSERT INTO editorial_captures (
            capture_id, thread_id, url, title, note, actor, captured_at, removed_at
          )
          VALUES
            ('c1', 'thread-m', 'https://github.com/trending', NULL, 'nota', 'operator',
              '2026-10-31', NULL),
            ('c2', 'thread-m', 'https://x.com/', NULL, NULL, 'operator', '2026-10-31',
              '2026-10-31')
        `;
        yield* sql`
          INSERT INTO editorial_decisions (
            decision_id, thread_id, action, utility, reason, script_version_hash, explore_ms,
            read_ms, write_ms, decide_ms, total_ms, clock_definitive, actor, decided_at
          )
          VALUES ('d1', 'thread-m', 'accept', 4, NULL, NULL, 1000, NULL, 2000, 0, 3000, 1,
            'operator', '2026-10-31')
        `;
      }),
    );
    assert.deepStrictEqual((yield* markersOf(dbPath)).at(-1), [9, "EditorialManualWork"]);

    // After the merge the ids still look continuous, so only the names show the problem.
    const refused = yield* onFile(dbPath, mergedManifest.run()).pipe(Effect.flip);
    assert.ok(refused._tag === "EditorialMigrationGapError" && refused.reason === "name-mismatch");
    assert.include(refused.message, "9 = «EditorialManualWork»");
    assert.include(refused.message, "repair-editorial-migrations.ts");
    assert.notInclude(yield* tablesOf(dbPath), "editorial_jobs");

    const result = yield* runRepairEditorialMigrations(dbPath, mergedManifest);
    assert.deepStrictEqual(result.movedMarkers, [{ name: "EditorialManualWork", from: 9, to: 10 }]);
    assert.deepStrictEqual(result.removedMarkers, [10]);
    assert.deepStrictEqual(result.executedMigrations, [
      "9_EditorialJobs",
      "10_EditorialManualWork",
    ]);
    // The backup is the database as it was, marker 9 = ManualWork included.
    assert.ok(result.backupPath !== null);
    assert.deepStrictEqual((yield* markersOf(result.backupPath)).at(-1), [
      9,
      "EditorialManualWork",
    ]);

    const tables = yield* tablesOf(dbPath);
    for (const table of [
      "editorial_jobs",
      "editorial_nightly_settings",
      "editorial_browser_visits",
    ]) {
      assert.include(tables, table);
    }
    assert.deepStrictEqual(yield* markersOf(dbPath), mergedManifest.manifest);
    const kept = yield* onFile(
      dbPath,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const count = (table: string) =>
          sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`.pipe(
            Effect.map((rows) => rows[0]?.n ?? 0),
          );
        const removed = yield* sql<{ readonly removed_at: string | null }>`
          SELECT removed_at FROM editorial_captures WHERE capture_id = 'c2'
        `;
        return {
          visits: yield* count("editorial_browser_visits"),
          captures: yield* count("editorial_captures"),
          removed: removed[0]?.removed_at,
          decisions: yield* count("editorial_decisions"),
        };
      }),
    );
    assert.deepStrictEqual(kept, { visits: 1, captures: 2, removed: "2026-10-31", decisions: 1 });

    // The merged server starts now, and the repair has nothing left to do.
    assert.deepStrictEqual(yield* onFile(dbPath, mergedManifest.run()), []);
    const again = yield* runRepairEditorialMigrations(dbPath, mergedManifest);
    assert.strictEqual(again.backupPath, null);
  }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(removeDir(dir)));
});
