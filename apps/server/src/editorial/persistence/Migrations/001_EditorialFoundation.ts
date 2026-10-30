import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Runs against editorial.sqlite only, never against statev2.sqlite. Thread ids
// here refer to T3 threads in the other database, so they are logical links
// without foreign keys: a thread may be archived, deleted or never created.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Durable sequence for sync and audit. Every editorial mutation appends its
  // event in the same transaction; subscribers read after commit.
  yield* sql`
    CREATE TABLE editorial_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      aggregate_kind TEXT NOT NULL CHECK (aggregate_kind IN ('trend', 'video_thread')),
      aggregate_id TEXT NOT NULL,
      operation_id TEXT,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX editorial_events_aggregate_idx
    ON editorial_events(aggregate_kind, aggregate_id, seq)
  `;
  // An operation id is recorded on the one event that carries the operation,
  // so a retried command finds it and does not apply twice.
  yield* sql`
    CREATE UNIQUE INDEX editorial_events_operation_idx
    ON editorial_events(operation_id)
    WHERE operation_id IS NOT NULL
  `;

  // Inbox state per stable trend identity. Read, snoozed, dismissed and in
  // production are independent columns, not one exclusive status.
  yield* sql`
    CREATE TABLE editorial_trend_inbox (
      trend_key TEXT PRIMARY KEY,
      seen_run_id TEXT,
      seen_dossier_id TEXT,
      seen_at TEXT,
      snoozed_at TEXT,
      snoozed_until TEXT,
      snooze_return_json TEXT,
      dismissed_at TEXT,
      dismissed_reason TEXT,
      production_thread_id TEXT,
      production_linked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (dismissed_at IS NULL OR dismissed_reason IS NOT NULL)
    )
  `;
  yield* sql`
    CREATE INDEX editorial_trend_inbox_production_idx
    ON editorial_trend_inbox(production_thread_id)
    WHERE production_thread_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE editorial_video_threads (
      thread_id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode IN ('assisted', 'manual')),
      trend_key TEXT,
      run_id TEXT,
      dossier_id TEXT,
      dossier_hash TEXT,
      script_path TEXT,
      launch_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (launch_state IN ('pending', 'launched', 'failed')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX editorial_video_threads_trend_idx
    ON editorial_video_threads(trend_key)
    WHERE trend_key IS NOT NULL
  `;

  // One row per working segment. A pause closes the segment and resume opens
  // the next one in the same stage, so durations never include pauses.
  yield* sql`
    CREATE TABLE editorial_work_intervals (
      interval_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES editorial_video_threads(thread_id),
      stage TEXT NOT NULL CHECK (stage IN ('explore', 'read', 'write', 'decide')),
      status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'needs_resolution')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
        CHECK (end_reason IN ('paused', 'stage_changed', 'stopped', 'decided', 'resolved')),
      pause_reason TEXT,
      recovered_at TEXT,
      actor TEXT NOT NULL,
      CHECK ((status = 'closed') = (ended_at IS NOT NULL))
    )
  `;
  yield* sql`
    CREATE INDEX editorial_work_intervals_thread_idx
    ON editorial_work_intervals(thread_id, started_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX editorial_work_intervals_open_idx
    ON editorial_work_intervals(thread_id)
    WHERE status = 'open'
  `;

  yield* sql`
    CREATE TABLE editorial_script_versions (
      version_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES editorial_video_threads(thread_id),
      content_hash TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      script_path TEXT,
      actor TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      UNIQUE (thread_id, content_hash)
    )
  `;
  yield* sql`
    CREATE INDEX editorial_script_versions_thread_idx
    ON editorial_script_versions(thread_id, saved_at)
  `;

  yield* sql`
    CREATE TABLE editorial_decisions (
      decision_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES editorial_video_threads(thread_id),
      action TEXT NOT NULL CHECK (action IN ('accept', 'edit', 'reject')),
      utility INTEGER NOT NULL CHECK (utility BETWEEN 1 AND 5),
      reason TEXT,
      script_version_hash TEXT,
      explore_ms INTEGER,
      read_ms INTEGER,
      write_ms INTEGER,
      decide_ms INTEGER,
      total_ms INTEGER,
      clock_definitive INTEGER NOT NULL CHECK (clock_definitive IN (0, 1)),
      actor TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      FOREIGN KEY (thread_id, script_version_hash)
        REFERENCES editorial_script_versions(thread_id, content_hash)
    )
  `;
  yield* sql`
    CREATE INDEX editorial_decisions_thread_idx
    ON editorial_decisions(thread_id, decided_at)
  `;

  yield* sql`
    CREATE TABLE editorial_captures (
      capture_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES editorial_video_threads(thread_id),
      url TEXT NOT NULL,
      title TEXT,
      note TEXT,
      actor TEXT NOT NULL,
      captured_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX editorial_captures_thread_idx
    ON editorial_captures(thread_id, captured_at)
  `;

  yield* sql`
    CREATE TABLE editorial_video_results (
      result_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES editorial_video_threads(thread_id),
      views INTEGER CHECK (views >= 0),
      subscribers INTEGER CHECK (subscribers >= 0),
      clicks INTEGER CHECK (clicks >= 0),
      comments INTEGER CHECK (comments >= 0),
      observed_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX editorial_video_results_thread_idx
    ON editorial_video_results(thread_id, observed_at)
  `;
});
