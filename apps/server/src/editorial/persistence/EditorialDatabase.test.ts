// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as EditorialDatabase from "./EditorialDatabase.ts";
import { layerAt, makeTempDir, removeDir } from "./EditorialDatabase.testkit.ts";
import {
  EDITORIAL_MIGRATIONS_TABLE,
  editorialMigrationManifest,
  runEditorialMigrations,
} from "./Migrations.ts";

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
