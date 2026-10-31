import type { EditorialResultsDecision } from "@t3tools/contracts";

/**
 * What a stored decision may hold to enter an aggregate. SQLite tables here are not STRICT and
 * a CHECK can be skipped, so a value of the right shape can still be out of its domain (a
 * utility of 999, a negative time). Results and the evidence export apply the same bounds.
 */
export const UTILITY_MIN = 1;
export const UTILITY_MAX = 5;
/** Seven days of active work in one stage: far above any real thread, below garbage. */
export const STAGE_MS_MAX = 7 * 24 * 60 * 60 * 1000;
export const TOTAL_MS_MAX = 4 * STAGE_MS_MAX;
/** Counts (claims, views, rows) are non-negative safe integers. */
export const COUNT_MAX = Number.MAX_SAFE_INTEGER;
/** Plausible dates: from 2020 to the end of 2099, UTC. */
export const DATE_MIN = "2020-01-01T00:00:00.000Z";
export const DATE_MAX = "2100-01-01T00:00:00.000Z";

const DATE_MIN_MS = Date.parse(DATE_MIN);
const DATE_MAX_MS = Date.parse(DATE_MAX);

export const intInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** An ISO date-time inside the plausible range. */
export const dateInRange = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms) && ms >= DATE_MIN_MS && ms < DATE_MAX_MS;
};

const optional = (value: unknown, max: number) => value === null || intInRange(value, 0, max);

/** Whether every value of the decision is inside its domain, so it may enter an aggregate. */
export const decisionInDomain = (decision: EditorialResultsDecision): boolean => {
  if (decision.mode !== "assisted" && decision.mode !== "manual") return false;
  if (!["accept", "edit", "reject"].includes(decision.action)) return false;
  if (!intInRange(decision.utility, UTILITY_MIN, UTILITY_MAX)) return false;
  const { exploreMs, readMs, writeMs, decideMs, totalMs } = decision.durations;
  if (![exploreMs, readMs, writeMs, decideMs].every((ms) => optional(ms, STAGE_MS_MAX))) {
    return false;
  }
  if (!optional(totalMs, TOTAL_MS_MAX)) return false;
  if (decision.script !== null) {
    const { claims, cited } = decision.script;
    if (!intInRange(claims, 0, COUNT_MAX) || !intInRange(cited, 0, claims)) return false;
  }
  if (decision.video !== null) {
    const { views, subscribers, clicks, comments, observedAt } = decision.video;
    if (![views, subscribers, clicks, comments].every((count) => optional(count, COUNT_MAX))) {
      return false;
    }
    if (!dateInRange(observedAt)) return false;
  }
  // The export rebuilds decisions without their date; only a stored one is checked.
  return decision.decidedAt === "" || dateInRange(decision.decidedAt);
};
