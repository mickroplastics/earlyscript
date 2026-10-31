import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";

import { EditorialMigrationGapError } from "./Errors.ts";
import Migration0001 from "./Migrations/001_EditorialFoundation.ts";
import Migration0002 from "./Migrations/002_EditorialOrdering.ts";
import Migration0003 from "./Migrations/003_EditorialScriptHead.ts";
import Migration0004 from "./Migrations/004_EditorialRuns.ts";
import Migration0005 from "./Migrations/005_EditorialPresentations.ts";
import Migration0006 from "./Migrations/006_EditorialImportInterpretation.ts";
import Migration0007 from "./Migrations/007_EditorialSourceSettings.ts";
import Migration0008 from "./Migrations/008_EditorialRssFeedAcknowledgement.ts";
import Migration0009 from "./Migrations/009_EditorialJobs.ts";

// Own numbering in editorial.sqlite, never colliding with T3's. Never renumber an
// applied migration. Ids are 1..n: the Migrator skips ids at or below the latest
// applied one, so checkEditorialMigrationContinuity refuses a hole at startup.
const migrationEntries = [
  [1, "EditorialFoundation", Migration0001],
  [2, "EditorialOrdering", Migration0002],
  [3, "EditorialScriptHead", Migration0003],
  [4, "EditorialRuns", Migration0004],
  [5, "EditorialPresentations", Migration0005],
  [6, "EditorialImportInterpretation", Migration0006],
  [7, "EditorialSourceSettings", Migration0007],
  [8, "EditorialRssFeedAcknowledgement", Migration0008],
  [9, "EditorialJobs", Migration0009],
] as const;

export const editorialMigrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

/**
 * Migrations that check the shape they create and may run again over their own result.
 * Only these may lose their marker in repairEditorialMigrationGap.
 */
const REPLAYABLE_MIGRATION_IDS: ReadonlySet<number> = new Set([4, 8]);

/** A table name of its own, so a misrouted client never reads T3's history as ours. */
export const EDITORIAL_MIGRATIONS_TABLE = "editorial_sql_migrations";

const REPAIR_COMMAND = "node apps/server/scripts/repair-editorial-migrations.ts --db <path>";

const loader = Migrator.fromRecord(
  Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
);

const run = Migrator.make({});

/**
 * The manifest must be 1..n in order, and no registered id below the latest applied one may
 * be missing from the database: the Migrator would skip it for good.
 */
export function checkEditorialMigrationContinuity(
  manifestIds: ReadonlyArray<number>,
  appliedIds: ReadonlyArray<number>,
): Option.Option<EditorialMigrationGapError> {
  const misplaced = manifestIds.filter((id, index) => id !== index + 1);
  if (misplaced.length > 0) {
    const missing = Array.from(
      { length: Math.max(...manifestIds, 0) },
      (_, index) => index + 1,
    ).filter((id) => !manifestIds.includes(id));
    return Option.some(
      new EditorialMigrationGapError({
        reason: "manifest-gap",
        ids: missing.length > 0 ? missing : misplaced,
        detail:
          "The manifest must register ids 1..n in order. A migration from another branch " +
          "goes between its neighbours when the branch is merged.",
      }),
    );
  }
  const latest = Math.max(...appliedIds, 0);
  const skipped = manifestIds.filter((id) => id < latest && !appliedIds.includes(id));
  if (skipped.length > 0) {
    return Option.some(
      new EditorialMigrationGapError({
        reason: "unapplied-below-latest",
        ids: skipped,
        detail:
          `The database already applied migration ${latest}, so the Migrator would never ` +
          `apply these. For a development database, run ${REPAIR_COMMAND}.`,
      }),
    );
  }
  return Option.none();
}

const readAppliedIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'table' AND name = ${EDITORIAL_MIGRATIONS_TABLE}
  `;
  if ((table[0]?.count ?? 0) === 0) return [];
  const rows = yield* sql<{ readonly migration_id: number }>`
    SELECT migration_id FROM ${sql(EDITORIAL_MIGRATIONS_TABLE)} ORDER BY migration_id
  `;
  return rows.map((row) => row.migration_id);
});

const manifestIds = migrationEntries.map(([id]) => id);

/** The continuity check against the database the current SqlClient points at. */
export const findEditorialMigrationGap = Effect.fn("findEditorialMigrationGap")(function* () {
  return checkEditorialMigrationContinuity(manifestIds, yield* readAppliedIds);
});

export const runEditorialMigrations = Effect.fn("runEditorialMigrations")(function* () {
  const gap = yield* findEditorialMigrationGap();
  if (Option.isSome(gap)) return yield* gap.value;
  const executed = yield* run({ loader, table: EDITORIAL_MIGRATIONS_TABLE });
  const migrations = executed.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Editorial database schema is current")
    : Effect.log("Editorial migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executed;
});

/**
 * Development repair, never run at startup: for a database that applied a migration above an
 * id it never applied (for example [1, 2, 4] before 003 was merged), removes the markers above
 * the lowest missing id so runEditorialMigrations applies everything again in order. Refuses
 * when a marker to remove belongs to a migration that cannot run twice. Returns the removed ids.
 */
export const repairEditorialMigrationGap = Effect.fn("repairEditorialMigrationGap")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const applied = yield* readAppliedIds;
  const latest = Math.max(...applied, 0);
  const firstMissing = manifestIds.find((id) => id < latest && !applied.includes(id));
  if (firstMissing === undefined) return [];
  const removed = applied.filter((id) => id > firstMissing);
  const unsafe = removed.filter((id) => !REPLAYABLE_MIGRATION_IDS.has(id));
  if (unsafe.length > 0) {
    return yield* new EditorialMigrationGapError({
      reason: "not-replayable",
      ids: unsafe,
      detail: `Migration ${firstMissing} is missing, but these cannot run twice; restore a backup.`,
    });
  }
  yield* sql`
    DELETE FROM ${sql(EDITORIAL_MIGRATIONS_TABLE)} WHERE migration_id IN ${sql.in(removed)}
  `;
  return removed;
});
