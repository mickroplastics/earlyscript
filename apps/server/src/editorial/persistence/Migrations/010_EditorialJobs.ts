import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The nightly run's jobs and the operator's time of day. Every executor write requires the
// claim's lease_owner and lease_generation. engine_* names the claim's engine child before it
// starts; a claim copies the former one into prev_engine_* so the new owner waits for it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('daily')),
      profile_hash TEXT NOT NULL,
      cutoff_at TEXT NOT NULL,
      config_hash TEXT NOT NULL,
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
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
      error TEXT,
      artifacts_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (kind, profile_hash, cutoff_at, config_hash)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS editorial_jobs_due ON editorial_jobs (status, scheduled_for)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_nightly_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      time_of_day TEXT NOT NULL,
      timezone TEXT NOT NULL,
      workers INTEGER NOT NULL CHECK (workers >= 1),
      enabled_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
