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
