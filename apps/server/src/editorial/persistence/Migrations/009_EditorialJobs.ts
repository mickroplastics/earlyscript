import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The nightly run's durable calendar: one job per profile, cutoff and engine configuration,
// with its lease, attempts, error and artifacts. Each claim takes a new owner and generation;
// every write of the executor requires both, so a former owner can no longer write. The settings row holds the operator's time
// of day; a database without it keeps the nightly run disabled.
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
