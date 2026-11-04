import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The operator's hand-kept log of the manual process: an import replaces both tables whole.
// A day of the range without blocks is a missing day, stored apart, never a zero.
// Replayable: it only creates what does not exist yet, so a merge may renumber it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_manual_baseline_blocks (
      fecha TEXT NOT NULL CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
      bloque INTEGER NOT NULL CHECK (bloque >= 1),
      inicio TEXT CHECK (inicio IS NULL OR inicio GLOB '[0-2][0-9]:[0-5][0-9]'),
      fin TEXT CHECK (fin IS NULL OR fin GLOB '[0-2][0-9]:[0-5][0-9]'),
      min_busqueda INTEGER CHECK (min_busqueda IS NULL OR min_busqueda BETWEEN 0 AND 1440),
      min_escritura INTEGER CHECK (min_escritura IS NULL OR min_escritura BETWEEN 0 AND 1440),
      min_total_sin_separar INTEGER
        CHECK (min_total_sin_separar IS NULL OR min_total_sin_separar BETWEEN 0 AND 1440),
      modo TEXT NOT NULL CHECK (modo IN ('reconstruido', 'cronometrado')),
      resultado TEXT NOT NULL,
      fuente_senal TEXT,
      interrupciones INTEGER CHECK (interrupciones IS NULL OR interrupciones >= 0),
      observaciones TEXT,
      source_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      actor TEXT NOT NULL,
      PRIMARY KEY (fecha, bloque)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS editorial_manual_baseline_missing_days (
      fecha TEXT PRIMARY KEY
        CHECK (fecha GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
      observaciones TEXT,
      source_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      actor TEXT NOT NULL
    )
  `;
});
