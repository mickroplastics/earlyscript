import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
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
import Migration0009 from "./Migrations/009_EditorialManualWork.ts";
import Migration0010 from "./Migrations/010_EditorialJobs.ts";
import Migration0011 from "./Migrations/011_EditorialSourceBacktests.ts";
import Migration0012 from "./Migrations/012_EditorialOnboarding.ts";
import Migration0013 from "./Migrations/013_EditorialDraftBudget.ts";
import Migration0014 from "./Migrations/014_EditorialProfile.ts";
import Migration0015 from "./Migrations/015_EditorialManualBaseline.ts";
import Migration0016 from "./Migrations/016_EditorialWorkIntervalSource.ts";

import Migration0017 from "./Migrations/017_EditorialVideoThreadCohort.ts";
import Migration0018 from "./Migrations/018_EditorialEngineLab.ts";
import Migration0019 from "./Migrations/019_EditorialJobsCodeHash.ts";
import Migration0020 from "./Migrations/020_EditorialEngineConfigChoice.ts";

// Own numbering in editorial.sqlite, never colliding with T3's. Never renumber an
// applied migration. Ids are 1..n: the Migrator skips ids at or below the latest
// applied one, so checkEditorialMigrationContinuity refuses a hole at startup.
export const editorialMigrationEntries: ReadonlyArray<EditorialMigrationEntry> = [
  [1, "EditorialFoundation", Migration0001],
  [2, "EditorialOrdering", Migration0002],
  [3, "EditorialScriptHead", Migration0003],
  [4, "EditorialRuns", Migration0004],
  [5, "EditorialPresentations", Migration0005],
  [6, "EditorialImportInterpretation", Migration0006],
  [7, "EditorialSourceSettings", Migration0007],
  [8, "EditorialRssFeedAcknowledgement", Migration0008],
  [9, "EditorialManualWork", Migration0009],
  [10, "EditorialJobs", Migration0010],
  [11, "EditorialSourceBacktests", Migration0011],
  [12, "EditorialOnboarding", Migration0012],
  [13, "EditorialDraftBudget", Migration0013],
  [14, "EditorialProfile", Migration0014],
  [15, "EditorialManualBaseline", Migration0015],
  [16, "EditorialWorkIntervalSource", Migration0016],
  [17, "EditorialVideoThreadCohort", Migration0017],
  [18, "EditorialEngineLab", Migration0018],
  [19, "EditorialJobsCodeHash", Migration0019],
  [20, "EditorialEngineConfigChoice", Migration0020],
];

export const editorialMigrationManifest = editorialMigrationEntries.map(
  ([id, name]) => [id, name] as const,
);

/**
 * Migrations that check the shape they create and may run again over their own result. Only
 * these may lose their marker in a repair. By name, not id: a migration keeps its name when a
 * merge moves it to another number.
 */
const REPLAYABLE_MIGRATION_NAMES: ReadonlySet<string> = new Set([
  "EditorialRuns",
  "EditorialRssFeedAcknowledgement",
  "EditorialManualWork",
  "EditorialSourceBacktests",
  "EditorialOnboarding",
  "EditorialDraftBudget",
  "EditorialProfile",
  "EditorialManualBaseline",
  "EditorialWorkIntervalSource",
  "EditorialVideoThreadCohort",
  "EditorialEngineLab",
  "EditorialJobsCodeHash",
  "EditorialEngineConfigChoice",
]);

/** A table name of its own, so a misrouted client never reads T3's history as ours. */
export const EDITORIAL_MIGRATIONS_TABLE = "editorial_sql_migrations";

const REPAIR_COMMAND = "node apps/server/scripts/repair-editorial-migrations.ts --db <path>";

/** One registered migration: its id, its name in the marker table, and its effect. */
export type EditorialMigrationEntry = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<void, SqlError, SqlClient.SqlClient>,
];

/** A marker the database holds: the id and name the Migrator wrote when it applied it. */
export interface AppliedEditorialMigration {
  readonly id: number;
  readonly name: string;
}

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

/**
 * Each applied marker must carry the name the manifest gives its id. Ids alone are not enough:
 * a database that applied another branch's migration under the same number passes the
 * continuity check, and the Migrator then skips the migration the manifest has there.
 */
function checkEditorialMigrationIdentity(
  manifest: ReadonlyArray<readonly [number, string]>,
  applied: ReadonlyArray<AppliedEditorialMigration>,
): Option.Option<EditorialMigrationGapError> {
  const names = new Map(manifest);
  const mismatched = applied.filter((marker) => {
    const expected = names.get(marker.id);
    return expected !== undefined && expected !== marker.name;
  });
  if (mismatched.length === 0) return Option.none();
  const described = mismatched
    .map(
      (marker) =>
        `${marker.id} = «${marker.name}» (el manifiesto registra «${names.get(marker.id)}»)`,
    )
    .join("; ");
  return Option.some(
    new EditorialMigrationGapError({
      reason: "name-mismatch",
      ids: mismatched.map((marker) => marker.id),
      detail:
        `La base editorial aplicó otra migración con el mismo número: ${described}. ` +
        "El servidor no arranca para no saltarse la migración que falta. Con el servidor " +
        `detenido, ejecuta ${REPAIR_COMMAND}: respalda la base, mueve cada marcador a su ` +
        "número actual y aplica de verdad la migración saltada, sin tocar los datos.",
    }),
  );
}

const readApplied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type = 'table' AND name = ${EDITORIAL_MIGRATIONS_TABLE}
  `;
  if ((table[0]?.count ?? 0) === 0) return [];
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM ${sql(EDITORIAL_MIGRATIONS_TABLE)} ORDER BY migration_id
  `;
  return rows.map((row): AppliedEditorialMigration => ({ id: row.migration_id, name: row.name }));
});

const migrate = Migrator.make({});

/**
 * Startup, check and repair over one manifest. The server uses the registered one; tests pass
 * another to rehearse a merge that moves a migration to another number.
 */
export const makeEditorialMigrations = (entries: ReadonlyArray<EditorialMigrationEntry>) => {
  const manifest = entries.map(([id, name]) => [id, name] as const);
  const manifestIds = manifest.map(([id]) => id);
  const idOfName = new Map(manifest.map(([id, name]) => [name, id] as const));
  const loader = Migrator.fromRecord(
    Object.fromEntries(entries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
  );

  /** The first problem that stops startup: a marker under the wrong name, then a gap. */
  const findProblem = Effect.fn("findEditorialMigrationProblem")(function* () {
    const applied = yield* readApplied;
    const identity = checkEditorialMigrationIdentity(manifest, applied);
    if (Option.isSome(identity)) return identity;
    return checkEditorialMigrationContinuity(
      manifestIds,
      applied.map((marker) => marker.id),
    );
  });

  const run = Effect.fn("runEditorialMigrations")(function* () {
    const problem = yield* findProblem();
    if (Option.isSome(problem)) return yield* problem.value;
    const executed = yield* migrate({ loader, table: EDITORIAL_MIGRATIONS_TABLE });
    const migrations = executed.map(([id, name]) => `${id}_${name}`);
    yield* migrations.length === 0
      ? Effect.logDebug("Editorial database schema is current")
      : Effect.log("Editorial migrations ran successfully").pipe(
          Effect.annotateLogs({ migrations }),
        );
    return executed;
  });

  /**
   * Development repair, never run at startup: moves each marker whose name the manifest
   * registers under another id to that id (a branch migration renumbered by a merge), so the
   * gap repair then sees the migration that was skipped. Refuses a name the manifest does not
   * know and a target id another marker already holds. Returns the moves.
   */
  const repairRenumbered = Effect.fn("repairEditorialMigrationNames")(function* () {
    const sql = yield* SqlClient.SqlClient;
    const applied = yield* readApplied;
    const names = new Map(manifest);
    const mismatched = applied.filter((marker) => names.get(marker.id) !== marker.name);
    if (mismatched.length === 0) return [];
    const moves = mismatched.map((marker) => ({ ...marker, to: idOfName.get(marker.name) }));
    const unknown = moves.filter((move) => move.to === undefined);
    if (unknown.length > 0) {
      return yield* new EditorialMigrationGapError({
        reason: "not-replayable",
        ids: unknown.map((move) => move.id),
        detail: `No migration of the manifest is named ${unknown.map((move) => move.name).join(", ")}; restore a backup.`,
      });
    }
    const moving = new Set(mismatched.map((marker) => marker.id));
    const taken = moves.filter(
      (move) => applied.some((marker) => marker.id === move.to) && !moving.has(move.to!),
    );
    if (taken.length > 0) {
      return yield* new EditorialMigrationGapError({
        reason: "not-replayable",
        ids: taken.map((move) => move.id),
        detail: "The target id of a renumbered marker is already applied; restore a backup.",
      });
    }
    // Through negative ids, so two markers can trade numbers without a key collision.
    for (const move of moves) {
      yield* sql`
        UPDATE ${sql(EDITORIAL_MIGRATIONS_TABLE)} SET migration_id = ${-move.id}
        WHERE migration_id = ${move.id}
      `;
    }
    for (const move of moves) {
      yield* sql`
        UPDATE ${sql(EDITORIAL_MIGRATIONS_TABLE)} SET migration_id = ${move.to!}
        WHERE migration_id = ${-move.id}
      `;
    }
    return moves.map((move) => ({ name: move.name, from: move.id, to: move.to! }));
  });

  /**
   * Development repair, never run at startup: for a database that applied a migration above an
   * id it never applied (for example [1, 2, 4] before 003 was merged), removes the markers
   * above the lowest missing id so `run` applies everything again in order. Refuses when a
   * marker to remove belongs to a migration that cannot run twice. Returns the removed ids.
   */
  const repairGap = Effect.fn("repairEditorialMigrationGap")(function* () {
    const sql = yield* SqlClient.SqlClient;
    const applied = yield* readApplied;
    const appliedIds = applied.map((marker) => marker.id);
    const latest = Math.max(...appliedIds, 0);
    const firstMissing = manifestIds.find((id) => id < latest && !appliedIds.includes(id));
    if (firstMissing === undefined) return [];
    const removed = applied.filter((marker) => marker.id > firstMissing);
    const unsafe = removed.filter((marker) => !REPLAYABLE_MIGRATION_NAMES.has(marker.name));
    if (unsafe.length > 0) {
      return yield* new EditorialMigrationGapError({
        reason: "not-replayable",
        ids: unsafe.map((marker) => marker.id),
        detail: `Migration ${firstMissing} is missing, but these cannot run twice; restore a backup.`,
      });
    }
    const removedIds = removed.map((marker) => marker.id);
    yield* sql`
      DELETE FROM ${sql(EDITORIAL_MIGRATIONS_TABLE)} WHERE migration_id IN ${sql.in(removedIds)}
    `;
    return removedIds;
  });

  return { manifest, findProblem, run, repairRenumbered, repairGap };
};

export type EditorialMigrations = ReturnType<typeof makeEditorialMigrations>;

/** The registered manifest, as the server runs it. */
export const editorialMigrations = makeEditorialMigrations(editorialMigrationEntries);

export const runEditorialMigrations = editorialMigrations.run;
