// Daily series and stage per signal, ported from Earlywindow's src/engine/series.ts
// (method 0.01, steps 6 and 7). Days are UTC; every window ends the day before the cutoff.
import type {
  CurvePoint,
  GrowthSource,
  SignalStage,
} from "@earlyscript/editorial-contracts/dossier";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type {
  CoverageStatus,
  DataGap,
  DataGapReason,
  SourceCoverage,
  SourceId,
} from "@earlyscript/editorial-contracts/source";

import { daysBefore } from "./days.ts";
import { isSampleSource } from "./sources/index.ts";

export interface SeriesItem {
  readonly id: string;
  readonly source: SourceId;
  readonly day: string;
  readonly author: string | null;
  readonly entities: ReadonlyArray<string>;
}

export interface StageResult {
  readonly stage: SignalStage;
  readonly growth: number;
  readonly items_7d: number;
  readonly items_prev_7d: number;
  readonly authors_7d: number;
  /** coverage_rule equivalent: each counted source's windows. */
  readonly growth_sources?: Array<GrowthSource>;
}

/** coverage[source][day]; a missing day was not collected. */
export type CoverageIndex = Map<SourceId, Map<string, CoverageStatus>>;

/** A source knows a day it collected: `complete`, or `partial` when truncated by a fixed rule. */
export const sourceKnows = (coverage: CoverageIndex, source: SourceId, day: string): boolean => {
  const status = coverage.get(source)?.get(day);
  return status === "complete" || status === "partial";
};

/** Collected as fully as the source can: `complete`, or `partial` for a sample source. */
const sourceFull = (coverage: CoverageIndex, source: SourceId, day: string): boolean => {
  const status = coverage.get(source)?.get(day);
  return status === "complete" || (status === "partial" && isSampleSource(source));
};

export const isKnown = (
  coverage: CoverageIndex,
  sources: ReadonlyArray<SourceId>,
  day: string,
): boolean => sources.every((source) => sourceKnows(coverage, source, day));

/** A series only sums observations a source made on a day it knows. */
const observed = (items: ReadonlyArray<SeriesItem>, coverage: CoverageIndex) =>
  items.filter((item) => sourceKnows(coverage, item.source, item.day));

/**
 * A source counts only through items whose entities no item of another source shares:
 * a repository and the story that links it are one observation.
 */
function independentItems(items: ReadonlyArray<SeriesItem>): Set<string> {
  const bySource = new Map<SourceId, Set<string>>();
  for (const item of items) {
    const set = bySource.get(item.source) ?? new Set<string>();
    for (const entity of item.entities) set.add(entity);
    bySource.set(item.source, set);
  }
  const independent = new Set<string>();
  for (const item of items) {
    const shared = item.entities.some((entity) =>
      [...bySource].some(([source, set]) => source !== item.source && set.has(entity)),
    );
    if (!shared) independent.add(item.id);
  }
  return independent;
}

function countSources(items: ReadonlyArray<SeriesItem>, independent: Set<string>): number {
  if (items.length === 0) return 0;
  return Math.max(1, new Set(items.filter((i) => independent.has(i.id)).map((i) => i.source)).size);
}

export function corroboration(items: ReadonlyArray<SeriesItem>): "multi_source" | "single_source" {
  return countSources(items, independentItems(items)) >= 2 ? "multi_source" : "single_source";
}

/** `known`: every source of the run collected the day, so the point's count is an observation. */
export function dailyCurve(
  allItems: ReadonlyArray<SeriesItem>,
  days: ReadonlyArray<string>,
  coverage: CoverageIndex,
  sources: ReadonlyArray<SourceId>,
): Array<CurvePoint> {
  const items = observed(allItems, coverage);
  const independent = independentItems(items);
  return days.map((day) => {
    const today = items.filter((item) => item.day === day);
    const authors = new Set(today.flatMap((item) => (item.author === null ? [] : [item.author])));
    return {
      day,
      items: today.length,
      sources: countSources(today, independent),
      authors: authors.size,
      known: isKnown(coverage, sources, day),
    };
  });
}

/**
 * Stage from the last `context_days` before the cutoff. `all_sources` (Earlywindow v0.02)
 * leaves the signal unclassified when any source of the run misses any context day, so one
 * lost day empties the list. `per_source` counts what was observed and leaves it
 * unclassified only when one 7-day window has no day known by any of the signal's sources.
 */
export function classify(
  allItems: ReadonlyArray<SeriesItem>,
  cutoffDay: string,
  coverage: CoverageIndex,
  sources: ReadonlyArray<SourceId>,
  cfg: EngineConfig["stage"],
): StageResult {
  if (cfg.coverage_rule === "equivalent")
    return classifyEquivalent(allItems, cutoffDay, coverage, sources, cfg);
  const items = observed(allItems, coverage);
  const context = daysBefore(cutoffDay, cfg.context_days);
  const last7 = context.slice(-7);
  const prev7 = context.slice(-14, -7);
  const recent = items.filter((item) => last7.includes(item.day));
  const items_7d = recent.length;
  const items_prev_7d = items.filter((item) => prev7.includes(item.day)).length;
  const authors_7d = new Set(recent.flatMap((item) => (item.author === null ? [] : [item.author])))
    .size;
  const growth = Math.log((items_7d + 1) / (items_prev_7d + 1));
  const signalSources = [...new Set(allItems.map((item) => item.source))];
  const windowKnown = (days: ReadonlyArray<string>) =>
    days.some((day) => signalSources.some((source) => sourceKnows(coverage, source, day)));
  const classifiable =
    cfg.coverage_rule === "all_sources"
      ? context.every((day) => isKnown(coverage, sources, day))
      : windowKnown(last7) && windowKnown(prev7);
  let stage: SignalStage;
  if (!classifiable) stage = "unclassified";
  else if (growth >= cfg.growth_min && items_7d >= cfg.growing_min_items_7d) stage = "growing";
  else if (growth <= cfg.fading_max) stage = "fading";
  else stage = "steady";
  return { stage, growth, items_7d, items_prev_7d, authors_7d };
}

/**
 * A source counts only on days it collected fully and only when both 7-day windows have
 * one; its counts become rates per day times 7. A source that started inside the last
 * window adds no growth. Stage gates use observed items of the last 7 days, as per_source.
 */
function classifyEquivalent(
  allItems: ReadonlyArray<SeriesItem>,
  cutoffDay: string,
  coverage: CoverageIndex,
  sources: ReadonlyArray<SourceId>,
  cfg: EngineConfig["stage"],
): StageResult {
  const items = observed(allItems, coverage);
  const context = daysBefore(cutoffDay, cfg.context_days);
  const last7 = context.slice(-7);
  const prev7 = context.slice(-14, -7);
  const recent = items.filter((item) => last7.includes(item.day));
  const items_7d = recent.length;
  const items_prev_7d = items.filter((item) => prev7.includes(item.day)).length;
  const authors_7d = new Set(recent.flatMap((item) => (item.author === null ? [] : [item.author])))
    .size;
  let e7 = 0;
  let ePrev = 0;
  const growth_sources: Array<GrowthSource> = [];
  let anyComparable = false;
  const counted = new Set(items.map((item) => item.source));
  for (const source of sources) {
    const full7 = last7.filter((day) => sourceFull(coverage, source, day));
    const fullPrev = prev7.filter((day) => sourceFull(coverage, source, day));
    const comparable = full7.length > 0 && fullPrev.length > 0;
    anyComparable ||= comparable;
    const own = items.filter((item) => item.source === source);
    const n7 = own.filter((item) => full7.includes(item.day)).length;
    const nPrev = own.filter((item) => fullPrev.includes(item.day)).length;
    if (comparable) {
      e7 += (n7 * 7) / full7.length;
      ePrev += (nPrev * 7) / fullPrev.length;
    }
    if (counted.has(source))
      growth_sources.push({
        source,
        days_7d: full7.length,
        days_prev_7d: fullPrev.length,
        items_7d: n7,
        items_prev_7d: nPrev,
        comparable,
      });
  }
  const growth = Math.log((e7 + 1) / (ePrev + 1));
  const classifiable =
    counted.size === 0 ? anyComparable : growth_sources.some((row) => row.comparable);
  let stage: SignalStage;
  if (!classifiable) stage = "unclassified";
  else if (growth >= cfg.growth_min && items_7d >= cfg.growing_min_items_7d) stage = "growing";
  else if (growth <= cfg.fading_max) stage = "fading";
  else stage = "steady";
  return { stage, growth, items_7d, items_prev_7d, authors_7d, growth_sources };
}

function gapReason(status: CoverageStatus | undefined): DataGapReason {
  switch (status) {
    case "partial":
      return "partial";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
      return "fetch_failed";
    default:
      return "not_collected";
  }
}

export function coverageSummary(
  coverage: CoverageIndex,
  sources: ReadonlyArray<SourceId>,
  days: ReadonlyArray<string>,
): { by_source: Array<SourceCoverage>; data_gaps: Array<DataGap> } {
  const by_source: Array<SourceCoverage> = [];
  const data_gaps: Array<DataGap> = [];
  for (const source of sources) {
    const row = { source, days_complete: 0, days_partial: 0, days_unavailable: 0 };
    for (const day of days) {
      const status = coverage.get(source)?.get(day);
      if (status === "complete") row.days_complete++;
      else if (status === "partial") row.days_partial++;
      else row.days_unavailable++;
      if (!sourceFull(coverage, source, day))
        data_gaps.push({ source, day, reason: gapReason(status) });
    }
    by_source.push(row);
  }
  return { by_source, data_gaps };
}

// engine.v3 (contract v4.2 §2.5): weekly series aligned to the cutoff over URL-unique items of
// the comparable sources, without item_min. W_k = [t − 7(k+1) d, t − 7k d).

const TRACKING_PARAM = /^(utm_|ref$|ref_src$|source$|fbclid$|gclid$)/;

/**
 * The URL two sources share when they point at the same page: https, host without `www.`,
 * no fragment, no tracking parameters, no trailing slash. Null for a missing or unparsable URL.
 */
export function canonicalUrl(url: string | null): string | null {
  if (url === null || url.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...parsed.searchParams]
    .filter(([name]) => !TRACKING_PARAM.test(name.toLowerCase()))
    .toSorted(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const query = params.length === 0 ? "" : `?${new URLSearchParams(params).toString()}`;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `https://${host}${parsed.port ? `:${parsed.port}` : ""}${path}${query}`;
}

/** An observation of a topic: a member, or an item another source published with its URL. */
export interface UnitItem {
  readonly id: string;
  readonly source: SourceId;
  readonly ms: number;
  readonly author: string | null;
  /** Canonical URL, or `id:<item id>` when the item has none: one key, one observation. */
  readonly key: string;
}

export interface WeeklyCohort {
  readonly cutoffMs: number;
  readonly historyFromMs: number;
  readonly comparable: ReadonlyArray<SourceId>;
  /** `${source}|${k}` of the "?" weeks. */
  readonly unknown: ReadonlySet<string>;
  readonly incompleteShare: number;
}

export interface SourceWeeks {
  /** URL-unique items of the source per week W0..W4; null for a "?" week of a comparable source. */
  readonly weeks: Array<number | null>;
  readonly authorsW0: number | null;
}

export interface WeeklySeries {
  /** n(W0)..n(W4). */
  readonly weeks: Array<number>;
  /** URL-unique observations of the comparable sources in the history window. */
  readonly life: number;
  /** Σ 2^(−(t − t_i)/τ) over those observations, t_i the first time each key was seen. */
  readonly pop: number;
  readonly authorsW0: number;
  readonly sourcesW0: Array<SourceId>;
  /** Share of the W0..W2 items of comparable sources that fall in "?" weeks. */
  readonly unknownShare: number;
  readonly incomplete: boolean;
  /** First observation among the comparable sources over the whole life, in ms. */
  readonly firstMs: number | null;
  readonly firstBySource: Map<SourceId, { ms: number; id: string }>;
  readonly bySource: Map<SourceId, SourceWeeks>;
}

const WEEK_MS = 7 * 86_400_000;
const SERIES_WEEK_COUNT = 5;

/**
 * Items at or after the cutoff must not be passed; the function also refuses them. Every
 * clustered source gets a row (`bySource`); only the comparable ones count in the series.
 */
export function weeklySeries(
  items: ReadonlyArray<UnitItem>,
  cohort: WeeklyCohort,
  tauDays: number,
): WeeklySeries {
  const { cutoffMs, historyFromMs } = cohort;
  const comparable = new Set(cohort.comparable);
  const firstByKey = new Map<string, number>();
  const authorsW0 = new Set<string>();
  const sourcesW0 = new Set<SourceId>();
  const perSource = new Map<SourceId, { keys: Map<string, number>; authors: Set<string> }>();
  const firstBySource = new Map<SourceId, { ms: number; id: string }>();
  let firstMs: number | null = null;
  let unknownItems = 0;
  let knownItems = 0;
  for (const item of items) {
    if (item.ms >= cutoffMs) throw new Error(`item ${item.id} is not before the cutoff`);
    const counts = comparable.has(item.source);
    if (counts) {
      if (firstMs === null || item.ms < firstMs) firstMs = item.ms;
      const first = firstBySource.get(item.source);
      if (!first || item.ms < first.ms || (item.ms === first.ms && item.id < first.id))
        firstBySource.set(item.source, { ms: item.ms, id: item.id });
    }
    if (item.ms < historyFromMs) continue;
    const k = Math.floor((cutoffMs - item.ms) / WEEK_MS);
    if (k >= SERIES_WEEK_COUNT) continue;
    const unknown = cohort.unknown.has(`${item.source}|${k}`);
    let row = perSource.get(item.source);
    if (!row) perSource.set(item.source, (row = { keys: new Map(), authors: new Set() }));
    const seen = row.keys.get(item.key);
    if (seen === undefined || item.ms < seen) row.keys.set(item.key, item.ms);
    if (k === 0 && item.author !== null) row.authors.add(item.author);
    if (!counts) continue;
    if (k <= 2) {
      if (unknown) unknownItems++;
      else knownItems++;
    }
    if (unknown) continue;
    const prior = firstByKey.get(item.key);
    if (prior === undefined || item.ms < prior) firstByKey.set(item.key, item.ms);
    if (k === 0) {
      sourcesW0.add(item.source);
      if (item.author !== null) authorsW0.add(item.author);
    }
  }
  const weeks = Array.from({ length: SERIES_WEEK_COUNT }, () => 0);
  let pop = 0;
  // Summed in ascending time so the float result does not depend on insertion order.
  const firsts = [...firstByKey.values()].toSorted((a, b) => a - b);
  for (const ms of firsts) {
    weeks[Math.floor((cutoffMs - ms) / WEEK_MS)]!++;
    pop += 2 ** (-(cutoffMs - ms) / (tauDays * 86_400_000));
  }
  const bySource = new Map<SourceId, SourceWeeks>();
  for (const [source, row] of [...perSource].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    const rowWeeks: Array<number | null> = Array.from({ length: SERIES_WEEK_COUNT }, () => 0);
    for (const ms of row.keys.values()) rowWeeks[Math.floor((cutoffMs - ms) / WEEK_MS)]!++;
    const isComparable = comparable.has(source);
    for (let k = 0; k < SERIES_WEEK_COUNT; k++)
      if (isComparable && cohort.unknown.has(`${source}|${k}`)) rowWeeks[k] = null;
    bySource.set(source, {
      weeks: rowWeeks,
      authorsW0: rowWeeks[0] === null ? null : row.authors.size,
    });
  }
  const total = unknownItems + knownItems;
  const unknownShare = total === 0 ? 0 : unknownItems / total;
  return {
    weeks,
    life: firsts.length,
    pop,
    authorsW0: authorsW0.size,
    sourcesW0: [...sourcesW0].toSorted(),
    unknownShare,
    incomplete: total > 0 && unknownShare >= cohort.incompleteShare,
    firstMs,
    firstBySource,
    bySource,
  };
}
