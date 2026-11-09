import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The engine configuration file the nightly run starts from (`editorial.activeEngineConfig`),
// one row per explicit choice of the operator, never edited: the latest row is the active one
// and an empty table means the engine's engine.v1.json. Replayable: it only creates what is
// missing and seeds nothing, so a merge may renumber it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_engine_config_choices (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      config_file TEXT NOT NULL,
      config_sha256 TEXT NOT NULL,
      previous_file TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
