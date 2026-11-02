import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The monthly cap on drafted trend presentations (Settings › Editorial and the first-run
// wizard): at most one row, absent until the operator saves one (EDITORIAL_DRAFT_BUDGET_DEFAULT
// applies). The month's count comes from `editorial_presentations`. Replayable: it only
// creates what does not exist yet, so a merge may give it another number.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_draft_budget (
      budget_id INTEGER PRIMARY KEY CHECK (budget_id = 1),
      monthly_limit INTEGER NOT NULL CHECK (monthly_limit >= 0),
      updated_at TEXT NOT NULL
    )
  `;

  // The month's count reads drafts by request time.
  yield* sql`
    CREATE INDEX IF NOT EXISTS editorial_presentations_by_requested_at
    ON editorial_presentations (requested_at)
  `;
});
