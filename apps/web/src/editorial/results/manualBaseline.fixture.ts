import type {
  EditorialBaselineBlock,
  EditorialBaselineGroup,
  EditorialBaselineRecord,
  EditorialDurationStats,
} from "@t3tools/contracts";

const MINUTE = 60_000;

const stats = (n: number, median: number, q1: number, q3: number): EditorialDurationStats => ({
  n,
  medianMs: median * MINUTE,
  q1Ms: q1 * MINUTE,
  q3Ms: q3 * MINUTE,
  minMs: q1 * MINUTE,
  maxMs: q3 * MINUTE,
});

const block = (
  fecha: string,
  bloque: number,
  modo: EditorialBaselineBlock["modo"],
  minBusqueda: number | null,
  minEscritura: number | null,
  extra: Partial<EditorialBaselineBlock> = {},
): EditorialBaselineBlock => ({
  fecha,
  bloque,
  inicio: "07:00",
  fin: "09:00",
  minBusqueda,
  minEscritura,
  minTotalSinSeparar: null,
  minTotal: minBusqueda !== null && minEscritura !== null ? minBusqueda + minEscritura : null,
  modo,
  resultado: "ficha escrita",
  fuente: "Hacker News",
  interrupciones: 0,
  observaciones: null,
  ...extra,
});

const group = (
  key: EditorialBaselineGroup["key"],
  values: Partial<EditorialBaselineGroup>,
): EditorialBaselineGroup => ({
  key,
  blocks: 0,
  daysRecorded: 0,
  search: stats(0, 0, 0, 0),
  writing: stats(0, 0, 0, 0),
  writingNonZero: stats(0, 0, 0, 0),
  total: stats(0, 0, 0, 0),
  searchMinutes: 0,
  writingMinutes: 0,
  completeMinutes: 0,
  knownMinutes: 0,
  incompleteBlocks: 0,
  interruptions: 0,
  blocksWithInterruptions: 0,
  outcomes: [
    { resultado: "idea descartada", blocks: 6 },
    { resultado: "idea en espera", blocks: 1 },
    { resultado: "ficha escrita", blocks: 3 },
    { resultado: "ficha revisada", blocks: 2 },
    { resultado: "guion borrador", blocks: 3 },
    { resultado: "guion terminado", blocks: 2 },
  ],
  ...values,
});

/** A shortened October log: the figures of its groups are the server's for the real one. */
export const BASELINE_RECORD: EditorialBaselineRecord = {
  provenance: {
    sourceHash: "16a403a9745c8dbf3f94736d6535bf5d25a62a3bbab021a505b90bb67ead28dd",
    importedAt: "2026-11-04T12:00:00.000Z",
    actor: "operator",
    from: "2026-10-01",
    to: "2026-10-14",
  },
  blocks: [
    block("2026-10-01", 1, "reconstruido", 65, 35, { observaciones: "Desde el historial." }),
    block("2026-10-05", 2, "reconstruido", null, null, {
      minTotalSinSeparar: 60,
      minTotal: 60,
      resultado: "ficha revisada",
    }),
    block("2026-10-08", 1, "cronometrado", 80, 65),
    block("2026-10-13", 2, "cronometrado", 40, null, { fin: null, resultado: "ficha revisada" }),
  ],
  missingDays: [
    { fecha: "2026-10-04", observaciones: "Sin nota fiable." },
    { fecha: "2026-10-10", observaciones: null },
  ],
  groups: [
    group("cronometrado", {
      blocks: 9,
      daysRecorded: 6,
      search: stats(9, 55, 45, 80),
      writing: stats(8, 32.5, 0, 111.25),
      writingNonZero: stats(4, 112.5, 102.5, 118.75),
      interruptions: 3,
      blocksWithInterruptions: 2,
    }),
    group("reconstruido", {
      blocks: 8,
      daysRecorded: 6,
      search: stats(7, 65, 55, 75),
      writingNonZero: stats(4, 80, 53.75, 110),
    }),
    group("conjunto", {
      blocks: 17,
      daysRecorded: 12,
      search: stats(16, 62.5, 48.75, 76.25),
      writingNonZero: stats(8, 105, 63.75, 117.5),
      interruptions: 4,
      blocksWithInterruptions: 3,
    }),
  ],
  weeks: [
    {
      from: "2026-10-01",
      to: "2026-10-07",
      days: 7,
      daysRecorded: 6,
      daysMissing: 1,
      blocks: 8,
      modes: ["reconstruido"],
      completeMinutes: 850,
      knownMinutes: 850,
      incompleteBlocks: 0,
    },
    {
      from: "2026-10-08",
      to: "2026-10-14",
      days: 7,
      daysRecorded: 6,
      daysMissing: 1,
      blocks: 9,
      modes: ["cronometrado"],
      completeMinutes: 925,
      knownMinutes: 965,
      incompleteBlocks: 1,
    },
  ],
  excludedByDomain: 0,
};

export const EMPTY_BASELINE: EditorialBaselineRecord = {
  provenance: null,
  blocks: [],
  missingDays: [],
  groups: [],
  weeks: [],
  excludedByDomain: 0,
};
