import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Per source, whether captures collect it and whether the engine ranks with it; a source with
// no row keeps the catalog default. `backtest_run_id` names the backtest that let the source
// into the engine. The operator's RSS feeds, and the engine's default feeds they excluded.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_source_settings (
      source TEXT PRIMARY KEY,
      collect INTEGER NOT NULL CHECK (collect IN (0, 1)),
      rank INTEGER NOT NULL CHECK (rank IN (0, 1)),
      backtest_run_id TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_rss_feeds (
      feed_url TEXT PRIMARY KEY,
      feed_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      site_url TEXT,
      note TEXT,
      added_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_rss_default_exclusions (
      feed_id TEXT PRIMARY KEY,
      excluded_at TEXT NOT NULL
    )
  `;
});
