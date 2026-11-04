import {
  EDITORIAL_BASELINE_CSV_COLUMNS,
  EDITORIAL_BASELINE_CSV_MAX_BYTES,
  EDITORIAL_BASELINE_OUTCOMES,
  type EditorialBaselineBlock,
  type EditorialBaselineGroup,
  type EditorialBaselineGroupKey,
  type EditorialBaselineImportIssue,
  type EditorialBaselineMissingDay,
  type EditorialBaselineMode,
  type EditorialBaselineOutcome,
  type EditorialBaselineWeek,
} from "@t3tools/contracts";

import { durationStats } from "./EditorialResultsService.ts";

// Pure half of the manual baseline: reading the operator's CSV, checking every row, deriving
// the missing days and the aggregates. `EditorialManualBaselineService.ts` stores and reads.

const MINUTE_MS = 60_000;
/** A block longer than a day is a typo, not a work block. */
export const BASELINE_MINUTES_MAX = 24 * 60;
export const BASELINE_INTERRUPTIONS_MAX = 100;
/** The derived missing days are bounded: a log longer than a year is not this record. */
const BASELINE_RANGE_DAYS_MAX = 366;
const SOURCE_MAX = 80;
const NOTES_MAX = 1000;
const MISSING_MODE = "sin registro";
const MODES: ReadonlyArray<EditorialBaselineMode> = ["reconstruido", "cronometrado"];

const DAY_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_FORMAT = /^(\d{1,2}):(\d{2})$/;
const INT_FORMAT = /^\d+$/;

/** A record of the CSV with the physical line it starts on (1 is the header). */
interface CsvRecord {
  readonly line: number;
  readonly cells: ReadonlyArray<string>;
}

/**
 * RFC 4180 records: commas, double quotes with `""` inside, LF or CRLF, a quoted cell may span
 * lines. A leading byte order mark is dropped. Returns null when a quote is never closed.
 */
export const parseCsvRecords = (text: string): ReadonlyArray<CsvRecord> | null => {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const records: Array<CsvRecord> = [];
  let cells: Array<string> = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index++;
        } else quoted = false;
      } else {
        if (char === "\n") line++;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      cells.push(cell);
      records.push({ line: start, cells });
      cells = [];
      cell = "";
      line++;
      start = line;
    } else cell += char;
  }
  if (quoted) return null;
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    records.push({ line: start, cells });
  }
  // Blank lines carry nothing.
  return records.filter((record) => record.cells.some((value) => value.trim() !== ""));
};

const DAY_MS = 24 * 60 * 60 * 1000;

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const monthDays = (year: number, month: number) =>
  month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/** A real calendar day between 2020 and 2099. */
const parseDay = (value: string): string | null => {
  const match = DAY_FORMAT.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 2020 || year > 2099 || month < 1 || month > 12) return null;
  return day >= 1 && day <= monthDays(year, month) ? value : null;
};

const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const daysBetween = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);

/** The calendar day `days` after `day`, counted on the calendar (no clock, no time zone). */
const addDays = (day: string, days: number): string => {
  let [year, month, date] = day.split("-").map(Number) as [number, number, number];
  date += days;
  while (date > monthDays(year, month)) {
    date -= monthDays(year, month);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;
};

/** `7:05` reads `07:05`; null when it is not a time of day. */
const parseClock = (value: string): string | null => {
  const match = CLOCK_FORMAT.exec(value);
  if (!match) return null;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
};

const clockMinutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

export interface ParsedBaseline {
  readonly blocks: ReadonlyArray<EditorialBaselineBlock>;
  readonly missingDays: ReadonlyArray<EditorialBaselineMissingDay>;
  readonly from: string | null;
  readonly to: string | null;
  readonly errors: ReadonlyArray<EditorialBaselineImportIssue>;
  readonly warnings: ReadonlyArray<EditorialBaselineImportIssue>;
}

/** The block's minutes: the unseparated total, or search plus writing when both are known. */
export const blockTotal = (block: {
  readonly minBusqueda: number | null;
  readonly minEscritura: number | null;
  readonly minTotalSinSeparar: number | null;
}): number | null =>
  block.minTotalSinSeparar ??
  (block.minBusqueda !== null && block.minEscritura !== null
    ? block.minBusqueda + block.minEscritura
    : null);

const formatMinutesText = (minutes: number) => `${minutes} min`;

/**
 * Reads and checks the whole log. All or none: with any error, nothing is stored. A day of the
 * range (first to last day of any row) without blocks is a missing day; a `sin registro` row
 * only adds its note. Warnings (a block whose clock span differs from its minutes) never block.
 */
export const parseBaselineCsv = (text: string): ParsedBaseline => {
  const errors: Array<EditorialBaselineImportIssue> = [];
  const warnings: Array<EditorialBaselineImportIssue> = [];
  const fail = (line: number | null, column: string | null, message: string) => {
    errors.push({ line, column, message });
  };
  const empty: ParsedBaseline = {
    blocks: [],
    missingDays: [],
    from: null,
    to: null,
    errors,
    warnings,
  };
  if (Buffer.byteLength(text, "utf8") > EDITORIAL_BASELINE_CSV_MAX_BYTES) {
    fail(null, null, `El archivo supera ${EDITORIAL_BASELINE_CSV_MAX_BYTES / 1024} KiB.`);
    return empty;
  }
  const records = parseCsvRecords(text);
  if (records === null) {
    fail(null, null, "Hay unas comillas sin cerrar: el archivo no es un CSV válido.");
    return empty;
  }
  const [header, ...rows] = records;
  if (header === undefined) {
    fail(null, null, "El archivo está vacío.");
    return empty;
  }
  const names = header.cells.map((name) => name.trim());
  const expected: ReadonlyArray<string> = EDITORIAL_BASELINE_CSV_COLUMNS;
  const missingColumns = expected.filter((name) => !names.includes(name));
  const unknownColumns = names.filter((name) => !expected.includes(name));
  const repeated = names.filter((name, index) => names.indexOf(name) !== index);
  if (missingColumns.length > 0) {
    fail(header.line, null, `Faltan columnas en la cabecera: ${missingColumns.join(", ")}.`);
  }
  if (unknownColumns.length > 0) {
    fail(header.line, null, `Columnas desconocidas en la cabecera: ${unknownColumns.join(", ")}.`);
  }
  if (repeated.length > 0) {
    fail(header.line, null, `Columnas repetidas en la cabecera: ${repeated.join(", ")}.`);
  }
  if (errors.length > 0) return empty;

  const index = new Map(names.map((name, position) => [name, position]));
  const blocks: Array<EditorialBaselineBlock> = [];
  const missing = new Map<string, string | null>();
  const blockKeys = new Set<string>();
  const days: Array<string> = [];

  for (const record of rows) {
    const { line } = record;
    if (record.cells.length !== names.length) {
      fail(
        line,
        null,
        `La fila tiene ${record.cells.length} celdas y la cabecera ${names.length}.`,
      );
      continue;
    }
    const cell = (name: (typeof EDITORIAL_BASELINE_CSV_COLUMNS)[number]) =>
      record.cells[index.get(name)!]!.trim();
    const rowErrors = errors.length;
    const integer = (name: (typeof EDITORIAL_BASELINE_CSV_COLUMNS)[number], max: number) => {
      const value = cell(name);
      if (value === "") return null;
      if (!INT_FORMAT.test(value) || Number(value) > max) {
        fail(line, name, `«${value}» no es un entero entre 0 y ${max}.`);
        return null;
      }
      return Number(value);
    };

    const fecha = parseDay(cell("fecha"));
    if (fecha === null) {
      fail(line, "fecha", `«${cell("fecha")}» no es una fecha AAAA-MM-DD entre 2020 y 2099.`);
    }
    const modoText = cell("modo").toLowerCase();
    const notes = cell("observaciones");
    if (notes.length > NOTES_MAX) {
      fail(line, "observaciones", `Las observaciones superan ${NOTES_MAX} caracteres.`);
    }

    if (modoText === MISSING_MODE) {
      const filled = EDITORIAL_BASELINE_CSV_COLUMNS.filter(
        (name) => !["fecha", "modo", "observaciones"].includes(name) && cell(name) !== "",
      );
      if (filled.length > 0) {
        fail(line, null, `Un día «sin registro» no lleva datos de bloque: ${filled.join(", ")}.`);
      }
      if (fecha !== null && missing.has(fecha)) {
        fail(line, "fecha", `El día ${fecha} ya figura como «sin registro».`);
      }
      if (errors.length === rowErrors && fecha !== null) {
        missing.set(fecha, notes === "" ? null : notes);
        days.push(fecha);
      }
      continue;
    }

    const modo = MODES.find((entry) => entry === modoText);
    if (modo === undefined) {
      fail(
        line,
        "modo",
        `«${cell("modo")}» no es un modo: reconstruido, cronometrado o sin registro.`,
      );
    }
    const bloque = integer("bloque", 99);
    if (cell("bloque") === "") fail(line, "bloque", "Falta el número de bloque.");
    else if (bloque === 0) fail(line, "bloque", "El bloque empieza en 1.");
    const clock = (name: "inicio" | "fin") => {
      const value = cell(name);
      if (value === "") return null;
      const parsed = parseClock(value);
      if (parsed === null) fail(line, name, `«${value}» no es una hora HH:MM.`);
      return parsed;
    };
    const inicio = clock("inicio");
    const fin = clock("fin");
    const minBusqueda = integer("min_busqueda", BASELINE_MINUTES_MAX);
    const minEscritura = integer("min_escritura", BASELINE_MINUTES_MAX);
    const minTotalSinSeparar = integer("min_total_sin_separar", BASELINE_MINUTES_MAX);
    if (minTotalSinSeparar !== null && (minBusqueda !== null || minEscritura !== null)) {
      fail(
        line,
        "min_total_sin_separar",
        "El total sin separar solo va cuando búsqueda y escritura están vacías.",
      );
    }
    const resultadoText = cell("resultado").toLowerCase();
    const resultado = EDITORIAL_BASELINE_OUTCOMES.find((entry) => entry === resultadoText);
    if (resultado === undefined) {
      fail(
        line,
        "resultado",
        resultadoText === ""
          ? "Falta el resultado del bloque."
          : `«${cell("resultado")}» no es un resultado conocido: ${EDITORIAL_BASELINE_OUTCOMES.join(", ")}.`,
      );
    }
    const fuente = cell("fuente_senal");
    if (fuente.length > SOURCE_MAX) {
      fail(line, "fuente_senal", `La fuente supera ${SOURCE_MAX} caracteres.`);
    }
    const interrupciones = integer("interrupciones", BASELINE_INTERRUPTIONS_MAX);
    if (fecha !== null && bloque !== null) {
      const key = `${fecha}#${bloque}`;
      if (blockKeys.has(key)) fail(line, "bloque", `El bloque ${bloque} del ${fecha} se repite.`);
      blockKeys.add(key);
    }
    if (
      errors.length > rowErrors ||
      fecha === null ||
      bloque === null ||
      modo === undefined ||
      resultado === undefined
    ) {
      continue;
    }
    const block: EditorialBaselineBlock = {
      fecha,
      bloque,
      inicio,
      fin,
      minBusqueda,
      minEscritura,
      minTotalSinSeparar,
      minTotal: null,
      modo,
      resultado,
      fuente: fuente === "" ? null : fuente,
      interrupciones,
      observaciones: notes === "" ? null : notes,
    };
    const total = blockTotal(block);
    if (inicio !== null && fin !== null && total !== null) {
      // A block past midnight ends the next day.
      const span = (clockMinutes(fin) - clockMinutes(inicio) + 24 * 60) % (24 * 60);
      if (span !== total) {
        warnings.push({
          line,
          column: null,
          message: `De ${inicio} a ${fin} van ${formatMinutesText(span)}, pero el bloque suma ${formatMinutesText(total)}.`,
        });
      }
    }
    blocks.push({ ...block, minTotal: total });
    days.push(fecha);
  }

  for (const block of blocks) {
    if (missing.has(block.fecha)) {
      fail(null, "fecha", `El día ${block.fecha} tiene bloques y también figura «sin registro».`);
    }
  }
  if (errors.length === 0 && blocks.length === 0) {
    fail(null, null, "El registro no tiene ningún bloque.");
  }
  if (errors.length > 0) return empty;

  const sortedDays = days.toSorted();
  const from = sortedDays[0]!;
  const to = sortedDays.at(-1)!;
  if (daysBetween(from, to) + 1 > BASELINE_RANGE_DAYS_MAX) {
    fail(
      null,
      "fecha",
      `El registro va del ${from} al ${to}: más de ${BASELINE_RANGE_DAYS_MAX} días.`,
    );
    return empty;
  }
  const withBlocks = new Set(blocks.map((block) => block.fecha));
  const missingDays: Array<EditorialBaselineMissingDay> = [];
  for (let offset = 0; offset <= daysBetween(from, to); offset++) {
    const day = addDays(from, offset);
    if (!withBlocks.has(day))
      missingDays.push({ fecha: day, observaciones: missing.get(day) ?? null });
  }
  return {
    blocks: blocks.toSorted((a, b) =>
      a.fecha === b.fecha ? a.bloque - b.bloque : a.fecha < b.fecha ? -1 : 1,
    ),
    missingDays,
    from,
    to,
    errors,
    warnings,
  };
};

const minutesStats = (values: ReadonlyArray<number>) =>
  durationStats(values.map((minutes) => minutes * MINUTE_MS));

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

const defined = <T>(values: ReadonlyArray<T | null>): ReadonlyArray<T> =>
  values.filter((value): value is T => value !== null);

/** The aggregates of one group of blocks. Only stored values count; nothing is imputed. */
const summarizeGroup = (
  key: EditorialBaselineGroupKey,
  blocks: ReadonlyArray<EditorialBaselineBlock>,
): EditorialBaselineGroup => {
  const search = defined(blocks.map((block) => block.minBusqueda));
  const writing = defined(blocks.map((block) => block.minEscritura));
  const totals = defined(blocks.map((block) => block.minTotal));
  const incomplete = blocks.filter((block) => block.minTotal === null);
  const completeMinutes = sum(totals);
  return {
    key,
    blocks: blocks.length,
    daysRecorded: new Set(blocks.map((block) => block.fecha)).size,
    search: minutesStats(search),
    writing: minutesStats(writing),
    writingNonZero: minutesStats(writing.filter((minutes) => minutes > 0)),
    total: minutesStats(totals),
    searchMinutes: sum(search),
    writingMinutes: sum(writing),
    completeMinutes,
    knownMinutes:
      completeMinutes +
      sum(incomplete.map((block) => (block.minBusqueda ?? 0) + (block.minEscritura ?? 0))),
    incompleteBlocks: incomplete.length,
    interruptions: sum(defined(blocks.map((block) => block.interrupciones))),
    blocksWithInterruptions: blocks.filter((block) => (block.interrupciones ?? 0) > 0).length,
    outcomes: EDITORIAL_BASELINE_OUTCOMES.map((resultado: EditorialBaselineOutcome) => ({
      resultado,
      blocks: blocks.filter((block) => block.resultado === resultado).length,
    })),
  };
};

/** Timed first (the observation), then reconstructed (the estimate), then both. */
export const summarizeGroups = (
  blocks: ReadonlyArray<EditorialBaselineBlock>,
): ReadonlyArray<EditorialBaselineGroup> => [
  summarizeGroup(
    "cronometrado",
    blocks.filter((block) => block.modo === "cronometrado"),
  ),
  summarizeGroup(
    "reconstruido",
    blocks.filter((block) => block.modo === "reconstruido"),
  ),
  summarizeGroup("conjunto", blocks),
];

/** Seven-day periods from the first day of the range, the last one cut at its end. */
export const summarizeWeeks = (
  blocks: ReadonlyArray<EditorialBaselineBlock>,
  missingDays: ReadonlyArray<EditorialBaselineMissingDay>,
  from: string | null,
  to: string | null,
): ReadonlyArray<EditorialBaselineWeek> => {
  if (from === null || to === null) return [];
  const span = daysBetween(from, to) + 1;
  const weeks: Array<EditorialBaselineWeek> = [];
  for (let start = 0; start < span; start += 7) {
    const weekFrom = addDays(from, start);
    const weekTo = addDays(from, Math.min(start + 6, span - 1));
    const inWeek = (day: string) => day >= weekFrom && day <= weekTo;
    const weekBlocks = blocks.filter((block) => inWeek(block.fecha));
    const group = summarizeGroup("conjunto", weekBlocks);
    weeks.push({
      from: weekFrom,
      to: weekTo,
      days: daysBetween(weekFrom, weekTo) + 1,
      daysRecorded: group.daysRecorded,
      daysMissing: missingDays.filter((day) => inWeek(day.fecha)).length,
      blocks: weekBlocks.length,
      modes: MODES.filter((mode) => weekBlocks.some((block) => block.modo === mode)),
      completeMinutes: group.completeMinutes,
      knownMinutes: group.knownMinutes,
      incompleteBlocks: group.incompleteBlocks,
    });
  }
  return weeks;
};
