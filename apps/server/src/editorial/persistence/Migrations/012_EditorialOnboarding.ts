import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The first-run wizard's decisions: one row per step the operator accepted, with the server
// time and version, and one row each time the four steps were finished. Rows are never updated
// or deleted by the wizard. Replayable: it only creates what does not exist yet, so a merge
// may give it another number.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_onboarding_acceptances (
      id TEXT PRIMARY KEY,
      step TEXT NOT NULL CHECK (step IN ('datos', 'proveedores', 'estudio', 'motor')),
      accepted_at TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      app_version TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS editorial_onboarding_acceptances_at
    ON editorial_onboarding_acceptances (accepted_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_onboarding_completions (
      id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      app_version TEXT NOT NULL
    )
  `;
});
