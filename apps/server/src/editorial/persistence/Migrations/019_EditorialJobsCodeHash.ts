import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A nightly job is keyed by the code it runs too: an approved code manifest runs its artifact,
// and the same profile, cutoff and configuration with other code is another job. `code_hash`
// is empty for the installed engine, so every job before the engine lab keeps its key.
// Replayable: it rebuilds the table only while the column is missing.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(editorial_jobs)`;
  if (columns.some((column) => column.name === "code_hash")) return;

  yield* sql`
    CREATE TABLE editorial_jobs_with_code (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('daily')),
      profile_hash TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      code_hash TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      lease_owner TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      engine_token TEXT,
      engine_pid INTEGER,
      engine_started_at TEXT,
      prev_engine_token TEXT,
      prev_engine_pid INTEGER,
      accepted_run_id TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
      error TEXT,
      artifacts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (kind, profile_hash, cutoff_at, config_hash, code_hash)
    )
  `;
  yield* sql`
    INSERT INTO editorial_jobs_with_code (
      job_id, kind, profile_hash, cutoff_at, config_hash, code_hash, timezone, scheduled_for,
      started_at, finished_at, attempt, lease_until, lease_owner, lease_generation, engine_token,
      engine_pid, engine_started_at, prev_engine_token, prev_engine_pid, accepted_run_id, status,
      error, artifacts_json, created_at
    )
    SELECT
      job_id, kind, profile_hash, cutoff_at, config_hash, '', timezone, scheduled_for,
      started_at, finished_at, attempt, lease_until, lease_owner, lease_generation, engine_token,
      engine_pid, engine_started_at, prev_engine_token, prev_engine_pid, accepted_run_id, status,
      error, artifacts_json, created_at
    FROM editorial_jobs
  `;
  yield* sql`DROP TABLE editorial_jobs`;
  yield* sql`ALTER TABLE editorial_jobs_with_code RENAME TO editorial_jobs`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS editorial_jobs_due ON editorial_jobs (status, scheduled_for)
  `;
});
