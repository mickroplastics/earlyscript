import type {
  EditorialDurationStats,
  EditorialResultsAction,
  EditorialResultsComparisonKey,
  EditorialResultsMode,
  EditorialResultsModeSummary,
  EditorialResultsStage,
  EditorialResultsSummary,
} from "@t3tools/contracts";

/** Sections of the Results page, in order; the sidebar links to them by id. */
export const RESULTS_SECTIONS = [
  { id: "tiempos", label: "Tiempo por ficha" },
  { id: "etapas", label: "Etapas" },
  { id: "utilidad", label: "Utilidad y citas" },
  { id: "bandeja", label: "Bandeja" },
  { id: "video", label: "Métricas de video" },
  { id: "decisiones", label: "Decisiones" },
] as const;
export type ResultsSectionId = (typeof RESULTS_SECTIONS)[number]["id"];

export const RESULTS_MODES: ReadonlyArray<EditorialResultsMode> = ["assisted", "manual"];

export const RESULTS_STAGES: ReadonlyArray<EditorialResultsStage> = [
  "explore",
  "read",
  "write",
  "decide",
];

const MODE_LABELS: Readonly<Record<EditorialResultsMode, string>> = {
  assisted: "Asistido",
  manual: "Manual",
};

const STAGE_LABELS: Readonly<Record<EditorialResultsStage, string>> = {
  explore: "Explorar",
  read: "Leer",
  write: "Escribir",
  decide: "Decidir",
};

const ACTION_LABELS: Readonly<Record<EditorialResultsAction, string>> = {
  accept: "Aceptada",
  edit: "Editada",
  reject: "Rechazada",
};

export function modeLabel(mode: EditorialResultsMode): string {
  return MODE_LABELS[mode];
}

export function stageLabel(stage: EditorialResultsStage): string {
  return STAGE_LABELS[stage];
}

export function actionLabel(action: EditorialResultsAction): string {
  return ACTION_LABELS[action];
}

/**
 * The three comparisons of the manual mode design (doc 04, decision 9). Writing and the whole
 * process stay apart: a writing time is never read as a process time.
 */
export const COMPARISON_TEXT: Readonly<
  Record<
    EditorialResultsComparisonKey,
    { readonly title: string; readonly assisted: string; readonly manual: string }
  >
> = {
  explore: {
    title: "Explorar",
    assisted: "Tendencias: explorar y leer el expediente",
    manual: "Explorar a mano",
  },
  write: {
    title: "Escribir",
    assisted: "Escribir con asistente",
    manual: "Escribir a mano",
  },
  total: {
    title: "Proceso completo",
    assisted: "Todas las etapas, asistido",
    manual: "Todas las etapas, manual",
  },
};

const MINUTE_MS = 60_000;

/** "26 min", "1 h 40 min", "45 s"; rounded to the minute from one minute up. */
export function formatDuration(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** "RIC 24 min–28 min": the interquartile range as its two ends. */
export function iqrText(stats: EditorialDurationStats): string | null {
  if (stats.q1Ms === null || stats.q3Ms === null) return null;
  return `RIC ${formatDuration(stats.q1Ms)}–${formatDuration(stats.q3Ms)}`;
}

/** "26 min · RIC 24 min–28 min · n = 3", or "sin datos · n = 0". */
export function statsText(stats: EditorialDurationStats): string {
  if (stats.medianMs === null) return `sin datos · n = ${stats.n}`;
  const iqr = iqrText(stats);
  return [formatDuration(stats.medianMs), iqr, `n = ${stats.n}`]
    .filter((part) => part !== null)
    .join(" · ");
}

/**
 * The descriptive difference of the two medians, with both n. Never a percentage or a
 * "saving": with unpaired threads on different topics it is a description, not an effect.
 */
export function medianDifferenceText(
  assisted: EditorialDurationStats,
  manual: EditorialDurationStats,
): string | null {
  if (assisted.medianMs === null || manual.medianMs === null) return null;
  const difference = manual.medianMs - assisted.medianMs;
  const sizes = `n = ${assisted.n} y ${manual.n}`;
  if (Math.round(difference / MINUTE_MS) === 0 && Math.abs(difference) < MINUTE_MS) {
    return `Medianas iguales al minuto (${sizes})`;
  }
  const magnitude = formatDuration(Math.abs(difference));
  return difference > 0
    ? `Mediana manual ${magnitude} mayor (${sizes})`
    : `Mediana asistida ${magnitude} mayor (${sizes})`;
}

const percentFormat = new Intl.NumberFormat("es", {
  style: "percent",
  maximumFractionDigits: 0,
});
const meanFormat = new Intl.NumberFormat("es", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatPercent(ratio: number): string {
  return percentFormat.format(ratio);
}

function formatMean(value: number): string {
  return meanFormat.format(value);
}

/** "4,0 de 5" or "sin datos". */
export function utilityText(summary: EditorialResultsModeSummary): string {
  return summary.utility.mean === null ? "sin datos" : `${formatMean(summary.utility.mean)} de 5`;
}

/** "11 de 13 afirmaciones · 3 guiones". */
export function citationDetail(summary: EditorialResultsModeSummary): string {
  const { claims, cited, threads } = summary.citations;
  if (threads === 0) return "sin versión decidida del guion";
  return `${cited} de ${formatCount(claims, "afirmación", "afirmaciones")} · ${formatCount(threads, "guion", "guiones")}`;
}

export function hasDecisions(summary: EditorialResultsSummary): boolean {
  return summary.decisionCount > 0;
}

export function modeSummary(
  summary: EditorialResultsSummary,
  mode: EditorialResultsMode,
): EditorialResultsModeSummary | undefined {
  return summary.modes.find((entry) => entry.mode === mode);
}

export function stageStats(
  summary: EditorialResultsModeSummary | undefined,
  stage: EditorialResultsStage,
): EditorialDurationStats | undefined {
  return summary?.stages.find((entry) => entry.stage === stage)?.stats;
}

/** Threads whose clock awaited resolution, left out of every time statistic. */
export function provisionalNote(summary: EditorialResultsSummary): string | null {
  const count = summary.modes.reduce((sum, mode) => sum + mode.provisionalClock, 0);
  if (count === 0) return null;
  return `${formatCount(count, "hilo queda", "hilos quedan")} fuera de los tiempos: su reloj tiene un tramo sin resolver tras un cierre inesperado.`;
}

/** The common horizontal scale of the stage chart: the largest third quartile or median. */
export function stageChartMaxMs(summary: EditorialResultsSummary): number {
  const ends = summary.modes.flatMap((mode) =>
    mode.stages.flatMap(({ stats }) => [stats.q3Ms ?? 0, stats.medianMs ?? 0, stats.maxMs ?? 0]),
  );
  return Math.max(MINUTE_MS, ...ends);
}

/** "1–20 de 46". */
export function pageRangeText(offset: number, shown: number, total: number): string {
  if (total === 0 || shown === 0) return `0 de ${total}`;
  return `${offset + 1}–${offset + shown} de ${total}`;
}

const integerFormat = new Intl.NumberFormat("es");

export function formatInteger(value: number): string {
  return integerFormat.format(value);
}

/** "trend:local-models" reads "local-models"; a thread without trend shows its short id. */
export function decisionThreadFallback(input: {
  readonly threadId: string;
  readonly trendKey: string | null;
}): string {
  if (input.trendKey !== null) return input.trendKey.replace(/^trend:/, "");
  return `Hilo ${input.threadId.slice(0, 8)}`;
}

/** "1 h 40 min", "≥ 33 min" when a segment awaited resolution, "sin reloj" if none ran. */
export function decisionTotalText(decision: {
  readonly clockDefinitive: boolean;
  readonly durations: { readonly totalMs: number | null };
}): string {
  if (decision.durations.totalMs === null) return "sin reloj";
  return `${decision.clockDefinitive ? "" : "≥ "}${formatDuration(decision.durations.totalMs)}`;
}
