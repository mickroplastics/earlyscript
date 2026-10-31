import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Assistant-written title and summary per dossier. Each generation is a row: regenerating
// adds a revision and keeps the previous one. Provenance (provider, model, prompt version,
// input hash) sits next to the text, never inside the engine's dossier.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_presentations (
      presentation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      dossier_id TEXT NOT NULL,
      trend_key TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      prompt_version TEXT,
      provider TEXT,
      model TEXT,
      title TEXT,
      what_happened TEXT,
      why_it_matters TEXT,
      video_angle TEXT,
      cited_item_ids_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      requested_at TEXT NOT NULL,
      generated_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
      error TEXT,
      CHECK (
        status <> 'ready'
        OR (
          title IS NOT NULL AND what_happened IS NOT NULL AND why_it_matters IS NOT NULL
          AND video_angle IS NOT NULL AND provider IS NOT NULL AND model IS NOT NULL
          AND prompt_version IS NOT NULL AND generated_at IS NOT NULL
        )
      ),
      UNIQUE (run_id, dossier_id, input_hash, revision)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS editorial_presentations_by_dossier
    ON editorial_presentations (run_id, dossier_id, status, revision)
  `;
});
