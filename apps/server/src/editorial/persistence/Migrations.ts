import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";

import Migration0001 from "./Migrations/001_EditorialFoundation.ts";
import Migration0002 from "./Migrations/002_EditorialOrdering.ts";
// 003 is the video thread unit's. The Migrator skips ids below the latest applied one,
// so 003 must be merged before 004 reaches a real database.
import Migration0004 from "./Migrations/004_EditorialRuns.ts";

// Same registration mechanism as persistence/Migrations.ts, with its own
// numbering: these ids live in editorial.sqlite and never collide with T3's.
// Never renumber an applied migration; add a new entry instead.
const migrationEntries = [
  [1, "EditorialFoundation", Migration0001],
  [2, "EditorialOrdering", Migration0002],
  [4, "EditorialRuns", Migration0004],
] as const;

export const editorialMigrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

/** A table name of its own, so a misrouted client never reads T3's history as ours. */
export const EDITORIAL_MIGRATIONS_TABLE = "editorial_sql_migrations";

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

export const runEditorialMigrations = Effect.fn("runEditorialMigrations")(function* () {
  const executed = yield* run({ loader, table: EDITORIAL_MIGRATIONS_TABLE });
  const migrations = executed.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Editorial database schema is current")
    : Effect.log("Editorial migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executed;
});
