import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Run index for the importer. Number 004: 003 belongs to the video thread unit.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per run directory the importer read. The files stay the source of the
  // dossier content; this table is the index the inbox and the event log refer to.
  yield* sql`
    CREATE TABLE editorial_runs (
      run_id TEXT PRIMARY KEY,
      cutoff_at TEXT NOT NULL,
      finished_at TEXT,
      engine_status TEXT NOT NULL,
      run_schema_version TEXT,
      engine_version TEXT,
      config_version TEXT,
      config_hash TEXT,
      corpus_hash TEXT,
      corpus_used_hash TEXT,
      logical_hash TEXT,
      sources_json TEXT NOT NULL,
      coverage_json TEXT NOT NULL,
      artifact_path TEXT NOT NULL,
      artifact_version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dossier_count INTEGER NOT NULL CHECK (dossier_count >= 0),
      import_state TEXT NOT NULL CHECK (import_state IN ('imported', 'partial')),
      skipped_files_json TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX editorial_runs_cutoff_idx ON editorial_runs(cutoff_at, finished_at)
  `;

  // Dossier index per run, with the stable trend identity and the metrics the
  // importer compares when a snoozed trend waits for growth.
  yield* sql`
    CREATE TABLE editorial_dossiers (
      run_id TEXT NOT NULL REFERENCES editorial_runs(run_id) ON DELETE CASCADE,
      dossier_id TEXT NOT NULL,
      trend_key TEXT NOT NULL,
      trend_key_rule TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      items_7d INTEGER NOT NULL,
      items_28d INTEGER NOT NULL,
      authors_7d INTEGER NOT NULL,
      score REAL NOT NULL,
      growth REAL,
      affinity REAL,
      volume_rank INTEGER NOT NULL,
      score_rank INTEGER NOT NULL,
      last_activity_day TEXT,
      PRIMARY KEY (run_id, dossier_id)
    )
  `;
  yield* sql`
    CREATE INDEX editorial_dossiers_trend_idx ON editorial_dossiers(trend_key, run_id)
  `;

  // SQLite cannot widen a CHECK in place: rebuild editorial_events so runs are an
  // aggregate, and record the authenticated session behind each human event.
  yield* sql`
    CREATE TABLE editorial_events_next (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      aggregate_kind TEXT NOT NULL CHECK (aggregate_kind IN ('trend', 'video_thread', 'run')),
      aggregate_id TEXT NOT NULL,
      operation_id TEXT,
      actor TEXT NOT NULL,
      actor_session_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO editorial_events_next (
      seq, type, aggregate_kind, aggregate_id, operation_id, actor, payload_json, created_at
    )
    SELECT seq, type, aggregate_kind, aggregate_id, operation_id, actor, payload_json, created_at
    FROM editorial_events
    ORDER BY seq
  `;
  yield* sql`DROP TABLE editorial_events`;
  yield* sql`ALTER TABLE editorial_events_next RENAME TO editorial_events`;
  yield* sql`
    CREATE INDEX editorial_events_aggregate_idx
    ON editorial_events(aggregate_kind, aggregate_id, seq)
  `;
  yield* sql`
    CREATE UNIQUE INDEX editorial_events_operation_idx
    ON editorial_events(operation_id)
    WHERE operation_id IS NOT NULL
  `;
});
