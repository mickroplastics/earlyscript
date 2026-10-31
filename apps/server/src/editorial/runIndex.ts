import {
  EditorialRunId,
  EditorialSkippedFile,
  type EditorialRunImportState,
  type EditorialSnoozeMetric,
  type EditorialRunSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

// Queries over editorial_runs and editorial_dossiers (migration 004). The importer writes
// these tables; the read side and the inbox commands only read them.

export interface RunRow {
  readonly run_id: string;
  /** Null only for an invalid run first seen with an unreadable run.json. */
  readonly cutoff_at: string | null;
  readonly finished_at: string | null;
  readonly engine_status: string;
  readonly config_version: string | null;
  readonly sources_json: string;
  readonly artifact_path: string;
  readonly artifact_version: string;
  readonly content_hash: string | null;
  readonly dossier_count: number;
  readonly import_state: EditorialRunImportState;
  readonly skipped_files_json: string;
}

/** A run the inbox can show: its run.json decoded, so the cutoff is known. */
export interface ReadableRunRow extends RunRow {
  readonly cutoff_at: string;
  readonly import_state: "imported" | "partial";
}

export const isReadableRun = (row: RunRow): row is ReadableRunRow =>
  row.import_state !== "invalid" && row.cutoff_at !== null;

export interface DossierRow {
  readonly run_id: string;
  readonly dossier_id: string;
  readonly trend_key: string;
  /** Hash of the dossier file; a video thread records it with the dossier it attaches. */
  readonly content_hash: string;
  readonly items_7d: number;
  readonly items_28d: number;
  readonly authors_7d: number;
  readonly score: number;
  readonly last_activity_day: string | null;
}

/**
 * Newest first. A run the engine did not finish ("failed") is listed but never the default;
 * an invalid run without a cutoff sorts last (SQLite orders NULL lowest).
 */
const RUN_ORDER = "cutoff_at DESC, COALESCE(finished_at, '') DESC, run_id DESC";

const RUN_COLUMNS =
  "run_id, cutoff_at, finished_at, engine_status, config_version, sources_json, " +
  "artifact_path, artifact_version, content_hash, dossier_count, import_state, " +
  "skipped_files_json";

/** Every indexed run, invalid ones included, so the run list can show them with their state. */
export const selectRuns = (sql: SqlClient.SqlClient) =>
  sql<RunRow>`
    SELECT ${sql.literal(RUN_COLUMNS)} FROM editorial_runs ORDER BY ${sql.literal(RUN_ORDER)}
  `;

export const selectRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql<RunRow>`
    SELECT ${sql.literal(RUN_COLUMNS)} FROM editorial_runs WHERE run_id = ${runId}
  `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

/**
 * The run the inbox shows by default: the newest finished run, else the newest of any status.
 * Never an invalid one.
 */
export const selectLatestRun = (sql: SqlClient.SqlClient) =>
  sql<RunRow>`
    SELECT ${sql.literal(RUN_COLUMNS)}
    FROM editorial_runs
    WHERE import_state <> 'invalid' AND cutoff_at IS NOT NULL
    ORDER BY CASE WHEN engine_status = 'ok' THEN 0 ELSE 1 END, ${sql.literal(RUN_ORDER)}
    LIMIT 1
  `.pipe(Effect.map((rows) => Option.filter(Option.fromNullishOr(rows[0]), isReadableRun)));

const DOSSIER_COLUMNS =
  "run_id, dossier_id, trend_key, content_hash, items_7d, items_28d, authors_7d, score, " +
  "last_activity_day";

export const selectRunDossiers = (sql: SqlClient.SqlClient, runId: string) =>
  sql<DossierRow>`
    SELECT ${sql.literal(DOSSIER_COLUMNS)} FROM editorial_dossiers WHERE run_id = ${runId}
  `;

export const selectDossier = (sql: SqlClient.SqlClient, runId: string, dossierId: string) =>
  sql<DossierRow>`
    SELECT ${sql.literal(DOSSIER_COLUMNS)}
    FROM editorial_dossiers
    WHERE run_id = ${runId} AND dossier_id = ${dossierId}
  `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

export const selectTrendDossier = (sql: SqlClient.SqlClient, runId: string, trendKey: string) =>
  sql<DossierRow>`
    SELECT ${sql.literal(DOSSIER_COLUMNS)}
    FROM editorial_dossiers
    WHERE run_id = ${runId} AND trend_key = ${trendKey}
    ORDER BY dossier_id
    LIMIT 1
  `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

const decodeSources = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeSkipped = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(EditorialSkippedFile)),
);

export const runSummaryOf = (row: RunRow): EditorialRunSummary => ({
  runId: EditorialRunId.make(row.run_id),
  cutoffAt: row.cutoff_at,
  finishedAt: row.finished_at,
  status: row.engine_status,
  configVersion: row.config_version,
  sources: decodeSources(row.sources_json),
  dossierCount: row.dossier_count,
  importState: row.import_state,
  skippedFiles: decodeSkipped(row.skipped_files_json),
});

/** The value a snooze condition compares, or null for a metric this index does not keep. */
export function snoozeMetricValue(row: DossierRow, metric: string): number | null {
  switch (metric as EditorialSnoozeMetric) {
    case "items7d":
      return row.items_7d;
    case "authors7d":
      return row.authors_7d;
    case "items28d":
      return row.items_28d;
    case "score":
      return row.score;
    default:
      return null;
  }
}
