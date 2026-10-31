import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Which reading of the run files produced each indexed run (IMPORT_INTERPRETATION_VERSION in
// EditorialImportService.ts). Rows indexed before this column existed were read by version 1:
// Earlywindow's dossier/1 only, with competition ranks. The importer reads such a run again
// even when its files did not change. Checks the column first, so it can run again.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(editorial_runs)`;
  if (columns.some((column) => column.name === "interpretation_version")) return;
  yield* sql`
    ALTER TABLE editorial_runs
    ADD COLUMN interpretation_version INTEGER NOT NULL DEFAULT 1
  `;
});
