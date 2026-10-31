// @effect-diagnostics nodeBuiltinImport:off -- the engine hashes its configuration with node:crypto; the job key must match.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";

const DAY_MS = 86_400_000;

const utcDayOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms)).slice(0, 10);

const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

export const addDays = (day: string, days: number) => utcDayOf(dayMs(day) + days * DAY_MS);

/** 00:00Z of the UTC day holding `ms`: the engine accepts only whole-day cutoffs. */
export const cutoffOf = (ms: number) => `${utcDayOf(ms)}T00:00:00.000Z`;

/** The engine refuses an unknown zone later; an invalid stored one falls back to UTC. */
export const isTimeZone = (timeZone: string) => Option.isSome(DateTime.makeZoned(0, { timeZone }));

const zoned = (ms: number, timeZone: string) =>
  DateTime.makeZoned(ms, { timeZone }).pipe(
    Option.getOrElse(() => DateTime.makeZonedUnsafe(ms, { timeZone: "UTC" })),
  );

/** The first `timeOfDay` in `timeZone` strictly after `afterMs`, as epoch milliseconds. */
export function nextOccurrence(timeOfDay: string, timeZone: string, afterMs: number) {
  const next = nextScheduledRunAt({ type: "fixed_time", timeOfDay }, zoned(afterMs, timeZone));
  return next === null ? null : DateTime.toEpochMillis(next);
}

/**
 * The latest `timeOfDay` in `timeZone` at or before `nowMs`, or null on the rare day a
 * daylight-saving change leaves none in the last 24 hours.
 */
export function lastOccurrence(timeOfDay: string, timeZone: string, nowMs: number) {
  const candidate = nextOccurrence(timeOfDay, timeZone, nowMs - DAY_MS);
  return candidate === null || candidate > nowMs ? null : candidate;
}

export interface CollectWindow {
  readonly fromDay: string;
  /** Exclusive. */
  readonly toDay: string;
  /** Days after the last captured one and before yesterday: captured now, never run. */
  readonly missedDays: ReadonlyArray<string>;
}

/**
 * From the last day the corpus holds (captured again: a sample or partial day can grow) to
 * yesterday. An empty corpus starts `initialDays` back, the window the engine's curves read.
 */
export function collectWindow(input: {
  readonly corpusToDay: string | null;
  readonly cutoffDay: string;
  readonly initialDays: number;
}): CollectWindow | null {
  const { corpusToDay, cutoffDay } = input;
  if (corpusToDay === null) {
    return { fromDay: addDays(cutoffDay, -input.initialDays), toDay: cutoffDay, missedDays: [] };
  }
  const fromDay = addDays(corpusToDay, -1);
  if (fromDay >= cutoffDay) return null;
  const missedDays: Array<string> = [];
  for (let day = corpusToDay; day < addDays(cutoffDay, -1); day = addDays(day, 1)) {
    missedDays.push(day);
  }
  return { fromDay, toDay: cutoffDay, missedDays };
}

/** The engine's `canonicalJson` (packages/trend-engine/src/hash.ts): keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : inner,
  );
}

export const sha256 = (data: string) =>
  `sha256:${NodeCrypto.createHash("sha256").update(data).digest("hex")}`;
