import type { EditorialDurationStats, EditorialResultsSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { BASELINE_RECORD, EMPTY_BASELINE } from "./manualBaseline.fixture";
import {
  baselineFigure,
  baselineComparisons,
  baselineNotes,
  baselineStatsText,
  baselineTableRows,
  csvFileProblem,
  daysListText,
  formatMinutes,
  hasBaseline,
  importResultText,
  issueText,
  minutesCell,
  provenanceText,
  rangeText,
  weekMinutesText,
  weekRangeText,
} from "./manualBaseline.logic";

const MINUTE = 60_000;
const stats = (n: number, median: number): EditorialDurationStats => ({
  n,
  medianMs: median * MINUTE,
  q1Ms: median * MINUTE,
  q3Ms: median * MINUTE,
  minMs: median * MINUTE,
  maxMs: median * MINUTE,
});

describe("formatMinutes", () => {
  it("reads hours and minutes as «1 h 5 min» and keeps a half minute", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(65)).toBe("1 h 5 min");
    expect(formatMinutes(62.5)).toBe("1 h 2,5 min");
    expect(formatMinutes(32.5)).toBe("32,5 min");
    expect(formatMinutes(850)).toBe("14 h 10 min");
    expect(formatMinutes(111.25)).toBe("1 h 51,5 min");
    expect(formatMinutes(0.75)).toBe("45 s");
    expect(formatMinutes(0)).toBe("0 s");
  });
});

describe("dates in words", () => {
  it("writes ranges and lists of days", () => {
    expect(rangeText("2026-10-01", "2026-10-14")).toBe("del 1 al 14 de octubre de 2026");
    expect(rangeText("2026-09-29", "2026-10-02")).toBe(
      "del 29 de septiembre al 2 de octubre de 2026",
    );
    expect(daysListText(["2026-10-04", "2026-10-10"])).toBe("4 y 10 de octubre");
    expect(daysListText(["2026-09-30", "2026-10-04"])).toBe("30 de septiembre y 4 de octubre");
    expect(daysListText(["2026-10-04"])).toBe("4 de octubre");
  });
});

describe("provenanceText", () => {
  it("states period, operator, blocks, how each week was kept, interruptions and missing days", () => {
    expect(provenanceText(BASELINE_RECORD)).toBe(
      "Registro manual del 1 al 14 de octubre de 2026, un solo operador, 4 bloques de trabajo, antes de usar la app. " +
        "La primera semana (1 al 7 de octubre) se reconstruyó después; la segunda semana (8 al 14 de octubre) se cronometró en el momento. " +
        "Las interrupciones anotadas no se descontaron, así que el tiempo activo es algo menor que el registrado. " +
        "2 días sin registro (4 y 10 de octubre): cuentan como faltante, no como cero.",
    );
    expect(provenanceText(EMPTY_BASELINE)).toBe("");
    expect(hasBaseline(EMPTY_BASELINE)).toBe(false);
    expect(hasBaseline(BASELINE_RECORD)).toBe(true);
  });
});

describe("baselineComparisons", () => {
  const summary = {
    comparisons: [
      {
        key: "explore",
        assisted: stats(3, 12),
        manual: stats(0, 0),
        partial: { assisted: 0, manual: 0 },
      },
      {
        key: "write",
        assisted: stats(3, 26),
        manual: stats(0, 0),
        partial: { assisted: 0, manual: 0 },
      },
    ],
  } as unknown as EditorialResultsSummary;

  it("pairs search with assisted exploring and writing (only blocks that wrote) with write", () => {
    const [search, writing] = baselineComparisons(BASELINE_RECORD, summary);
    expect(search!.stats.assisted?.medianMs).toBe(12 * MINUTE);
    expect(search!.stats.cronometrado?.medianMs).toBe(55 * MINUTE);
    expect(search!.stats.reconstruido?.medianMs).toBe(65 * MINUTE);
    expect(writing!.stats.assisted?.medianMs).toBe(26 * MINUTE);
    expect(writing!.stats.cronometrado?.medianMs).toBe(112.5 * MINUTE);
  });

  it("leaves the assisted side empty without a summary", () => {
    expect(baselineComparisons(BASELINE_RECORD, null)[0]!.stats.assisted).toBeNull();
  });

  it("describes stats with RIC and n", () => {
    expect(baselineStatsText(BASELINE_RECORD.groups[0]!.search)).toBe(
      "55 min · RIC 45 min a 1 h 20 min · n = 9",
    );
  });
});

describe("the blocks table", () => {
  it("orders blocks and missing days by day and marks unseparated or missing cells", () => {
    const rows = baselineTableRows(BASELINE_RECORD);
    expect(
      rows.map((row) => (row.kind === "block" ? row.block.fecha : `${row.fecha} falta`)),
    ).toEqual([
      "2026-10-01",
      "2026-10-04 falta",
      "2026-10-05",
      "2026-10-08",
      "2026-10-10 falta",
      "2026-10-13",
    ]);
    const unseparated = BASELINE_RECORD.blocks[1]!;
    expect(minutesCell(unseparated, "minBusqueda")).toBe("sin separar");
    expect(minutesCell(unseparated, "minTotal")).toBe("1 h");
    const incomplete = BASELINE_RECORD.blocks[3]!;
    expect(minutesCell(incomplete, "minEscritura")).toBe("sin dato");
    expect(minutesCell(incomplete, "minTotal")).toBe("sin dato");
    expect(baselineNotes(BASELINE_RECORD).map((note) => note.label)).toEqual([
      "1 de octubre, bloque 1",
      "4 de octubre, sin registro",
    ]);
  });

  it("gives weekly minutes as a lower bound when a block lacks a part", () => {
    expect(weekMinutesText(BASELINE_RECORD.weeks[0]!)).toBe("14 h 10 min en 8 bloques");
    expect(weekRangeText(BASELINE_RECORD.weeks[0]!)).toBe("1 al 7 de octubre");
    expect(weekMinutesText(BASELINE_RECORD.weeks[1]!)).toBe("al menos 16 h 5 min en 9 bloques");
  });
});

describe("import messages", () => {
  const base = {
    errors: [],
    warnings: [],
    blocks: 17,
    missingDays: 2,
    from: "2026-10-01",
    to: "2026-10-14",
    sourceHash: "x",
    replaced: false,
  };

  it("says what happened", () => {
    expect(importResultText({ ...base, status: "imported" })).toBe(
      "Registro importado del 1 al 14 de octubre de 2026: 17 bloques y 2 días sin registro.",
    );
    expect(importResultText({ ...base, status: "imported", replaced: true })).toMatch(
      /^Registro reemplazado/,
    );
    expect(importResultText({ ...base, status: "unchanged" })).toMatch(/no cambió nada/);
    expect(
      importResultText({
        ...base,
        status: "rejected",
        errors: [{ line: 3, column: "modo", message: "m" }],
      }),
    ).toBe("No se importó nada: hay un error en el archivo.");
    expect(issueText({ line: 3, column: "modo", message: "«a ojo» no es un modo." })).toBe(
      "Línea 3, modo: «a ojo» no es un modo.",
    );
    expect(issueText({ line: null, column: null, message: "Vacío." })).toBe("Vacío.");
  });

  it("refuses a file over the limit before reading it", () => {
    expect(csvFileProblem({ name: "a.csv", size: 70_000 })).toBe("El archivo pesa más de 64 KiB.");
    expect(csvFileProblem({ name: "a.csv", size: 0 })).toBe("El archivo está vacío.");
    expect(csvFileProblem({ name: "a.csv", size: 2_000 })).toBeNull();
  });
});

describe("baselineFigure", () => {
  it("prints the same medians the chart draws, with the whisker only past one block", () => {
    const stats = (n: number, median: number) => ({
      n,
      medianMs: median,
      q1Ms: median - 60_000,
      q3Ms: median + 60_000,
      minMs: median - 60_000,
      maxMs: median + 60_000,
    });
    const figure = baselineFigure([
      {
        key: "search",
        title: "Buscar ideas",
        assistedLabel: "Asistido",
        manualLabel: "Manual",
        stats: {
          assisted: stats(1, 600_000),
          cronometrado: stats(9, 3_300_000),
          reconstruido: null,
        },
      },
    ]);
    if (figure.kind !== "bars") throw new Error("bars expected");
    expect(figure.series.map((series) => series.key)).toEqual([
      "assisted",
      "cronometrado",
      "reconstruido",
    ]);
    const rows = figure.groups[0]!.rows;
    expect(rows[0]).toMatchObject({ series: "assisted", value: 600_000, low: null, high: null });
    expect(rows[1]).toMatchObject({ series: "cronometrado", value: 3_300_000, low: 3_240_000 });
    expect(rows[2]).toMatchObject({ series: "reconstruido", value: null, text: "sin datos" });
    expect(figure.axis.max).toBeGreaterThanOrEqual(3_360_000);
  });
});
