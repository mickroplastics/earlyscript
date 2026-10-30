import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Additive column only; 001 and 002 stay as applied.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Content hash of the latest saved script version. Versions are content
  // addressed, so saving older text again moves the head back to its existing
  // snapshot; a decision must reference the head, never an older version.
  yield* sql`
    ALTER TABLE editorial_video_threads ADD COLUMN script_head_hash TEXT
  `;
  // Versions saved before this column existed: the newest one is the head.
  yield* sql`
    UPDATE editorial_video_threads
    SET script_head_hash = (
      SELECT content_hash FROM editorial_script_versions AS version
      WHERE version.thread_id = editorial_video_threads.thread_id
      ORDER BY version.saved_at DESC, version.rowid DESC
      LIMIT 1
    )
  `;
});
