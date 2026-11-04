import { describe, expect, it } from "@effect/vitest";
import type { EditorialBaselineGroup, EditorialDurationStats } from "@t3tools/contracts";

import { BASELINE_FIXTURE_CSV } from "./manualBaseline.testkit.ts";
import {
  parseBaselineCsv,
  parseCsvRecords,
  summarizeGroups,
  summarizeWeeks,
} from "./manualBaselineFormat.ts";

const MINUTE = 60_000;
const HEADER =
  "fecha,bloque,inicio,fin,min_busqueda,min_escritura,min_total_sin_separar,modo,resultado,fuente_senal,interrupciones,observaciones";

const inMinutes = (stats: EditorialDurationStats) => ({
  n: stats.n,
  median: stats.medianMs === null ? null : stats.medianMs / MINUTE,
});

const groupOf = (
  groups: ReadonlyArray<EditorialBaselineGroup>,
  key: EditorialBaselineGroup["key"],
) => groups.find((group) => group.key === key)!;

const csv = (...rows: ReadonlyArray<string>) => [HEADER, ...rows].join("\n");

describe("parseCsvRecords", () => {
  it("reads quotes, doubled quotes, CRLF, a cell across lines and drops the BOM", () => {
    const records = parseCsvRecords('﻿a,b\r\n"x, y","di ""no"""\r\n"uno\ndos",z\r\n\r\n');
    expect(records).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["x, y", 'di "no"'] },
      { line: 3, cells: ["uno\ndos", "z"] },
    ]);
  });

  it("refuses a quote never closed", () => {
    expect(parseCsvRecords('a,b\n"x,y\n')).toBeNull();
  });

  it("refuses text after a closing quote and a quote inside a bare cell", () => {
    expect(parseCsvRecords('a,b\n"hola"x,y\n')).toBeNull();
    expect(parseCsvRecords('a,b\nho"la,y\n')).toBeNull();
    expect(parseCsvRecords('a,b\n"hola",y\n')).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["hola", "y"] },
    ]);
  });
});

describe("parseBaselineCsv over the October log", () => {
  const parsed = parseBaselineCsv(BASELINE_FIXTURE_CSV);

  it("reads 17 blocks and derives the two missing days with their notes", () => {
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.blocks).toHaveLength(17);
    expect(parsed.from).toBe("2026-10-01");
    expect(parsed.to).toBe("2026-10-14");
    expect(parsed.missingDays).toEqual([
      { fecha: "2026-10-04", observaciones: "NOTA-FALTA-04" },
      { fecha: "2026-10-10", observaciones: "NOTA-FALTA-10" },
    ]);
    expect(parsed.blocks.map((block) => `${block.fecha}#${block.bloque}`).slice(0, 3)).toEqual([
      "2026-10-01#1",
      "2026-10-01#2",
      "2026-10-02#1",
    ]);
  });

  it("keeps a block with only the unseparated total out of search and writing", () => {
    const block = parsed.blocks.find(
      (entry) => entry.fecha === "2026-10-05" && entry.bloque === 2,
    )!;
    expect(block).toMatchObject({
      minBusqueda: null,
      minEscritura: null,
      minTotalSinSeparar: 60,
      minTotal: 60,
    });
    const incomplete = parsed.blocks.find(
      (entry) => entry.fecha === "2026-10-13" && entry.bloque === 2,
    )!;
    expect(incomplete).toMatchObject({ minBusqueda: 40, minEscritura: null, minTotal: null });
    expect(incomplete.fin).toBeNull();
  });

  it("gives the coordinator's aggregates per mode and for both", () => {
    const groups = summarizeGroups(parsed.blocks);
    expect(groups.map((group) => group.key)).toEqual(["cronometrado", "reconstruido", "conjunto"]);
    const timed = groupOf(groups, "cronometrado");
    expect(timed).toMatchObject({
      blocks: 9,
      daysRecorded: 6,
      searchMinutes: 545,
      writingMinutes: 420,
      completeMinutes: 925,
      knownMinutes: 965,
      incompleteBlocks: 1,
      interruptions: 3,
      blocksWithInterruptions: 2,
    });
    expect(inMinutes(timed.search)).toEqual({ n: 9, median: 55 });
    expect(inMinutes(timed.writing)).toEqual({ n: 8, median: 32.5 });
    expect(inMinutes(timed.writingNonZero)).toEqual({ n: 4, median: 112.5 });
    expect(inMinutes(timed.total)).toEqual({ n: 8, median: 117.5 });

    const rebuilt = groupOf(groups, "reconstruido");
    expect(rebuilt).toMatchObject({
      blocks: 8,
      daysRecorded: 6,
      searchMinutes: 455,
      writingMinutes: 335,
      completeMinutes: 850,
      knownMinutes: 850,
      interruptions: 1,
    });
    expect(inMinutes(rebuilt.search)).toEqual({ n: 7, median: 65 });
    expect(inMinutes(rebuilt.writing)).toEqual({ n: 7, median: 35 });
    expect(inMinutes(rebuilt.writingNonZero)).toEqual({ n: 4, median: 80 });
    expect(inMinutes(rebuilt.total)).toEqual({ n: 8, median: 87.5 });

    const both = groupOf(groups, "conjunto");
    expect(both).toMatchObject({
      blocks: 17,
      daysRecorded: 12,
      searchMinutes: 1000,
      writingMinutes: 755,
      completeMinutes: 1775,
      knownMinutes: 1815,
      interruptions: 4,
    });
    expect(inMinutes(both.search)).toEqual({ n: 16, median: 62.5 });
    expect(inMinutes(both.writing)).toEqual({ n: 15, median: 35 });
    expect(inMinutes(both.writingNonZero)).toEqual({ n: 8, median: 105 });
    expect(inMinutes(both.total)).toEqual({ n: 16, median: 95 });
    expect(
      Object.fromEntries(both.outcomes.map((entry) => [entry.resultado, entry.blocks])),
    ).toEqual({
      "idea descartada": 6,
      "idea en espera": 1,
      "ficha escrita": 3,
      "ficha revisada": 2,
      "guion borrador": 3,
      "guion terminado": 2,
    });
  });

  it("splits the range in seven-day weeks with their missing days, never extrapolated", () => {
    const weeks = summarizeWeeks(parsed.blocks, parsed.missingDays, parsed.from, parsed.to);
    expect(weeks).toEqual([
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
    ]);
  });
});

describe("parseBaselineCsv checks", () => {
  const block = (overrides: Partial<Record<string, string>> = {}) => {
    const row: Record<string, string> = {
      fecha: "2026-10-01",
      bloque: "1",
      inicio: "07:00",
      fin: "08:00",
      min_busqueda: "30",
      min_escritura: "30",
      min_total_sin_separar: "",
      modo: "cronometrado",
      resultado: "ficha escrita",
      fuente_senal: "GitHub",
      interrupciones: "0",
      observaciones: "",
      ...overrides,
    };
    return HEADER.split(",")
      .map((name) => row[name]!)
      .join(",");
  };

  it("names missing, unknown and repeated header columns", () => {
    const parsed = parseBaselineCsv("fecha,bloque,extra,extra\n2026-10-01,1,,\n");
    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors.map((error) => error.message)).toEqual([
      expect.stringContaining("Faltan columnas en la cabecera: inicio, fin"),
      "Columnas desconocidas en la cabecera: extra, extra.",
      "Columnas repetidas en la cabecera: extra.",
    ]);
    expect(parsed.errors[0]!.line).toBe(1);
  });

  it("accepts the columns in any order", () => {
    const names = HEADER.split(",").toReversed();
    const values = block().split(",").toReversed();
    const parsed = parseBaselineCsv(`${names.join(",")}\n${values.join(",")}\n`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks[0]).toMatchObject({ minTotal: 60, fuente: "GitHub" });
  });

  it("reports every bad cell with its line and column and stores nothing", () => {
    const parsed = parseBaselineCsv(
      csv(
        block(),
        block({
          fecha: "2026-02-30",
          bloque: "x",
          inicio: "25:00",
          min_busqueda: "-5",
          modo: "estimado",
          resultado: "video publicado",
          interrupciones: "1,5",
        }),
      ),
    );
    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors.map((error) => [error.line, error.column])).toEqual([[3, null]]);
    const shifted = parseBaselineCsv(
      csv(
        block(),
        block({
          fecha: "2026-02-30",
          bloque: "x",
          inicio: "25:00",
          min_busqueda: "-5",
          modo: "estimado",
          resultado: "video publicado",
          interrupciones: "1.5",
        }),
      ),
    );
    expect(shifted.errors.map((error) => error.column)).toEqual([
      "fecha",
      "modo",
      "bloque",
      "inicio",
      "min_busqueda",
      "resultado",
      "interrupciones",
    ]);
    expect(shifted.errors.every((error) => error.line === 3)).toBe(true);
  });

  it("refuses a repeated block, a total next to separated minutes and a busy missing day", () => {
    const parsed = parseBaselineCsv(
      csv(
        block(),
        block(),
        block({ bloque: "2", min_total_sin_separar: "60" }),
        "2026-10-02,1,,,,,,sin registro,,,,",
        block({ fecha: "2026-10-03" }),
        "2026-10-03,,,,,,,sin registro,,,,",
      ),
    );
    expect(parsed.errors.map((error) => error.message)).toEqual([
      "El bloque 1 del 2026-10-01 se repite.",
      "El total sin separar solo va cuando búsqueda y escritura están vacías.",
      "Un día «sin registro» no lleva datos de bloque: bloque.",
      "El día 2026-10-03 tiene bloques y también figura «sin registro».",
    ]);
  });

  it("treats a day of the range without rows as missing, without a note", () => {
    const parsed = parseBaselineCsv(csv(block(), block({ fecha: "2026-10-04" })));
    expect(parsed.errors).toEqual([]);
    expect(parsed.missingDays).toEqual([
      { fecha: "2026-10-02", observaciones: null },
      { fecha: "2026-10-03", observaciones: null },
    ]);
    expect(
      summarizeWeeks(parsed.blocks, parsed.missingDays, parsed.from, parsed.to).map((week) => [
        week.from,
        week.to,
        week.days,
      ]),
    ).toEqual([["2026-10-01", "2026-10-04", 4]]);
  });

  it("crosses month ends when it derives the missing days", () => {
    const parsed = parseBaselineCsv(
      csv(block({ fecha: "2026-09-29" }), block({ fecha: "2026-10-02" })),
    );
    expect(parsed.missingDays.map((day) => day.fecha)).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("warns, without refusing, when the clock span differs from the minutes", () => {
    const parsed = parseBaselineCsv(csv(block({ fin: "08:20" })));
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([
      {
        line: 2,
        column: null,
        message: "De 07:00 a 08:20 van 80 min, pero el bloque suma 60 min.",
      },
    ]);
    // A block past midnight ends the next day.
    expect(parseBaselineCsv(csv(block({ inicio: "23:30", fin: "00:30" }))).warnings).toEqual([]);
  });

  it("refuses an empty log, a log without blocks and a file over the limit", () => {
    expect(parseBaselineCsv("").errors[0]!.message).toBe("El archivo está vacío.");
    expect(parseBaselineCsv(csv("2026-10-02,,,,,,,sin registro,,,,")).errors[0]!.message).toBe(
      "El registro no tiene ningún bloque.",
    );
    expect(parseBaselineCsv(csv(block(), `${"x".repeat(70_000)}`)).errors[0]!.message).toBe(
      "El archivo supera 64 KiB.",
    );
    expect(parseBaselineCsv(`${HEADER}\n"abierta`).errors[0]!.message).toContain("comillas");
  });

  it("counts cells per row against the header", () => {
    const parsed = parseBaselineCsv(csv("2026-10-01,1,07:00"));
    expect(parsed.errors).toEqual([
      { line: 2, column: null, message: "La fila tiene 3 celdas y la cabecera 12." },
    ]);
  });
});
