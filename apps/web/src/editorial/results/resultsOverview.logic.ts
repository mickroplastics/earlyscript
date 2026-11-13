import type {
  EditorialResultsComparison,
  EditorialResultsDecision,
  EditorialResultsDecisionPage,
  EditorialResultsMode,
  EditorialResultsModeSummary,
  EditorialResultsSummary,
} from "@t3tools/contracts";

import {
  RESULTS_MODES,
  formatCount,
  formatDuration,
  hasDecisions,
  hasInboxActivity,
  modeLabel,
  modeSummary,
  stageChartMaxMs,
} from "./results.logic";

const NBSP = " ";

/** The detail tabs of the Results page, in order; `?tab=` carries the id. */
const RESULTS_TABS = [
  { id: "etapas", label: "Tiempo por etapa" },
  { id: "utilidad", label: "Utilidad y citas" },
  { id: "linea-base", label: "Línea base manual" },
  { id: "bandeja", label: "Bandeja y video" },
  { id: "decisiones", label: "Decisiones" },
] as const;
export type ResultsTab = (typeof RESULTS_TABS)[number];
export type ResultsTabId = ResultsTab["id"];

/**
 * The tabs present: without decisions, the manual baseline (its import is there before any
 * thread) and the inbox once it moved. Every tab while the summary is still unknown.
 */
export function visibleTabs(summary: EditorialResultsSummary | null): ReadonlyArray<ResultsTab> {
  if (summary === null || hasDecisions(summary)) return RESULTS_TABS;
  return RESULTS_TABS.filter(
    (tab) => tab.id === "linea-base" || (tab.id === "bandeja" && hasInboxActivity(summary)),
  );
}

/** `?tab=` as the route reads it: a known tab id, else nothing. */
export function resultsTabFromSearch(raw: unknown): ResultsTabId | undefined {
  return RESULTS_TABS.find((tab) => tab.id === raw)?.id;
}

/** The tab on screen: the one asked for when it is visible, else the first visible one. */
export function activeResultsTab(
  requested: ResultsTabId | undefined,
  visible: ReadonlyArray<ResultsTab>,
): ResultsTabId | undefined {
  return visible.find((tab) => tab.id === requested)?.id ?? visible[0]?.id;
}

/** "America/Argentina/Buenos_Aires" reads "Buenos Aires"; "UTC" stays. */
export function timeZoneLabel(timeZone: string): string {
  return (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "9 nov, 15:30", or "10 nov 2026, 0:11" with the year; the zone is said once elsewhere. */
export function shortResultsDate(
  iso: string,
  options: { readonly year?: boolean; readonly timeZone?: string } = {},
): string {
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    ...(options.year ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(new Date(iso));
}

/** A calendar day ("2026-10-01") in the same short form: "1 oct 2026". */
export function shortResultsDay(day: string): string {
  return new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}

/** A span of calendar days, each part said once: "1 al 14 oct 2026", "28 sept al 3 oct 2026". */
export function shortResultsDayRange(first: string, last: string): string {
  const end = shortResultsDay(last);
  if (first === last) return end;
  if (first.slice(0, 4) !== last.slice(0, 4)) return `${shortResultsDay(first)} al ${end}`;
  if (first.slice(0, 7) !== last.slice(0, 7)) {
    const start = new Intl.DateTimeFormat("es", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${first}T00:00:00Z`));
    return `${start} al ${end}`;
  }
  return `${Number(first.slice(8, 10))} al ${end}`;
}

function calendarYear(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es", { year: "numeric", timeZone }).format(new Date(iso));
}

/** A row's date: short, with the year only when it is not the year of `reference`. */
export function rowDateText(iso: string, reference: string | null, timeZone?: string): string {
  const zone = timeZone ?? localTimeZone();
  const year = reference === null || calendarYear(iso, zone) !== calendarYear(reference, zone);
  return shortResultsDate(iso, { year, timeZone: zone });
}

function calendarDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es", { dateStyle: "short", timeZone }).format(new Date(iso));
}

function timeOfDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es", { hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(iso),
  );
}

/** "9 nov, 15:30 a 10 nov 2026, 0:11 (Guayaquil)": the year once unless it changes. */
function decisionSpanText(first: string, last: string, timeZone: string): string {
  const zone = ` (${timeZoneLabel(timeZone)})`;
  const end = shortResultsDate(last, { year: true, timeZone });
  if (first === last) return `${end}${zone}`;
  if (calendarDay(first, timeZone) === calendarDay(last, timeZone)) {
    return `${shortResultsDate(first, { year: true, timeZone })} a ${timeOfDay(last, timeZone)}${zone}`;
  }
  const sameYear = calendarYear(first, timeZone) === calendarYear(last, timeZone);
  return `${shortResultsDate(first, { year: !sameYear, timeZone })} a ${end}${zone}`;
}

/** The line under the page title: how many decisions, when, and the closed threads per mode. */
export function headerLineText(summary: EditorialResultsSummary, timeZone: string): string {
  const parts = [formatCount(summary.decisionCount, "decisión", "decisiones")];
  if (summary.firstDecidedAt !== null && summary.lastDecidedAt !== null) {
    parts.push(decisionSpanText(summary.firstDecidedAt, summary.lastDecidedAt, timeZone));
  }
  const assisted = modeSummary(summary, "assisted")?.threads ?? 0;
  const manual = modeSummary(summary, "manual")?.threads ?? 0;
  parts.push(
    `${formatCount(assisted, "hilo asistido", "hilos asistidos")} y ${formatCount(manual, "manual", "manuales")} cerrados`,
  );
  return parts.join(" · ");
}

/** "10,5 min" as ["10,5", "min"]: the number large, the unit small; cut at the last NBSP. */
export function splitValueUnit(text: string): readonly [string, string] {
  const cut = text.lastIndexOf(NBSP);
  if (cut === -1) return [text, ""];
  return [text.slice(0, cut), text.slice(cut + 1)];
}

/**
 * Durations that share one unit lose it but the last: "5, 8,5 y 12 min". Mixed units keep
 * theirs: "45 min y 1 h 5 min".
 */
export function compactDurations(texts: ReadonlyArray<string>): ReadonlyArray<string> {
  const split = texts.map(splitValueUnit);
  const unit = split[0]?.[1];
  const shared =
    unit !== undefined &&
    unit !== "" &&
    split.every(([value, own]) => own === unit && !value.includes(NBSP));
  if (!shared) return texts;
  return split.map(([value], index) =>
    index === split.length - 1 ? `${value}${NBSP}${unit}` : value,
  );
}

function listText(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`;
}

export interface ProcessPoints {
  readonly assisted: ReadonlyArray<number>;
  readonly manual: ReadonlyArray<number>;
}

const inComparisonTotal = (decision: EditorialResultsDecision) =>
  (decision.cohort ?? "human") === "human" &&
  decision.current &&
  decision.clockDefinitive &&
  decision.coverage === "complete" &&
  decision.durations.totalMs !== null;

/**
 * One whole-process time per thread, the same threads the server's `total` comparison takes.
 * Null when the page misses decisions or a mode's count differs from the comparison's n (a
 * decision out of domain, which the client does not filter): a dot never contradicts a median.
 */
export function completeProcessPoints(
  page: EditorialResultsDecisionPage,
  comparison: EditorialResultsComparison,
): ProcessPoints | null {
  if (page.total > page.offset + page.decisions.length || page.offset > 0) return null;
  const pick = (mode: EditorialResultsMode) =>
    page.decisions
      .filter((decision) => decision.mode === mode && inComparisonTotal(decision))
      .map((decision) => decision.durations.totalMs ?? 0)
      .toSorted((a, b) => a - b);
  const assisted = pick("assisted");
  const manual = pick("manual");
  if (assisted.length !== comparison.assisted.n || manual.length !== comparison.manual.n) {
    return null;
  }
  return { assisted, manual };
}

/** The scale of the dot strip: the farthest dot, quartile or median of either mode. */
export function stripMaxMs(points: ProcessPoints | null, comparison: EditorialResultsComparison) {
  const ends = [comparison.assisted, comparison.manual].flatMap((stats) => [
    stats.q3Ms ?? 0,
    stats.medianMs ?? 0,
  ]);
  return Math.max(0, ...ends, ...(points?.assisted ?? []), ...(points?.manual ?? []));
}

export interface StripDot {
  readonly ms: number;
  /** Position on the scale, 0 to 1; the position is the datum, so dots never move sideways. */
  readonly x: number;
  /** The row of the stack, 0 next to the axis; a dot too close to another goes one row out. */
  readonly stack: number;
}

/**
 * Each dot in the lowest row where it stays `minGap` (a share of the scale) apart from the dots
 * already there, from the shortest time up; the result keeps the order of `values`.
 */
export function stripLayout(
  values: ReadonlyArray<number>,
  maxMs: number,
  minGap = 0,
): ReadonlyArray<StripDot> {
  const x = (ms: number) => (maxMs > 0 ? Math.min(1, Math.max(0, ms / maxMs)) : 0);
  const rows: Array<number> = [];
  const stacks = new Map<number, number>();
  const order = values.map((ms, index) => ({ ms, index })).toSorted((a, b) => a.ms - b.ms);
  for (const { ms, index } of order) {
    const at = x(ms);
    let stack = rows.findIndex((last) => at - last >= minGap && at !== last);
    if (stack === -1) stack = rows.length;
    rows[stack] = at;
    stacks.set(index, stack);
  }
  return values.map((ms, index) => ({ ms, x: x(ms), stack: stacks.get(index) ?? 0 }));
}

/** The dot strip in words, for its `aria-label`. */
export function timeStripText(
  points: ProcessPoints | null,
  comparison: EditorialResultsComparison,
): string {
  return RESULTS_MODES.map((mode) => {
    const stats = comparison[mode];
    const label = modeLabel(mode);
    if (stats.medianMs === null) return `${label}: sin hilos medidos.`;
    const median = `mediana ${formatDuration(stats.medianMs)}`;
    const values = points?.[mode];
    if (!values || values.length === 0) return `${label}: ${median}.`;
    return `${label}: ${listText(compactDurations(values.map(formatDuration)))}; ${median}.`;
  }).join(" ");
}

export interface UtilityBarGroup {
  readonly score: number;
  readonly counts: Readonly<Record<EditorialResultsMode, number>>;
  /** Height of each column relative to the tallest of all, 0 to 1. */
  readonly heights: Readonly<Record<EditorialResultsMode, number>>;
}

const distributionOf = (summary: EditorialResultsSummary, mode: EditorialResultsMode) =>
  modeSummary(summary, mode)?.utility.distribution ?? [];

/** Threads per utility score (1 to 5) and mode, on one shared height. */
export function utilityBars(summary: EditorialResultsSummary): ReadonlyArray<UtilityBarGroup> {
  const max = Math.max(1, ...RESULTS_MODES.flatMap((mode) => distributionOf(summary, mode)));
  return [1, 2, 3, 4, 5].map((score) => {
    const count = (mode: EditorialResultsMode) => distributionOf(summary, mode)[score - 1] ?? 0;
    const counts = { assisted: count("assisted"), manual: count("manual") };
    return {
      score,
      counts,
      heights: { assisted: counts.assisted / max, manual: counts.manual / max },
    };
  });
}

/** "Fichas por puntuación. Asistido: 6 con 5. Manual: 2 con 3, 3 con 4 y 1 con 5." */
export function utilityDistributionText(summary: EditorialResultsSummary): string {
  const groups = utilityBars(summary);
  const side = (mode: EditorialResultsMode) => {
    const scored = groups
      .filter((group) => group.counts[mode] > 0)
      .map((group) => `${group.counts[mode]} con ${group.score}`);
    return `${modeLabel(mode)}: ${scored.length === 0 ? "sin fichas" : listText(scored)}.`;
  };
  return `Fichas por puntuación. ${RESULTS_MODES.map(side).join(" ")}`;
}

/** The share of claims with a marker, 0 to 1; nothing to share without claims. */
export function citationShare(entry: EditorialResultsModeSummary | undefined): number {
  return Math.min(1, Math.max(0, entry?.citations.ratio ?? 0));
}

/** One row per decided script: current human decisions of the mode, newest first. */
export function scriptRows(
  decisions: ReadonlyArray<EditorialResultsDecision>,
  mode: EditorialResultsMode,
): ReadonlyArray<EditorialResultsDecision> {
  return decisions
    .filter(
      (decision) =>
        decision.mode === mode && decision.current && (decision.cohort ?? "human") === "human",
    )
    .toSorted((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}

/** Agent trials with no decision in the log: the table has no row to link them from. */
export function trialsWithoutDecision<T extends { readonly threadId: string }>(
  trials: ReadonlyArray<T>,
  decisions: ReadonlyArray<Pick<EditorialResultsDecision, "threadId">>,
): ReadonlyArray<T> {
  const decided = new Set(decisions.map((decision) => decision.threadId));
  return trials.filter((trial) => !decided.has(trial.threadId));
}

export function hasVideoResults(summary: EditorialResultsSummary): boolean {
  return summary.modes.some((mode) => mode.withVideoResults > 0);
}

/**
 * The stage chart's scale on the page, which adds a «Total» row: the stage scale, widened to
 * the whole-process medians and quartiles. The exported figure keeps `stageChartMaxMs`.
 */
export function stageChartWithTotalMaxMs(
  summary: EditorialResultsSummary,
  total: EditorialResultsComparison | undefined,
): number {
  const ends = total
    ? [total.assisted, total.manual].flatMap((stats) => [stats.q3Ms ?? 0, stats.medianMs ?? 0])
    : [];
  return Math.max(stageChartMaxMs(summary), ...ends);
}
