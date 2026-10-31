#!/usr/bin/env node

// Development repair for an editorial.sqlite the server refuses: a gap ([1, 2, 4]) or a marker
// under another migration's number after a merge renumbered it. Backs it up, moves and removes
// markers, and migrates again, applying the skipped migration for real. Never deletes rows.
//   node apps/server/scripts/repair-editorial-migrations.ts --db <path>/editorial.sqlite

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import {
  editorialMigrations,
  type EditorialMigrations,
} from "../src/editorial/persistence/Migrations.ts";

export class RepairEditorialDbMissingError extends Schema.TaggedError<RepairEditorialDbMissingError>()(
  "RepairEditorialDbMissingError",
  { databasePath: Schema.String },
) {
  override get message(): string {
    return `No editorial database at '${this.databasePath}'.`;
  }
}

export interface RepairEditorialMigrationsResult {
  readonly databasePath: string;
  /** Null when there was nothing to repair and the file was left untouched. */
  readonly backupPath: string | null;
  /** Markers moved to the id the manifest gives their name. */
  readonly movedMarkers: ReadonlyArray<{
    readonly name: string;
    readonly from: number;
    readonly to: number;
  }>;
  readonly removedMarkers: ReadonlyArray<number>;
  readonly executedMigrations: ReadonlyArray<string>;
}

export const runRepairEditorialMigrations = Effect.fn("runRepairEditorialMigrations")(function* (
  databasePath: string,
  migrations: EditorialMigrations = editorialMigrations,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(databasePath);
  if (!(yield* fs.exists(resolved))) {
    return yield* new RepairEditorialDbMissingError({ databasePath: resolved });
  }
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    if (Option.isNone(yield* migrations.findProblem())) {
      return {
        databasePath: resolved,
        backupPath: null,
        movedMarkers: [],
        removedMarkers: [],
        executedMigrations: [],
      } satisfies RepairEditorialMigrationsResult;
    }
    // The backup holds the file as it was before any marker is removed.
    const backupPath = `${resolved}.before-repair-${yield* Clock.currentTimeMillis}.sqlite`;
    yield* sql`VACUUM INTO ${backupPath}`;
    const { movedMarkers, removedMarkers } = yield* sql.withTransaction(
      Effect.gen(function* () {
        const movedMarkers = yield* migrations.repairRenumbered();
        const removedMarkers = yield* migrations.repairGap();
        return { movedMarkers, removedMarkers };
      }),
    );
    // Applies the skipped migration and replays the removed ones; startup checks pass after.
    const executed = yield* migrations.run();
    return {
      databasePath: resolved,
      backupPath,
      movedMarkers,
      removedMarkers,
      executedMigrations: executed.map(([id, name]) => `${id}_${name}`),
    } satisfies RepairEditorialMigrationsResult;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: resolved })));
});

const repairEditorialMigrationsCommand = Command.make(
  "repair-editorial-migrations",
  {
    db: Flag.String("db").pipe(Flag.withDescription("Path of the editorial.sqlite to repair.")),
  },
  ({ db }) =>
    Effect.gen(function* () {
      const result = yield* runRepairEditorialMigrations(db);
      if (result.backupPath === null) {
        yield* Console.log(`Nothing to repair in ${result.databasePath}.`);
        return;
      }
      yield* Console.log(`Backup: ${result.backupPath}`);
      for (const move of result.movedMarkers) {
        yield* Console.log(`Marker moved: ${move.name} ${move.from} -> ${move.to}`);
      }
      yield* Console.log(`Markers removed: ${result.removedMarkers.join(", ")}`);
      yield* Console.log(`Migrations applied: ${result.executedMigrations.join(", ")}`);
    }),
).pipe(
  Command.withDescription(
    "Back up an editorial.sqlite with a migration gap or a renumbered migration, move and remove markers, and migrate again.",
  ),
);

if (import.meta.main) {
  Command.run(repairEditorialMigrationsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
