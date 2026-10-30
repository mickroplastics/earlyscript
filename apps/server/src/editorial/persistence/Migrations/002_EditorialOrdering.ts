import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Additive columns only; 001 stays as applied.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Cutoff of the run recorded in seen_run_id. markRead only moves seen_* forward
  // in this order, so a late request for an older run cannot make the current one
  // look new again. Run ids are opaque and never compared.
  yield* sql`
    ALTER TABLE editorial_trend_inbox ADD COLUMN seen_run_cutoff_at TEXT
  `;

  // A pause begins at ended_at. Stopping or deciding while paused records when
  // the pause ended here, so the summary keeps its length without growing.
  yield* sql`
    ALTER TABLE editorial_work_intervals ADD COLUMN pause_ended_at TEXT
  `;
});
