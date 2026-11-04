import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Who opened each clock segment: the operator choosing its stage by hand ('manual') or the
// thread flow ('auto'), so an automatic change never overrides a manual choice. Older segments
// keep NULL and protect nothing. Checks the column first, so it may run again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(editorial_work_intervals)`;
  if (!columns.some((column) => column.name === "source")) {
    yield* sql`
      ALTER TABLE editorial_work_intervals
      ADD COLUMN source TEXT CHECK (source IN ('manual', 'auto'))
    `;
  }
});
