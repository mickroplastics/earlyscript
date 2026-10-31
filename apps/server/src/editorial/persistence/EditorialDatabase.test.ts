// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as EditorialDatabase from "./EditorialDatabase.ts";
import { applyOnly, layerAt, makeTempDir, removeDir } from "./EditorialDatabase.testkit.ts";
import {
  checkEditorialMigrationContinuity,
  EDITORIAL_MIGRATIONS_TABLE,
  editorialMigrationManifest,
  runEditorialMigrations,
} from "./Migrations.ts";
import Migration0001 from "./Migrations/001_EditorialFoundation.ts";
import Migration0002 from "./Migrations/002_EditorialOrdering.ts";
import Migration0003 from "./Migrations/003_EditorialScriptHead.ts";
import Migration0004 from "./Migrations/004_EditorialRuns.ts";

const EXPECTED_TABLES = [
  "editorial_captures",
  "editorial_decisions",
  "editorial_events",
  "editorial_script_versions",
  "editorial_trend_inbox",
  "editorial_video_results",
  "editorial_video_threads",
  "editorial_work_intervals",
];

/** Every table and index with its SQL, to compare an upgraded file with a new one. */
const schemaOf = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly type: string; readonly name: string; readonly sql: string }>`
      SELECT type, name, sql FROM sqlite_schema
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

const inspect = Effect.gen(function* () {
  const sql = yield* EditorialDatabase.EditorialSql;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name
  `;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(EDITORIAL_MIGRATIONS_TABLE)} ORDER BY migration_id
  `;
  const [journal] = yield* sql<{ readonly journal_mode: string }>`PRAGMA journal_mode`;
  const [foreignKeys] = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
  return {
    tables: tables.map((row) => row.name),
    history: history.map((row) => [row.migration_id, row.name] as const),
    journalMode: journal?.journal_mode,
    foreignKeys: foreignKeys?.foreign_keys,
  };
});

describe("editorial migration continuity", () => {
  it("rejects a manifest with a hole, such as [1, 2, 4]", () => {
    const gap = checkEditorialMigrationContinuity([1, 2, 4], []);
    assert.isTrue(Option.isSome(gap));
    assert.strictEqual(Option.getOrThrow(gap).reason, "manifest-gap");
    assert.deepStrictEqual(Option.getOrThrow(gap).ids, [3]);
    assert.strictEqual(
      Option.getOrThrow(checkEditorialMigrationContinuity([2, 1], [])).reason,
      "manifest-gap",
    );
  });

  it("rejects a registered id below the latest applied one that never ran", () => {
    const gap = Option.getOrThrow(checkEditorialMigrationContinuity([1, 2, 3, 4], [1, 2, 4]));
    assert.strictEqual(gap.reason, "unapplied-below-latest");
    assert.deepStrictEqual(gap.ids, [3]);
    assert.include(gap.message, "repair-editorial-migrations.ts");
    for (const applied of [[], [1, 2], [1, 2, 3], [1, 2, 3, 4]]) {
      assert.isTrue(Option.isNone(checkEditorialMigrationContinuity([1, 2, 3, 4], applied)));
    }
  });

  it("registers the editorial manifest as 1..n", () => {
    assert.isTrue(
      Option.isNone(
        checkEditorialMigrationContinuity(
          editorialMigrationManifest.map(([id]) => id),
          [],
        ),
      ),
    );
  });

  it.effect("does not open a database that applied [1, 2, 4]", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
    return Effect.gen(function* () {
      yield* applyOnly(dbPath, [1, 2, 4]);
      const error = yield* Layer.build(
        EditorialDatabase.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ).pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(error._tag, "EditorialMigrationGapError");
      assert.ok(error._tag === "EditorialMigrationGapError");
      assert.strictEqual(error.reason, "unapplied-below-latest");
      assert.deepStrictEqual(error.ids, [3]);
    }).pipe(Effect.ensuring(removeDir(dir)));
  });

  it.effect("upgrades a database with [1, 2, 3] to the schema of a new one", () => {
    const dir = makeTempDir();
    const upgraded = NodePath.join(dir, "upgraded.sqlite");
    const fresh = NodePath.join(dir, "fresh.sqlite");
    return Effect.gen(function* () {
      yield* applyOnly(upgraded, [1, 2, 3]);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO editorial_events (
            seq, type, aggregate_kind, aggregate_id, operation_id, actor, payload_json, created_at
          )
          VALUES (7, 'trend.read', 'trend', 'sig_a', 'op-7', 'operator', '{}', '2026-10-30')
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: upgraded })));

      const history = yield* inspect.pipe(
        Effect.provide(
          EditorialDatabase.layerFromPath(upgraded).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      assert.deepStrictEqual(history.history, editorialMigrationManifest);
      yield* inspect.pipe(
        Effect.provide(
          EditorialDatabase.layerFromPath(fresh).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      assert.deepStrictEqual(yield* schemaOf(upgraded), yield* schemaOf(fresh));

      const events = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ readonly seq: number; readonly actor_session_id: string | null }>`
          SELECT seq, actor_session_id FROM editorial_events
        `;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: upgraded })));
      assert.deepStrictEqual(events, [{ seq: 7, actor_session_id: null }]);
    }).pipe(Effect.ensuring(removeDir(dir)));
  });

  it.effect("runs 004 again over its own result without changing the schema", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, "again.sqlite");
    return Effect.gen(function* () {
      yield* applyOnly(dbPath, [1, 2, 3, 4]);
      const before = yield* schemaOf(dbPath);
      yield* Migration0004.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      assert.deepStrictEqual(yield* schemaOf(dbPath), before);
    }).pipe(Effect.ensuring(removeDir(dir)));
  });
});

describe("EditorialDatabase", () => {
  it.effect("creates the editorial schema in its own file and reopens it unchanged", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
    const database = EditorialDatabase.layerFromPath(dbPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const first = yield* inspect.pipe(Effect.provide(database));
      for (const table of EXPECTED_TABLES) assert.include(first.tables, table);
      assert.include(first.tables, EDITORIAL_MIGRATIONS_TABLE);
      // T3's migration history must never appear in the editorial file.
      assert.notInclude(first.tables, "effect_sql_migrations");
      assert.deepStrictEqual(first.history, editorialMigrationManifest);
      assert.strictEqual(first.journalMode, "wal");
      assert.strictEqual(first.foreignKeys, 1);

      // A second process start runs the migrator again over the same file.
      const second = yield* inspect.pipe(Effect.provide(database));
      assert.deepStrictEqual(second, first);
    }).pipe(Effect.ensuring(removeDir(dir)));
  });

  it.effect("runs the migrator twice on one connection without applying anything again", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
    return Effect.gen(function* () {
      const sql = yield* EditorialDatabase.EditorialSql;
      const again = yield* runEditorialMigrations().pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      assert.deepStrictEqual(again, []);
    }).pipe(
      Effect.provide(
        EditorialDatabase.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.ensuring(removeDir(dir)),
    );
  });

  it.effect("003 makes the newest version saved before it the script head", () => {
    const dir = makeTempDir();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0001;
      yield* Migration0002;
      for (const thread of ["thread-a", "thread-b"]) {
        yield* sql`
          INSERT INTO editorial_video_threads (
            thread_id, environment_id, operation_id, mode, created_by, created_at
          )
          VALUES (${thread}, 'env-1', ${`op-${thread}`}, 'assisted', 'operator', '2026-10-30T00:00:00.000Z')
        `;
      }
      for (const [id, hash, savedAt] of [
        ["v1", "hash-old", "2026-10-30T01:00:00.000Z"],
        ["v2", "hash-new", "2026-10-30T02:00:00.000Z"],
      ] as const) {
        yield* sql`
          INSERT INTO editorial_script_versions (
            version_id, thread_id, content_hash, snapshot, actor, saved_at
          )
          VALUES (${id}, 'thread-a', ${hash}, 'text', 'operator', ${savedAt})
        `;
      }
      yield* Migration0003;
      const heads = yield* sql<{
        readonly thread_id: string;
        readonly script_head_hash: string | null;
      }>`
        SELECT thread_id, script_head_hash FROM editorial_video_threads ORDER BY thread_id
      `;
      assert.deepStrictEqual(
        heads.map((row) => [row.thread_id, row.script_head_hash]),
        [
          ["thread-a", "hash-new"],
          ["thread-b", null],
        ],
      );
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename: NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME),
        }),
      ),
      Effect.ensuring(removeDir(dir)),
    );
  });

  it.effect("does not publish its client as the global SqlClient", () => {
    const dir = makeTempDir();
    return Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* Effect.serviceOption(SqlClient.SqlClient)));
      assert.isTrue(Option.isSome(yield* Effect.serviceOption(EditorialDatabase.EditorialSql)));
    }).pipe(
      Effect.provide(layerAt(NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME))),
      Effect.ensuring(removeDir(dir)),
    );
  });
});
