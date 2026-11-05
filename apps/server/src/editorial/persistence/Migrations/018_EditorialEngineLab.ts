import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine lab (engine MCP): immutable candidate manifests, operator campaigns with their
// budget, evaluation jobs, their one accepted report, promotion requests and the active
// engine pointer with its append-only history. Replayable: every statement checks the shape
// it creates, so a merge may give it another number.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_manifests (
      manifest_hash TEXT PRIMARY KEY,
      manifest_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('installed', 'config', 'code')),
      parent_hash TEXT,
      manifest_json TEXT NOT NULL,
      files_json TEXT NOT NULL,
      project_id TEXT,
      author_thread_id TEXT,
      intent TEXT,
      hypothesis TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS editorial_engine_manifests_key
    ON editorial_engine_manifests (project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `;
  // A candidate never changes: changing it is creating a child.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS editorial_engine_manifests_immutable
    BEFORE UPDATE ON editorial_engine_manifests
    BEGIN SELECT RAISE(ABORT, 'engine manifests are immutable'); END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS editorial_engine_manifests_kept
    BEFORE DELETE ON editorial_engine_manifests
    BEGIN SELECT RAISE(ABORT, 'engine manifests are kept'); END
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_campaigns (
      campaign_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('development', 'shadow')),
      reference_hash TEXT NOT NULL REFERENCES editorial_engine_manifests (manifest_hash),
      request_id TEXT,
      policy_json TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      budget INTEGER NOT NULL CHECK (budget >= 0),
      status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_jobs (
      job_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES editorial_engine_campaigns (campaign_id),
      kind TEXT NOT NULL CHECK (kind IN ('development', 'shadow')),
      candidate_hash TEXT NOT NULL REFERENCES editorial_engine_manifests (manifest_hash),
      reference_hash TEXT NOT NULL REFERENCES editorial_engine_manifests (manifest_hash),
      thread_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      executor TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      secret TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      pid INTEGER,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      error_code TEXT,
      error_message TEXT,
      report_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    )
  `;

  // One seat of a campaign's budget: every attempt stays, failed or cancelled ones included.
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_attempts (
      attempt_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES editorial_engine_campaigns (campaign_id),
      candidate_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      thread_id TEXT,
      job_id TEXT NOT NULL UNIQUE REFERENCES editorial_engine_jobs (job_id),
      created_at TEXT NOT NULL,
      UNIQUE (campaign_id, idempotency_key),
      UNIQUE (campaign_id, candidate_hash)
    )
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS editorial_engine_attempts_kept
    BEFORE DELETE ON editorial_engine_attempts
    BEGIN SELECT RAISE(ABORT, 'engine lab attempts are kept'); END
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_job_events (
      job_id TEXT NOT NULL REFERENCES editorial_engine_jobs (job_id),
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      PRIMARY KEY (job_id, seq)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_reports (
      report_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE REFERENCES editorial_engine_jobs (job_id),
      kind TEXT NOT NULL CHECK (kind IN ('development', 'shadow')),
      report_json TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS editorial_engine_reports_immutable
    BEFORE UPDATE ON editorial_engine_reports
    BEGIN SELECT RAISE(ABORT, 'engine lab reports are immutable'); END
  `;

  // A shadow report's blind labels and the gate they gave; the latest one counts.
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_gates (
      gate_id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES editorial_engine_reports (report_id),
      labels_hash TEXT NOT NULL,
      verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'inconclusive')),
      gate_json TEXT NOT NULL,
      recorded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_promotions (
      request_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      candidate_hash TEXT NOT NULL REFERENCES editorial_engine_manifests (manifest_hash),
      report_id TEXT NOT NULL REFERENCES editorial_engine_reports (report_id),
      expected_active_hash TEXT NOT NULL,
      reason TEXT NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'stale')),
      decided_by TEXT,
      decision_reason TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL
    )
  `;

  // The only row the nightly plan reads: which manifest is active.
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_active (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      manifest_hash TEXT NOT NULL REFERENCES editorial_engine_manifests (manifest_hash),
      activation_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_activations (
      activation_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('install', 'promote', 'revert')),
      manifest_hash TEXT NOT NULL REFERENCES editorial_engine_manifests (manifest_hash),
      previous_hash TEXT,
      request_id TEXT,
      report_id TEXT,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS editorial_engine_activations_immutable
    BEFORE UPDATE ON editorial_engine_activations
    BEGIN SELECT RAISE(ABORT, 'engine activations are append-only'); END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS editorial_engine_activations_kept
    BEFORE DELETE ON editorial_engine_activations
    BEGIN SELECT RAISE(ABORT, 'engine activations are append-only'); END
  `;
});
