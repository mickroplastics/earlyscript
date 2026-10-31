import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// When the operator accepted, for each feed they added, private analysis without republication
// and the site's terms. Feeds added before this column have none. Checks the column first.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(editorial_rss_feeds)`;
  if (columns.some((column) => column.name === "acknowledged_at")) return;
  yield* sql`ALTER TABLE editorial_rss_feeds ADD COLUMN acknowledged_at TEXT`;
});
