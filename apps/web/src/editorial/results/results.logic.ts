import type {
  EditorialDurationStats,
  EditorialResultsAction,
  EditorialResultsComparison,
  EditorialResultsComparisonKey,
  EditorialResultsMode,
  EditorialResultsModeSummary,
  EditorialResultsStage,
  EditorialResultsSummary,
} from "@t3tools/contracts";

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
  explore: "Buscar ideas",
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
 * The comparisons of the manual mode design (doc 04, decision 9). Writing and the whole
 * process stay apart: a writing time is never read as a process time. The whole process only
 * takes threads with complete coverage; `recorded` takes every timed thread.
 */
export const COMPARISON_TEXT: Readonly<
  Record<EditorialResultsComparisonKey, { readonly title: string; readonly measures: string }>
> = {
  explore: {
    title: "Buscar ideas",
    measures: "Asistido: explorar y leer la ficha de tendencia. Manual: explorar a mano.",
  },
  write: {
    title: "Escribir",
    measures: "Escribir el guion, con asistente o a mano.",
  },
  total: {
    title: "Proceso completo",
    measures: "Todas las etapas de su modo, solo en hilos que las registraron todas.",
  },
  recorded: {
    title: "Total de etapas registradas",
    measures: "Suma de las etapas registradas, también en hilos sin todas.",
  },
};

/** The comparisons shown as cards; `recorded` is a line under them. */
export function comparisonCards(
  comparisons: ReadonlyArray<EditorialResultsComparison>,
): ReadonlyArray<EditorialResultsComparison> {
  return comparisons.filter((comparison) => comparison.key !== "recorded");
}

/**
 * Who the whole process leaves out, or who a recorded total takes in: threads without every
 * stage of their mode (assisted: leer, escribir y decidir; manual: explorar, escribir y decidir).
 */
export function coverageNote(comparison: EditorialResultsComparison): string | null {
  const count = comparison.partial.assisted + comparison.partial.manual;
  if (comparison.key !== "recorded" || count === 0) return null;
  return `Cobertura parcial: incluye ${formatCount(count, "hilo", "hilos")} sin todas las etapas de su modo; no es el proceso completo.`;
}

/** "Total de etapas registradas: asistido 40 min (n = 4) · manual 1 h 40 min (n = 3)". */
export function recordedTotalText(comparison: EditorialResultsComparison): string {
  const side = (mode: EditorialResultsMode, stats: EditorialDurationStats) =>
    `${MODE_LABELS[mode].toLowerCase()} ${stats.medianMs === null ? "sin datos" : formatDuration(stats.medianMs)} (${sizeText(stats.n)})`;
  return `${COMPARISON_TEXT.recorded.title}, mediana: ${side("assisted", comparison.assisted)} · ${side("manual", comparison.manual)}`;
}

const MINUTE_MS = 60_000;

/** Joins a number to its unit so a narrow column never breaks "1 h" or "n = 3" apart. */
const NBSP = "\u00a0";

/** "n = 3", unbreakable. */
export function sizeText(n: number): string {
  return `n${NBSP}=${NBSP}${n}`;
}

/** Why the decisions page failed, in the operator's words, from the RPC error. */
export function decisionsFailureText(error: unknown): string {
  const fields =
    typeof error === "object" && error !== null
      ? (error as { readonly _tag?: unknown; readonly reason?: unknown })
      : {};
  if (fields._tag === "EditorialResultsError") {
    return fields.reason === "unavailable"
      ? "La base editorial de este entorno no está disponible."
      : "La base editorial de este entorno no se pudo leer.";
  }
  if (fields._tag === "EnvironmentAuthorizationError") {
    return "Este entorno no autoriza la lectura de resultados.";
  }
  return "No hubo respuesta del entorno.";
}

/** "26 min", "1 h 40 min", "45 s"; rounded to the minute from one minute up. */
export function formatDuration(ms: number): string {
  if (ms > 0 && ms < 500) return `<${NBSP}1${NBSP}s`;
  if (ms < MINUTE_MS) return `${Math.round(ms / 1000)}${NBSP}s`;
  const minutes = Math.round(ms / 30_000) / 2;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const number = new Intl.NumberFormat("es", { maximumFractionDigits: 1 });
  if (hours === 0) return `${number.format(rest)}${NBSP}min`;
  return rest === 0
    ? `${hours}${NBSP}h`
    : `${hours}${NBSP}h${NBSP}${number.format(rest)}${NBSP}min`;
}

export function formatCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * "RIC 24 a 28 min" under an hour, "RIC 58 min a 1 h 2 min" across units. One thread has no
 * spread to describe, so a single value gives none.
 */
export function iqrText(stats: EditorialDurationStats): string | null {
  if (stats.q1Ms === null || stats.q3Ms === null || stats.n < 2) return null;
  const low = formatDuration(stats.q1Ms);
  const high = formatDuration(stats.q3Ms);
  if (low === high) return `cuartiles en ${low}`;
  const unit = `${NBSP}min`;
  if (low.endsWith(unit) && high.endsWith(unit) && !low.includes("h") && !high.includes("h")) {
    return `RIC ${low.slice(0, -4)} a ${high}`;
  }
  return `RIC ${low} a ${high}`;
}

/** "1 aceptada, 1 editada, 1 rechazada". */
export function actionsText(actions: EditorialResultsModeSummary["actions"]): string {
  return [
    formatCount(actions.accept, "aceptada", "aceptadas"),
    formatCount(actions.edit, "editada", "editadas"),
    formatCount(actions.reject, "rechazada", "rechazadas"),
  ].join(", ");
}

/** "26 min · RIC 24 a 28 min · n = 3", or "sin datos · n = 0". */
export function statsText(stats: EditorialDurationStats): string {
  if (stats.medianMs === null) return `sin datos · ${sizeText(stats.n)}`;
  const iqr = iqrText(stats);
  return [formatDuration(stats.medianMs), iqr, sizeText(stats.n)]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Below this many threads in a mode, a median is a handful of cases. */
const SMALL_SAMPLE = 3;

/**
 * The descriptive difference of the two medians, with both n. Never a percentage or a
 * "saving": with unpaired threads on different topics it is a description, not an effect.
 */
export function medianDifferenceText(
  assisted: EditorialDurationStats,
  manual: EditorialDurationStats,
): string {
  if (assisted.medianMs === null || manual.medianMs === null) {
    const missing = [
      assisted.medianMs === null ? "asistido" : null,
      manual.medianMs === null ? "manual" : null,
    ].filter((mode) => mode !== null);
    if (missing.length === 2) {
      return "Sin hilos medidos en ningún modo: no hay diferencia que describir.";
    }
    const present = assisted.medianMs === null ? manual : assisted;
    const few =
      present.n < SMALL_SAMPLE
        ? " Con tan pocos hilos describe casos sueltos, no una tendencia."
        : "";
    return `Sin hilos medidos en modo ${missing[0]}: no hay diferencia que describir.${few}`;
  }
  const difference = manual.medianMs - assisted.medianMs;
  const sizes = `n${NBSP}=${NBSP}${assisted.n}${NBSP}y${NBSP}${manual.n}`;
  const few =
    Math.min(assisted.n, manual.n) < SMALL_SAMPLE
      ? " Con tan pocos hilos describe casos sueltos, no una tendencia."
      : "";
  if (Math.round(difference / MINUTE_MS) === 0 && Math.abs(difference) < MINUTE_MS) {
    return `Medianas iguales al minuto (${sizes}).${few}`;
  }
  const magnitude = formatDuration(Math.abs(difference));
  return difference > 0
    ? `Mediana manual ${magnitude} mayor (${sizes}).${few}`
    : `Mediana asistida ${magnitude} mayor (${sizes}).${few}`;
}

/** Why a side of a comparison has no median: no thread, or every one awaiting resolution. */
export function emptySideText(stats: EditorialDurationStats, provisional: number): string {
  if (stats.n > 0 || provisional === 0) return sizeText(stats.n);
  return `${sizeText(0)} · ${formatCount(provisional, "hilo espera", "hilos esperan")} resolver un tramo`;
}

const meanFormat = new Intl.NumberFormat("es", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** "4,0": a utility mean with one decimal. */
export function meanText(value: number): string {
  return meanFormat.format(value);
}

/** "2 de 7" threads with video metrics, or "sin hilos" before the mode has any. */
export function videoCoverageText(summary: EditorialResultsModeSummary): string {
  return summary.threads === 0 ? "sin hilos" : `${summary.withVideoResults} de ${summary.threads}`;
}

/** "4,0 de 5" or "sin datos". */
export function utilityText(summary: EditorialResultsModeSummary): string {
  return summary.utility.mean === null ? "sin datos" : `${meanText(summary.utility.mean)} de 5`;
}

/** "11 de 13 afirmaciones · 3 guiones". */
export function citationDetail(summary: EditorialResultsModeSummary): string {
  const { claims, cited, threads } = summary.citations;
  if (threads === 0) return "sin versión decidida del guion";
  return `${cited} de ${claims} frases con marcador de fuente · ${formatCount(threads, "guion", "guiones")}`;
}

export function hasDecisions(summary: EditorialResultsSummary): boolean {
  return summary.decisionCount > 0 || (summary.trials?.length ?? 0) > 0;
}

/** Trends get read and dismissed before any decision; the counters show once one moved. */
export function hasInboxActivity(summary: EditorialResultsSummary): boolean {
  const { read, observing, dismissed, production } = summary.inbox;
  return read + observing + dismissed + production > 0;
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

/** Decisions whose stored values are out of their domain stay out of every statistic. */
export function domainNote(summary: EditorialResultsSummary): string | null {
  if (summary.excludedByDomain === 0) return null;
  return `${formatCount(summary.excludedByDomain, "decisión queda", "decisiones quedan")} fuera de los agregados: un valor guardado está fuera de su dominio (utilidad de 1 a 5, tiempos y conteos no negativos).`;
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

/**
 * A thread's name in the decisions table: its title without the "Video: " every video thread
 * carries, else its trend's dossier label; never an id or a trend key.
 */
export function decisionThreadLabel(
  decision: { readonly mode: EditorialResultsMode; readonly trendLabel: string | null },
  title: string | undefined,
): string {
  const trimmed = title?.replace(/^Video:\s*/, "").trim();
  if (trimmed) return trimmed;
  if (decision.trendLabel !== null) return `Tendencia: ${decision.trendLabel}`;
  return decision.mode === "manual" ? "Hilo manual sin título" : "Hilo sin título";
}

/** A trial thread named by its place among the trials, as «Ensayo 2», when its title is unknown. */
export function trialName(
  trials: ReadonlyArray<{ readonly threadId: string }>,
  threadId: string,
): string {
  const index = trials.findIndex((trial) => trial.threadId === threadId);
  return index === -1 ? "Ensayo" : `Ensayo ${index + 1}`;
}

/** "1 h 40 min", "≥ 33 min" when a segment awaited resolution, "sin reloj" if none ran. */
export function decisionTotalText(decision: {
  readonly clockDefinitive: boolean;
  readonly durations: { readonly totalMs: number | null };
}): string {
  if (decision.durations.totalMs === null) return "sin reloj";
  return `${decision.clockDefinitive ? "" : "≥ "}${formatDuration(decision.durations.totalMs)}`;
}

function localResultsDate(iso: string): string {
  return (
    new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    ) +
    " · " +
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
}

/** Achievements, sample and limits in words; `formatDate` writes the dates of the sample. */
export function closingStrip(
  summary: EditorialResultsSummary,
  formatDate: (iso: string) => string = localResultsDate,
  formatDays: (first: string, last: string) => string = (first, last) =>
    first === last ? first : `${first} al ${last}`,
) {
  const human = summary.humanThreads ?? summary.modes.reduce((sum, mode) => sum + mode.threads, 0);
  const closed = summary.modes.reduce((sum, mode) => sum + mode.threads, 0);
  const baseline = summary.baselineSample;
  const manual = modeSummary(summary, "manual")?.threads ?? 0;
  const trialThreads = summary.trials ?? [];
  const trials = trialThreads.length;
  const firstTrial = trialThreads[0];
  const lastTrial = trialThreads.at(-1);
  return [
    {
      title: "Logros",
      text: `${closed} hilos humanos con decisión registrada. ${manual === 0 ? "Todavía sin hilos manuales cerrados; consulta la línea base manual." : `${manual} hilos manuales cerrados.`} ${
        closed === 0
          ? "Todavía sin tiempos ni utilidad humana para comparar."
          : `${summary.modes
              .filter((mode) => mode.threads > 0)
              .map(
                (mode) =>
                  `${modeLabel(mode.mode)}: ${mode.total.medianMs === null ? "tiempo todavía sin reloj definitivo" : `mediana registrada ${formatDuration(mode.total.medianMs)}`}; ${mode.utility.mean === null ? "sin utilidad" : `utilidad ${meanText(mode.utility.mean)} de 5`}.`,
              )
              .join(" ")}`
      }`,
    },
    {
      title: "Muestra",
      text: `${human} hilos humanos, con y sin decisión. ${baseline?.blocks ?? 0} bloques de línea base${baseline?.firstDay ? ` del ${formatDays(baseline.firstDay, baseline.lastDay ?? baseline.firstDay)}` : ", todavía sin registro importado"}. ${formatCount(trials, "ensayo excluido", "ensayos excluidos")}${firstTrial && lastTrial ? `, fechas de creación entre ${formatDate(firstTrial.createdAt)} y ${formatDate(lastTrial.createdAt)}` : ""}. ${summary.firstDecidedAt ? `Decisiones humanas desde ${formatDate(summary.firstDecidedAt)} hasta ${formatDate(summary.lastDecidedAt!)}.` : "Todavía sin fechas de decisiones humanas."}`,
    },
    {
      title: "Límites",
      text: "Una persona; tiempos autoinformados; línea base reconstruida en parte cuando así consta en el registro. Ensayos de agente fuera de los indicadores. Este registro no mide un efecto.",
    },
  ];
}
