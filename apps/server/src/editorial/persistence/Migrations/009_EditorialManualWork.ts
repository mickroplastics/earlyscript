import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Manual mode: a capture can leave the operator's list (the row stays, with when it left), and
// the pages the integrated browser loaded in a manual thread are kept, with their tab, time
// and the runtime that reported them. Checks what it creates first, so it may run again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(editorial_captures)`;
  if (!columns.some((column) => column.name === "removed_at")) {
    yield* sql`ALTER TABLE editorial_captures ADD COLUMN removed_at TEXT`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_browser_visits (
      visit_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES editorial_video_threads(thread_id),
      tab_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('desktop', 'server', 'automation')),
      visited_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS editorial_browser_visits_thread_idx
    ON editorial_browser_visits(thread_id, visited_at)
  `;
});
