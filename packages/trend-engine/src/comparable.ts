// engine.v3, contract v4.2 §2.2 and §2.5: which sources count at a cutoff and which of their
// weeks are unknown. Pure; reads only coverage rows of days before the cutoff.
import type { SourceRowStatus } from "@earlyscript/editorial-contracts/dossier";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { DAY_MS, dayOf, dayStart, daysBefore } from "./days.ts";
import type { CoverageIndex } from "./series.ts";

/** Weeks W0..W4 the series uses: five weeks of seven days ending the day before the cutoff. */
export const SERIES_WEEKS = 5;
export const WEEK_DAYS = 7;
export const ROW_UNKNOWN_DAYS = 2;
export const INCOMPLETE_SHARE = 0.3;

export interface SourceAt {
  readonly source: SourceId;
  readonly status: SourceRowStatus;
  /** Days of the comparable window with no coverage row. */
  readonly missing_days: number;
  readonly unavailable_days: number;
  /** k of the weeks W_k with ROW_UNKNOWN_DAYS or more unavailable days ("?"). */
  readonly unknown_weeks: ReadonlyArray<number>;
}

export interface Cohort {
  readonly cutoffDay: string;
  readonly cutoffMs: number;
  /** max(t − window_days, corpus start): the history a topic is judged on. */
  readonly historyFrom: string;
  readonly historyFromMs: number;
  /** Sources that count in n(W), popularity, percentiles and the number of sources. */
  readonly comparable: ReadonlyArray<SourceId>;
  readonly rows: ReadonlyArray<SourceAt>;
  readonly unknown: ReadonlySet<string>;
  readonly incompleteShare: number;
}

export const unknownKey = (source: SourceId, week: number) => `${source}|${week}`;

/**
 * Comparable: coverage lists every day of [t − window, t), at most `max_unavailable` of them
 * unavailable (those only turn a week with 2 or more into "?"). A clustered source missing only
 * days before its first row is `parcial`; another failing one `no_comparable`; one that does
 * not cluster `no_usada`.
 */
export function cohortAt(
  coverage: CoverageIndex,
  sources: ReadonlyArray<SourceId>,
  clustered: ReadonlyArray<SourceId>,
  cutoffDay: string,
  corpusFromDay: string,
  cfg: NonNullable<EngineConfig["comparable"]>,
): Cohort {
  const cutoffMs = dayStart(cutoffDay);
  const window = daysBefore(cutoffDay, cfg.window_days);
  const rowUnknown = cfg.row_unknown_days ?? ROW_UNKNOWN_DAYS;
  const historyFromMs = Math.max(dayStart(window[0]!), dayStart(corpusFromDay));
  const rows: Array<SourceAt> = [];
  const unknown = new Set<string>();
  for (const source of sources) {
    const days = coverage.get(source) ?? new Map();
    const listed = window.filter((day) => days.has(day));
    const unavailable = listed.filter((day) => days.get(day) === "unavailable").length;
    const missing = window.length - listed.length;
    const firstListed = [...days.keys()].filter((day) => day < cutoffDay).toSorted()[0];
    let status: SourceRowStatus;
    if (!clustered.includes(source)) status = "no_usada";
    else if (missing === 0 && unavailable <= cfg.max_unavailable) status = "comparable";
    else if (
      firstListed !== undefined &&
      firstListed > window[0]! &&
      window.filter((day) => day >= firstListed).every((day) => days.has(day)) &&
      unavailable <= cfg.max_unavailable
    )
      status = "parcial";
    else status = "no_comparable";
    const unknownWeeks: Array<number> = [];
    if (status === "comparable") {
      for (let k = 0; k < SERIES_WEEKS; k++) {
        const week = daysBefore(dayOf(cutoffMs - k * WEEK_DAYS * DAY_MS), WEEK_DAYS);
        const off = week.filter((day) => days.get(day) === "unavailable").length;
        if (off >= rowUnknown) {
          unknownWeeks.push(k);
          unknown.add(unknownKey(source, k));
        }
      }
    }
    rows.push({
      source,
      status,
      missing_days: missing,
      unavailable_days: unavailable,
      unknown_weeks: unknownWeeks,
    });
  }
  return {
    cutoffDay,
    cutoffMs,
    historyFrom: dayOf(historyFromMs),
    historyFromMs,
    comparable: rows.filter((r) => r.status === "comparable").map((r) => r.source),
    rows,
    unknown,
    incompleteShare: cfg.incomplete_share ?? INCOMPLETE_SHARE,
  };
}
