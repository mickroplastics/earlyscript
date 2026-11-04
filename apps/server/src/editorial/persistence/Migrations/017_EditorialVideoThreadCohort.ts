import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(editorial_video_threads)`;
  if (!columns.some((column) => column.name === "cohort")) {
    yield* sql`ALTER TABLE editorial_video_threads ADD COLUMN cohort TEXT NOT NULL DEFAULT 'human' CHECK (cohort IN ('human', 'trial'))`;
  }
});
