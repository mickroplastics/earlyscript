import type { EditorialReadError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialRunDirectory, type InvalidRunDirectory, type LoadedRun } from "./RunDirectory.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import {
  appendEvent,
  EditorialEventLog,
  findOperationEvent,
} from "./persistence/EditorialEventLog.ts";
import { type EditorialPersistenceError, toPersistenceError } from "./persistence/Errors.ts";
import { nowIso, parseIso } from "./persistence/support.ts";
import { selectLatestRun, selectTrendDossier, snoozeMetricValue } from "./runIndex.ts";

/** How often the server looks for new or changed run directories. */
export const IMPORT_POLL_INTERVAL = Duration.seconds(30);

const MAX_INBOX_KEYS_PER_READ = 500;

export type ImportOutcome = "imported" | "updated" | "unchanged" | "skipped" | "invalid";

export interface RunImport {
  readonly runId: string;
  readonly outcome: ImportOutcome;
}

export interface SnoozeReturn {
  readonly trendKey: string;
  readonly cause: "growth" | "expired";
}

export interface SyncReport {
  readonly runs: ReadonlyArray<RunImport>;
  readonly returned: ReadonlyArray<SnoozeReturn>;
}

type SyncError = EditorialReadError | EditorialPersistenceError;

/**
 * Indexes the engine's run directories into editorial_runs and editorial_dossiers, then
 * returns snoozed trends whose condition the latest run meets. System actor only: it never
 * reads, dismisses or links a trend for the operator.
 */
export class EditorialImportService extends Context.Service<
  EditorialImportService,
  {
    /**
     * Imports every run directory whose files changed since the last import, oldest cutoff
     * first, and evaluates snoozes. Serialized: concurrent calls run one after another.
     */
    readonly sync: Effect.Effect<SyncReport, SyncError>;
  }
>()("t3/editorial/EditorialImportService") {}

interface IndexedVersion {
  readonly run_id: string;
  readonly artifact_version: string;
  readonly artifact_path: string;
  readonly content_hash: string | null;
  readonly import_state: "imported" | "partial" | "invalid";
  readonly skipped_files_json: string;
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const INDEXED_COLUMNS =
  "run_id, artifact_version, artifact_path, content_hash, import_state, skipped_files_json";

const coverageOf = (loaded: LoadedRun): unknown =>
  loaded.entry.run.coverage ?? loaded.dossiers[0]?.file.coverage ?? null;

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const eventLog = yield* EditorialEventLog;
  const commands = yield* EditorialCommandService;
  const directory = yield* EditorialRunDirectory;
  const permit = yield* Semaphore.make(1);

  const importLoaded = Effect.fn("EditorialImportService.importLoaded")(function* (
    loaded: LoadedRun,
  ) {
    const run = loaded.entry.run;
    const cutoffAt = parseIso(run.cutoff_at);
    if (Option.isNone(cutoffAt)) {
      yield* Effect.logWarning("editorial: skipping run with an invalid cutoff", {
        runId: run.run_id,
        cutoffAt: run.cutoff_at,
      });
      return "skipped" as const;
    }
    const finishedAt = Option.getOrNull(parseIso(run.finished_at ?? ""));
    return yield* eventLog.transact(
      "editorial.importRun",
      Effect.gen(function* () {
        const at = yield* nowIso;
        const existing = yield* sql<IndexedVersion>`
          SELECT ${sql.literal(INDEXED_COLUMNS)} FROM editorial_runs WHERE run_id = ${run.run_id}
        `.pipe(Effect.map((rows) => rows[0]));
        // A placeholder left while this directory's run.json did not decode, under the folder
        // name: the run now has its own row.
        yield* sql`
          DELETE FROM editorial_runs
          WHERE artifact_path = ${loaded.entry.directory} AND import_state = 'invalid'
            AND content_hash IS NULL AND run_id <> ${run.run_id}
        `;
        // Same content under new mtimes (a copy, a touch): record where it is, nothing else.
        // The hash covers the skipped files, so a partial run that is fixed is not unchanged.
        if (
          existing !== undefined &&
          existing.content_hash === loaded.contentHash &&
          existing.import_state !== "invalid"
        ) {
          yield* sql`
            UPDATE editorial_runs
            SET artifact_version = ${loaded.entry.version},
              artifact_path = ${loaded.entry.directory}, updated_at = ${at}
            WHERE run_id = ${run.run_id}
          `;
          return { result: "unchanged" as const, events: [] };
        }
        const importState = loaded.skippedFiles.length === 0 ? "imported" : "partial";
        const payload = {
          cutoffAt: cutoffAt.value,
          dossierCount: loaded.dossiers.length,
          importState,
          skippedFiles: loaded.skippedFiles,
          contentHash: loaded.contentHash,
          previousContentHash: existing?.content_hash ?? null,
          previousImportState: existing?.import_state ?? null,
          logicalHash: run.logical_hash ?? null,
        };
        yield* sql`
          INSERT INTO editorial_runs (
            run_id, cutoff_at, finished_at, engine_status, run_schema_version, engine_version,
            config_version, config_hash, corpus_hash, corpus_used_hash, logical_hash,
            sources_json, coverage_json, artifact_path, artifact_version, content_hash,
            dossier_count, import_state, skipped_files_json, imported_at, updated_at
          )
          VALUES (
            ${run.run_id}, ${cutoffAt.value}, ${finishedAt}, ${run.status ?? "unknown"},
            ${run.schema_version ?? null}, ${run.engine_version ?? null},
            ${run.config_version ?? null}, ${run.config_hash ?? null},
            ${run.corpus_hash ?? run.corpus?.corpus_manifest_hash ?? null},
            ${run.corpus?.corpus_used_hash ?? null}, ${run.logical_hash ?? null},
            ${encodeJson(run.sources ?? [])}, ${encodeJson(coverageOf(loaded))},
            ${loaded.entry.directory}, ${loaded.entry.version}, ${loaded.contentHash},
            ${loaded.dossiers.length}, ${importState}, ${encodeJson(loaded.skippedFiles)},
            ${at}, ${at}
          )
          ON CONFLICT (run_id) DO UPDATE SET
            cutoff_at = excluded.cutoff_at, finished_at = excluded.finished_at,
            engine_status = excluded.engine_status,
            run_schema_version = excluded.run_schema_version,
            engine_version = excluded.engine_version, config_version = excluded.config_version,
            config_hash = excluded.config_hash, corpus_hash = excluded.corpus_hash,
            corpus_used_hash = excluded.corpus_used_hash, logical_hash = excluded.logical_hash,
            sources_json = excluded.sources_json, coverage_json = excluded.coverage_json,
            artifact_path = excluded.artifact_path,
            artifact_version = excluded.artifact_version, content_hash = excluded.content_hash,
            dossier_count = excluded.dossier_count, import_state = excluded.import_state,
            skipped_files_json = excluded.skipped_files_json, updated_at = excluded.updated_at
        `;
        yield* sql`DELETE FROM editorial_dossiers WHERE run_id = ${run.run_id}`;
        for (const dossier of loaded.dossiers) {
          const summary = dossier.summary;
          yield* sql`
            INSERT INTO editorial_dossiers (
              run_id, dossier_id, trend_key, trend_key_rule, file_path, content_hash, label,
              items_7d, items_28d, authors_7d, score, growth, affinity, volume_rank, score_rank,
              last_activity_day
            )
            VALUES (
              ${run.run_id}, ${summary.dossierId}, ${dossier.trendKey.key},
              ${dossier.trendKey.rule}, ${dossier.filePath}, ${dossier.contentHash},
              ${summary.label}, ${summary.items7d}, ${summary.items28d}, ${summary.authors7d},
              ${summary.score}, ${summary.growth}, ${summary.affinity}, ${summary.volumeRank},
              ${summary.scoreRank}, ${dossier.lastActivityDay}
            )
            ON CONFLICT (run_id, dossier_id) DO NOTHING
          `;
        }
        // A placeholder of an invalid directory was never announced as imported.
        if (existing !== undefined && existing.content_hash !== null) {
          // Every change of the content in force is announced, a return to an earlier hash
          // included: clients holding the previous content need a new snapshot.
          const updated = yield* appendEvent(sql, {
            type: "run.updated",
            aggregateKind: "run",
            aggregateId: run.run_id,
            actor: "system",
            payload,
            createdAt: at,
          });
          return { result: "updated" as const, events: [updated] };
        }
        // A run new to the index is announced once per content: an index rebuilt from the
        // same files appends nothing.
        const operationId = `run.imported:${run.run_id}:${loaded.contentHash}`;
        const announced = yield* findOperationEvent(sql, operationId);
        const events = Option.isSome(announced)
          ? []
          : [
              yield* appendEvent(sql, {
                type: "run.imported",
                aggregateKind: "run",
                aggregateId: run.run_id,
                operationId,
                actor: "system",
                payload,
                createdAt: at,
              }),
            ];
        return { result: "imported" as const, events };
      }),
    );
  });

  // run.json does not decode. A run indexed from this directory keeps its metadata and is
  // marked invalid; a directory never indexed gets a row under its folder name, with no
  // cutoff and no hashes. Either way the inbox no longer offers it.
  const importInvalid = Effect.fn("EditorialImportService.importInvalid")(function* (
    invalid: InvalidRunDirectory,
    known: IndexedVersion | undefined,
  ) {
    const skippedFiles = encodeJson([{ file: "run.json", reason: invalid.reason }]);
    return yield* eventLog.transact(
      "editorial.invalidRun",
      Effect.gen(function* () {
        const at = yield* nowIso;
        // Still invalid for the same reason (a touch): record the version, nothing else.
        if (known?.import_state === "invalid" && known.skipped_files_json === skippedFiles) {
          yield* sql`
            UPDATE editorial_runs SET artifact_version = ${invalid.version}, updated_at = ${at}
            WHERE run_id = ${known.run_id}
          `;
          return { result: "unchanged" as const, events: [] };
        }
        let runId = known?.run_id;
        if (runId === undefined) {
          const inserted = yield* sql<{ readonly run_id: string }>`
            INSERT INTO editorial_runs (
              run_id, cutoff_at, finished_at, engine_status, sources_json, coverage_json,
              artifact_path, artifact_version, content_hash, dossier_count, import_state,
              skipped_files_json, imported_at, updated_at
            )
            VALUES (
              ${invalid.name}, NULL, NULL, 'unknown', '[]', 'null', ${invalid.directory},
              ${invalid.version}, NULL, 0, 'invalid', ${skippedFiles}, ${at}, ${at}
            )
            ON CONFLICT (run_id) DO NOTHING
            RETURNING run_id
          `;
          if (inserted.length === 0) {
            // Another directory holds a run with this id: do not touch its row.
            yield* Effect.logWarning("editorial: invalid run directory shares a run id", {
              directory: invalid.directory,
              runId: invalid.name,
            });
            return { result: "skipped" as const, events: [] };
          }
          runId = invalid.name;
        } else {
          yield* sql`
            UPDATE editorial_runs
            SET import_state = 'invalid', skipped_files_json = ${skippedFiles},
              artifact_version = ${invalid.version}, updated_at = ${at}
            WHERE run_id = ${runId}
          `;
        }
        const event = yield* appendEvent(sql, {
          type: "run.invalidated",
          aggregateKind: "run",
          aggregateId: runId,
          actor: "system",
          payload: {
            directory: invalid.name,
            reason: invalid.reason,
            previousImportState: known?.import_state ?? null,
            contentHash: known?.content_hash ?? null,
          },
          createdAt: at,
        });
        return { result: "invalid" as const, events: [event] };
      }),
    );
  });

  // Expired snoozes return whatever the run; growth returns compare the latest run with the
  // condition recorded at snooze time (metric >= atLeast).
  const returnSnoozed = Effect.fn("EditorialImportService.returnSnoozed")(function* () {
    const keys = yield* sql<{ readonly trend_key: string }>`
      SELECT trend_key FROM editorial_trend_inbox WHERE snoozed_at IS NOT NULL ORDER BY trend_key
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.trend_key)),
      Effect.mapError(toPersistenceError("editorial.listSnoozed")),
    );
    if (keys.length === 0) return [];
    const latest = yield* selectLatestRun(sql).pipe(
      Effect.mapError(toPersistenceError("editorial.latestRun")),
    );
    const now = yield* Clock.currentTimeMillis;
    const returned: Array<SnoozeReturn> = [];
    for (let start = 0; start < keys.length; start += MAX_INBOX_KEYS_PER_READ) {
      const states = yield* commands
        .getInboxState(keys.slice(start, start + MAX_INBOX_KEYS_PER_READ))
        .pipe(Effect.mapError(toPersistenceError("editorial.getInboxState")));
      for (const state of states) {
        if (state.snoozedUntil !== null && Date.parse(state.snoozedUntil) <= now) {
          yield* commands
            .unsnooze({ trendKey: state.trendKey, cause: "expired", actor: "system" })
            .pipe(Effect.mapError(toPersistenceError("editorial.unsnooze")));
          returned.push({ trendKey: state.trendKey, cause: "expired" });
          continue;
        }
        const condition = state.snoozeReturn;
        if (condition === null || Option.isNone(latest)) continue;
        const dossier = yield* selectTrendDossier(sql, latest.value.run_id, state.trendKey).pipe(
          Effect.mapError(toPersistenceError("editorial.trendDossier")),
        );
        if (Option.isNone(dossier)) continue;
        const value = snoozeMetricValue(dossier.value, condition.metric);
        if (value === null || value < condition.atLeast) continue;
        yield* commands
          .unsnooze({
            trendKey: state.trendKey,
            cause: "growth",
            actor: "system",
            observed: { runId: latest.value.run_id, metric: condition.metric, value },
          })
          .pipe(Effect.mapError(toPersistenceError("editorial.unsnooze")));
        returned.push({ trendKey: state.trendKey, cause: "growth" });
      }
    }
    return returned;
  });

  const sync = Effect.gen(function* () {
    const rows = yield* sql<IndexedVersion>`
      SELECT ${sql.literal(INDEXED_COLUMNS)} FROM editorial_runs
    `.pipe(Effect.mapError(toPersistenceError("editorial.indexedRuns")));
    const indexed = new Map(rows.map((row) => [row.run_id, row]));
    const byPath = new Map(rows.map((row) => [row.artifact_path, row]));
    const { entries, invalid } = yield* directory.scan;
    const runs: Array<RunImport> = [];
    for (const item of invalid) {
      const known = byPath.get(item.directory);
      if (known?.import_state === "invalid" && known.artifact_version === item.version) continue;
      runs.push({ runId: known?.run_id ?? item.name, outcome: yield* importInvalid(item, known) });
    }
    // Oldest first, so run.imported events follow cutoff order.
    for (const entry of entries.toReversed()) {
      const known = indexed.get(entry.run.run_id);
      if (
        known !== undefined &&
        known.artifact_version === entry.version &&
        known.artifact_path === entry.directory
      ) {
        continue;
      }
      const loaded = yield* directory.load(entry);
      runs.push({ runId: entry.run.run_id, outcome: yield* importLoaded(loaded) });
    }
    const returned = yield* returnSnoozed();
    return { runs, returned };
  }).pipe(permit.withPermits(1), Effect.withSpan("EditorialImportService.sync"));

  return EditorialImportService.of({ sync });
});

export const layer = Layer.effect(EditorialImportService, make);

/**
 * Imports at startup and then every IMPORT_POLL_INTERVAL, in a fiber scoped to the server.
 * A failed pass is logged and retried on the next tick; it never stops the server.
 */
export const layerWatch = Layer.effectDiscard(
  Effect.gen(function* () {
    const importer = yield* EditorialImportService;
    const pass = importer.sync.pipe(
      Effect.tap((report) =>
        report.runs.length === 0 && report.returned.length === 0
          ? Effect.void
          : Effect.logInfo("editorial: runs imported").pipe(
              Effect.annotateLogs({
                runs: report.runs.map((run) => `${run.runId}:${run.outcome}`),
                returned: report.returned.map((item) => `${item.trendKey}:${item.cause}`),
              }),
            ),
      ),
      Effect.catch((cause) => Effect.logWarning("editorial: import pass failed", { cause })),
    );
    yield* Effect.forkScoped(pass.pipe(Effect.repeat(Schedule.spaced(IMPORT_POLL_INTERVAL))));
  }),
);
