import {
  EditorialRunId,
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
  readonly cutoff_at: string;
  readonly finished_at: string | null;
  readonly engine_status: string;
  readonly config_version: string | null;
  readonly sources_json: string;
  readonly artifact_path: string;
  readonly artifact_version: string;
  readonly content_hash: string;
  readonly dossier_count: number;
}

export interface DossierRow {
  readonly run_id: string;
  readonly dossier_id: string;
  readonly trend_key: string;
  readonly items_7d: number;
  readonly items_28d: number;
  readonly authors_7d: number;
  readonly score: number;
  readonly last_activity_day: string | null;
}

/** Newest first. A run the engine did not finish ("failed") is listed but never the default. */
const RUN_ORDER = "cutoff_at DESC, COALESCE(finished_at, '') DESC, run_id DESC";

export const selectRuns = (sql: SqlClient.SqlClient) =>
  sql<RunRow>`
    SELECT run_id, cutoff_at, finished_at, engine_status, config_version, sources_json,
      artifact_path, artifact_version, content_hash, dossier_count
    FROM editorial_runs
    ORDER BY ${sql.literal(RUN_ORDER)}
  `;

export const selectRun = (sql: SqlClient.SqlClient, runId: string) =>
  sql<RunRow>`
    SELECT run_id, cutoff_at, finished_at, engine_status, config_version, sources_json,
      artifact_path, artifact_version, content_hash, dossier_count
    FROM editorial_runs
    WHERE run_id = ${runId}
  `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

/** The run the inbox shows by default: the newest finished run, else the newest of any status. */
export const selectLatestRun = (sql: SqlClient.SqlClient) =>
  sql<RunRow>`
    SELECT run_id, cutoff_at, finished_at, engine_status, config_version, sources_json,
      artifact_path, artifact_version, content_hash, dossier_count
    FROM editorial_runs
    ORDER BY CASE WHEN engine_status = 'ok' THEN 0 ELSE 1 END, ${sql.literal(RUN_ORDER)}
    LIMIT 1
  `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

const DOSSIER_COLUMNS =
  "run_id, dossier_id, trend_key, items_7d, items_28d, authors_7d, score, last_activity_day";

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

export const runSummaryOf = (row: RunRow): EditorialRunSummary => ({
  runId: EditorialRunId.make(row.run_id),
  cutoffAt: row.cutoff_at,
  finishedAt: row.finished_at,
  status: row.engine_status,
  configVersion: row.config_version,
  sources: decodeSources(row.sources_json),
  dossierCount: row.dossier_count,
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
