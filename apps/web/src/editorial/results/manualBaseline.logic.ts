import {
  EDITORIAL_BASELINE_CSV_MAX_BYTES,
  type EditorialBaselineBlock,
  type EditorialBaselineGroup,
  type EditorialBaselineGroupKey,
  type EditorialBaselineImportResult,
  type EditorialBaselineOutcome,
  type EditorialBaselineRecord,
  type EditorialBaselineWeek,
  type EditorialDurationStats,
  type EditorialResultsSummary,
} from "@t3tools/contracts";

const MINUTE_MS = 60_000;

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

const parts = (day: string) => {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return { year, month, date };
};

/** "4 de octubre", with the year when asked: "4 de octubre de 2026". */
export function dayText(day: string, withYear = false): string {
  const { year, month, date } = parts(day);
  return `${date} de ${MONTHS[month - 1] ?? "?"}${withYear ? ` de ${year}` : ""}`;
}

/** "del 1 al 14 de octubre de 2026", "del 29 de septiembre al 2 de octubre de 2026". */
export function rangeText(from: string, to: string): string {
  const start = parts(from);
  const end = parts(to);
  if (start.year !== end.year) return `del ${dayText(from, true)} al ${dayText(to, true)}`;
  if (start.month !== end.month) return `del ${dayText(from)} al ${dayText(to, true)}`;
  return `del ${start.date} al ${dayText(to, true)}`;
}

/** "4 y 10 de octubre" in one month; "30 de septiembre y 4 de octubre" across months. */
export function daysListText(days: ReadonlyArray<string>): string {
  if (days.length === 0) return "";
  const sameMonth = days.every((day) => day.slice(0, 7) === days[0]!.slice(0, 7));
  const items = sameMonth
    ? [...days.slice(0, -1).map((day) => String(parts(day).date)), dayText(days.at(-1)!)]
    : days.map((day) => dayText(day));
  return items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} y ${items.at(-1)!}`;
}

const halfFormat = new Intl.NumberFormat("es", { maximumFractionDigits: 1 });

/**
 * "45 min", "1 h", "1 h 05 min", "1 h 02,5 min": a median of whole minutes can fall on a half
 * minute, which stays visible; anything finer rounds to the half minute. Under a minute, "45 s".
 */
export function formatMinutes(minutes: number): string {
  if (minutes === 0) return "0 min";
  if (minutes < 1) return `${Math.round(minutes * 60)} s`;
  const half = Math.round(minutes * 2) / 2;
  if (half < 60) return `${halfFormat.format(half)} min`;
  const hours = Math.floor(half / 60);
  const rest = half - hours * 60;
  if (rest === 0) return `${hours} h`;
  const whole = Math.floor(rest);
  const text = `${String(whole).padStart(2, "0")}${rest === whole ? "" : ",5"}`;
  return `${hours} h ${text} min`;
}

export function formatMs(ms: number): string {
  return formatMinutes(ms / MINUTE_MS);
}

/** "55 min · RIC 45 min a 1 h 20 min · n = 9", or "sin datos · n = 0". */
export function baselineStatsText(stats: EditorialDurationStats): string {
  if (stats.medianMs === null) return `sin datos · n = ${stats.n}`;
  const iqr =
    stats.q1Ms !== null && stats.q3Ms !== null && stats.n > 1
      ? `RIC ${formatMs(stats.q1Ms)} a ${formatMs(stats.q3Ms)}`
      : null;
  return [formatMs(stats.medianMs), iqr, `n = ${stats.n}`].filter(Boolean).join(" · ");
}

export function hasBaseline(record: EditorialBaselineRecord | null): boolean {
  return record !== null && record.provenance !== null && record.blocks.length > 0;
}

export function groupOf(
  record: EditorialBaselineRecord,
  key: EditorialBaselineGroupKey,
): EditorialBaselineGroup | undefined {
  return record.groups.find((group) => group.key === key);
}

const ORDINALS = ["primera", "segunda", "tercera", "cuarta", "quinta", "sexta", "séptima"];

/** "la primera semana (1 al 7 de octubre) se reconstruyó después". */
const weekModeText = (week: EditorialBaselineWeek, index: number): string => {
  const name =
    ORDINALS[index] === undefined ? `la semana ${index + 1}` : `la ${ORDINALS[index]} semana`;
  const range = rangeText(week.from, week.to)
    .replace(/^del /, "")
    .replace(/ de \d{4}$/, "");
  const how =
    week.modes.length === 0
      ? "no tiene bloques"
      : week.modes.length === 2
        ? "mezcla bloques reconstruidos y cronometrados"
        : week.modes[0] === "reconstruido"
          ? "se reconstruyó después"
          : "se cronometró en el momento";
  return `${name} (${range}) ${how}`;
};

/**
 * The provenance and limits in plain words: period, one operator, blocks, how each week was
 * obtained, interruptions not discounted, missing days.
 */
export function provenanceText(record: EditorialBaselineRecord): string {
  const provenance = record.provenance;
  if (provenance === null) return "";
  const blocks = record.blocks.length;
  const weeks = record.weeks.map(weekModeText);
  const weeksText = weeks.join("; ");
  const missing = record.missingDays.map((day) => day.fecha);
  const sentences = [
    `Registro manual ${rangeText(provenance.from, provenance.to)}, un solo operador, ${blocks} ${blocks === 1 ? "bloque" : "bloques"} de trabajo, antes de usar la app.`,
    weeksText === "" ? null : `${weeksText.charAt(0).toUpperCase()}${weeksText.slice(1)}.`,
    "Las interrupciones anotadas no se descontaron, así que el tiempo activo es algo menor que el registrado.",
    missing.length === 0
      ? "Todos los días del periodo tienen registro."
      : `${missing.length === 1 ? "Un día sin registro" : `${missing.length} días sin registro`} (${daysListText(missing)}): ${missing.length === 1 ? "cuenta" : "cuentan"} como faltante, no como cero.`,
  ];
  return sentences.filter(Boolean).join(" ");
}

/** The manual series of the comparison: timed is the main figure, reconstructed secondary. */
export type BaselineSeries = "assisted" | "cronometrado" | "reconstruido";

export const BASELINE_SERIES: ReadonlyArray<BaselineSeries> = [
  "assisted",
  "cronometrado",
  "reconstruido",
];

const SERIES_LABELS: Readonly<Record<BaselineSeries, string>> = {
  assisted: "Asistido",
  cronometrado: "Manual cronometrado",
  reconstruido: "Manual reconstruido",
};

export function seriesLabel(series: BaselineSeries): string {
  return SERIES_LABELS[series];
}

export interface BaselineComparison {
  readonly key: "search" | "writing";
  readonly title: string;
  readonly assistedLabel: string;
  readonly manualLabel: string;
  /** Null when Results has no summary (it failed or is loading). */
  readonly stats: Readonly<Record<BaselineSeries, EditorialDurationStats | null>>;
}

/**
 * Search per manual block against assisted exploring (the engine's `explore` plus reading the
 * dossier, as Results compares exploring); writing against `write`, only manual blocks where
 * something was written, because an assisted thread enters `write` only when it writes.
 */
export function baselineComparisons(
  record: EditorialBaselineRecord,
  summary: EditorialResultsSummary | null,
): ReadonlyArray<BaselineComparison> {
  const assisted = (key: "explore" | "write") =>
    summary?.comparisons.find((comparison) => comparison.key === key)?.assisted ?? null;
  const timed = groupOf(record, "cronometrado");
  const rebuilt = groupOf(record, "reconstruido");
  return [
    {
      key: "search",
      title: "Buscar ideas",
      assistedLabel: "Asistido: explorar y leer la ficha de tendencia, por hilo",
      manualLabel: "Manual: búsqueda, por bloque",
      stats: {
        assisted: assisted("explore"),
        cronometrado: timed?.search ?? null,
        reconstruido: rebuilt?.search ?? null,
      },
    },
    {
      key: "writing",
      title: "Escribir",
      assistedLabel: "Asistido: escribir, por hilo",
      manualLabel: "Manual: escritura, por bloque con escritura",
      stats: {
        assisted: assisted("write"),
        cronometrado: timed?.writingNonZero ?? null,
        reconstruido: rebuilt?.writingNonZero ?? null,
      },
    },
  ];
}

/** The common scale of the chart: the largest third quartile or median, at least a minute. */
export function baselineChartMaxMs(comparisons: ReadonlyArray<BaselineComparison>): number {
  const ends = comparisons.flatMap((comparison) =>
    BASELINE_SERIES.flatMap((series) => {
      const stats = comparison.stats[series];
      return stats === null ? [] : [stats.q3Ms ?? 0, stats.medianMs ?? 0];
    }),
  );
  return Math.max(MINUTE_MS, ...ends);
}

const OUTCOME_LABELS: Readonly<Record<EditorialBaselineOutcome, string>> = {
  "idea descartada": "Idea descartada",
  "idea en espera": "Idea en espera",
  "ficha escrita": "Ficha escrita",
  "ficha revisada": "Ficha revisada",
  "guion borrador": "Guion en borrador",
  "guion terminado": "Guion terminado",
};

export function outcomeLabel(outcome: EditorialBaselineOutcome): string {
  return OUTCOME_LABELS[outcome];
}

/** A table row: a block, or a day without any. */
export type BaselineTableRow =
  | { readonly kind: "block"; readonly block: EditorialBaselineBlock }
  | { readonly kind: "missing"; readonly fecha: string };

export function baselineTableRows(
  record: EditorialBaselineRecord,
): ReadonlyArray<BaselineTableRow> {
  const rows: Array<BaselineTableRow> = [
    ...record.blocks.map((block) => ({ kind: "block" as const, block })),
    ...record.missingDays.map((day) => ({ kind: "missing" as const, fecha: day.fecha })),
  ];
  const dayOf = (row: BaselineTableRow) => (row.kind === "block" ? row.block.fecha : row.fecha);
  return rows.toSorted((a, b) => {
    if (dayOf(a) !== dayOf(b)) return dayOf(a) < dayOf(b) ? -1 : 1;
    return (a.kind === "block" ? a.block.bloque : 0) - (b.kind === "block" ? b.block.bloque : 0);
  });
}

/** A minutes cell: the value, "sin separar" when only the block total was kept, or "sin dato". */
export function minutesCell(
  block: EditorialBaselineBlock,
  field: "minBusqueda" | "minEscritura" | "minTotal",
): string {
  const value = block[field];
  if (value !== null) return formatMinutes(value);
  if (field !== "minTotal" && block.minTotalSinSeparar !== null) return "sin separar";
  return "sin dato";
}

/** "14 h 10 min en 8 bloques", with "al menos" when a block lacks a part. */
export function weekMinutesText(week: EditorialBaselineWeek): string {
  const blocks = `${week.blocks} ${week.blocks === 1 ? "bloque" : "bloques"}`;
  if (week.blocks === 0) return "sin bloques";
  return week.incompleteBlocks > 0
    ? `al menos ${formatMinutes(week.knownMinutes)} en ${blocks}`
    : `${formatMinutes(week.completeMinutes)} en ${blocks}`;
}

/** "1 al 7 de octubre", the year left to the provenance line. */
export function weekRangeText(week: EditorialBaselineWeek): string {
  return rangeText(week.from, week.to)
    .replace(/^del /, "")
    .replace(/ de \d{4}$/, "");
}

export function weekDaysText(week: EditorialBaselineWeek): string {
  return `${week.daysRecorded} de ${week.days} días con registro`;
}

/** The notes the operator wrote, per block or missing day, for the folded detail. */
export function baselineNotes(
  record: EditorialBaselineRecord,
): ReadonlyArray<{ readonly key: string; readonly label: string; readonly text: string }> {
  return baselineTableRows(record).flatMap((row) => {
    if (row.kind === "block") {
      return row.block.observaciones === null
        ? []
        : [
            {
              key: `${row.block.fecha}#${row.block.bloque}`,
              label: `${dayText(row.block.fecha)}, bloque ${row.block.bloque}`,
              text: row.block.observaciones,
            },
          ];
    }
    const note = record.missingDays.find((day) => day.fecha === row.fecha)?.observaciones ?? null;
    return note === null
      ? []
      : [{ key: row.fecha, label: `${dayText(row.fecha)}, sin registro`, text: note }];
  });
}

/** Why a file cannot be sent, before reading it; null when it can. */
export function csvFileProblem(file: {
  readonly name: string;
  readonly size: number;
}): string | null {
  if (file.size > EDITORIAL_BASELINE_CSV_MAX_BYTES) {
    return `El archivo pesa más de ${EDITORIAL_BASELINE_CSV_MAX_BYTES / 1024} KiB.`;
  }
  if (file.size === 0) return "El archivo está vacío.";
  return null;
}

/** The import's outcome in the operator's words. */
export function importResultText(result: EditorialBaselineImportResult): string {
  const period =
    result.from !== null && result.to !== null ? ` ${rangeText(result.from, result.to)}` : "";
  const counts = `${result.blocks} ${result.blocks === 1 ? "bloque" : "bloques"} y ${result.missingDays} ${result.missingDays === 1 ? "día" : "días"} sin registro`;
  switch (result.status) {
    case "imported":
      return `${result.replaced ? "Registro reemplazado" : "Registro importado"}${period}: ${counts}.`;
    case "unchanged":
      return `Es el mismo archivo que ya estaba importado${period}; no cambió nada.`;
    case "rejected":
      return `No se importó nada: ${result.errors.length === 1 ? "hay un error" : `hay ${result.errors.length} errores`} en el archivo.`;
  }
}

/** "Línea 5, min_busqueda: …" or the message alone. */
export function issueText(issue: {
  readonly line: number | null;
  readonly column: string | null;
  readonly message: string;
}): string {
  const where = [
    issue.line === null ? null : `Línea ${issue.line}`,
    issue.column === null ? null : issue.column,
  ]
    .filter(Boolean)
    .join(", ");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

/** Why the import or the read failed, from the RPC error. */
export function baselineFailureText(error: unknown): string {
  const fields =
    typeof error === "object" && error !== null
      ? (error as { readonly _tag?: unknown; readonly reason?: unknown })
      : {};
  if (fields._tag === "EditorialResultsError") {
    if (fields.reason === "unwritable") return "La base editorial no se pudo escribir.";
    return fields.reason === "unavailable"
      ? "La base editorial de este entorno no está disponible."
      : "La base editorial de este entorno no se pudo leer.";
  }
  if (fields._tag === "EnvironmentAuthorizationError") {
    return "Esta conexión no tiene permiso para importar el registro.";
  }
  return "No hubo respuesta del entorno.";
}
