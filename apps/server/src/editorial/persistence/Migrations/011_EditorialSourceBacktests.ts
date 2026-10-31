import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The backtest recorded for each source (`record-source-backtest`): what the settings show next
// to it. `editorial_source_settings.backtest_run_id` keeps naming it. Replayable: it only
// creates a table that does not exist yet, so a merge may give it another number.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_source_backtests (
      source TEXT PRIMARY KEY,
      backtest_id TEXT NOT NULL,
      logical_hash TEXT NOT NULL,
      experiment_at TEXT NOT NULL,
      cutoff_from TEXT NOT NULL,
      cutoff_to TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('final', 'provisional')),
      verdict TEXT NOT NULL CHECK (verdict IN ('not-worse', 'worse')),
      complete_cutoffs INTEGER NOT NULL CHECK (complete_cutoffs >= 0),
      partial_cutoffs INTEGER NOT NULL CHECK (partial_cutoffs >= 0),
      p5_baseline REAL,
      p5_candidate REAL,
      lead_baseline REAL,
      lead_candidate REAL,
      partial_p5_baseline REAL,
      partial_p5_candidate REAL,
      allow_provisional INTEGER NOT NULL CHECK (allow_provisional IN (0, 1)),
      recorded_at TEXT NOT NULL
    )
  `;
});
