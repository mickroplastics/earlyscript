import * as Effect from "effect/Effect";

import { EditorialManualBaselineService } from "./EditorialManualBaselineService.ts";

/**
 * The shape of the operator's real log of 1 to 14 October 2026 (19 rows: 17 blocks and the two
 * missing days at the end, as the original file has them), with the same minutes, modes,
 * outcomes and sources. The notes are replaced by neutral markers so tests can follow them.
 */
export const BASELINE_FIXTURE_CSV = [
  "fecha,bloque,inicio,fin,min_busqueda,min_escritura,min_total_sin_separar,modo,resultado,fuente_senal,interrupciones,observaciones",
  "2026-10-01,1,07:30,09:10,65,35,,reconstruido,ficha escrita,Hacker News,0,NOTA-01",
  "2026-10-01,2,20:00,21:00,60,0,,reconstruido,idea descartada,GitHub,0,NOTA-02",
  "2026-10-02,1,08:00,10:30,50,100,,reconstruido,guion borrador,Hacker News,1,NOTA-03",
  '2026-10-03,1,10:00,11:15,75,0,,reconstruido,idea descartada,X,0,"NOTA-04, con coma"',
  "2026-10-05,1,07:00,09:30,90,60,,reconstruido,ficha escrita,GitHub,0,NOTA-05",
  "2026-10-05,2,19:30,20:30,,,60,reconstruido,ficha revisada,Hacker News,0,NOTA-06",
  "2026-10-06,1,08:00,11:00,40,140,,reconstruido,guion terminado,Hacker News,0,NOTA-07",
  "2026-10-07,1,07:30,08:45,75,0,,reconstruido,idea descartada,X,0,NOTA-08",
  "2026-10-08,1,07:15,09:40,80,65,,cronometrado,ficha escrita,Hacker News,0,",
  "2026-10-08,2,21:00,21:45,45,0,,cronometrado,idea descartada,GitHub,0,NOTA-10",
  "2026-10-09,1,08:00,10:50,55,115,,cronometrado,guion borrador,Hacker News,2,NOTA-11",
  "2026-10-11,1,16:00,17:30,90,0,,cronometrado,idea en espera,X,0,NOTA-12",
  "2026-10-12,1,07:00,09:45,35,130,,cronometrado,guion borrador,GitHub,0,NOTA-13",
  "2026-10-12,2,20:00,20:50,50,0,,cronometrado,idea descartada,Hacker News,0,",
  "2026-10-13,1,07:30,10:30,70,110,,cronometrado,guion terminado,Hacker News,1,NOTA-15",
  "2026-10-13,2,19:00,,40,,,cronometrado,ficha revisada,GitHub,0,NOTA-16",
  "2026-10-14,1,08:00,09:20,80,0,,cronometrado,idea descartada,X,0,",
  "2026-10-04,,,,,,,sin registro,,,,NOTA-FALTA-04",
  "2026-10-10,,,,,,,sin registro,,,,NOTA-FALTA-10",
  "",
].join("\n");

/** Imports the fixture log through the service, as the Results page does. */
export const seedBaselineFixture = Effect.gen(function* () {
  const baseline = yield* EditorialManualBaselineService;
  return yield* baseline.importCsv(BASELINE_FIXTURE_CSV);
});
