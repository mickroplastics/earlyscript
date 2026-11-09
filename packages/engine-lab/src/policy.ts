// @effect-diagnostics globalDate:off - a plain library without an Effect runtime.
// What a model may change in the engine through the engine lab, and what it never reaches.
// Pure: the server validates every change here before it stores a candidate, and the worker
// checks the sealed partitions again before it runs anything.
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { canonicalJson, sha256 } from "./hash.ts";

export const LAB_POLICY_VERSION = "earlyscript.engine-lab-policy/1";

export type LabErrorCode =
  | "permission-denied"
  | "budget-exhausted"
  | "sealed-partition"
  | "stale-base"
  | "artifact-mismatch"
  | "executor-unavailable"
  | "insufficient-evidence"
  | "unsupported-change"
  | "invalid-change";

export class LabPolicyError extends Error {
  readonly code: LabErrorCode;
  constructor(code: LabErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The values run.ts scores with (`values` in runEngine): a weight on any other name throws. */
export const RANK_VALUE_NAMES = [
  "items_7d",
  "growth",
  "log_authors_7d",
  "include_score",
  "log_items_7d",
  "relevance",
  "sources_7d",
] as const;

export const WEIGHT_MIN = 0;
export const WEIGHT_MAX = 2;

/**
 * Pure computation files a code candidate may patch, relative to the repository. Nothing else:
 * not the evaluator, the topic identity, the CLI, the sources or the configuration files.
 */
export const CODE_FILES = [
  "packages/trend-engine/src/rank.ts",
  "packages/trend-engine/src/relevance.ts",
  "packages/trend-engine/src/series.ts",
] as const;

export const MAX_PATCH_BYTES = 24_000;
export const MAX_PATCH_CHANGED_LINES = 400;

/**
 * Protocol P1.2's test cutoffs, the prospective one included: no lab evaluation may run or
 * read them, whatever campaign asks.
 */
export const SEALED_CUTOFFS: ReadonlyArray<string> = [
  "2026-09-13",
  "2026-09-16",
  "2026-09-20",
  "2026-09-23",
  "2026-09-27",
  "2026-09-30",
  "2026-10-27",
  "2026-10-30",
  "2026-11-02",
  "2026-11-04",
  "2026-11-06",
];

/** Path segments of the frozen evaluation's ledger, corpus and snapshots. */
export const SEALED_PATH_SEGMENTS: ReadonlyArray<string> = [
  "eval-prospectivo",
  "eval-largo",
  "ledger.jsonl",
];

export const isSealedCutoff = (day: string) => SEALED_CUTOFFS.includes(day.slice(0, 10));

const CUTOFF = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/;

/**
 * Cutoffs as the engine takes them, midnight UTC, one per day: a repeated day would count the
 * same observations twice. A day or a midnight ISO time is accepted; anything else is refused.
 */
export function cutoffDays(cutoffs: ReadonlyArray<string>): Array<string> {
  const days = cutoffs.map((cutoff) => {
    const day = CUTOFF.exec(cutoff.trim())?.[1];
    const ms = day === undefined ? Number.NaN : Date.parse(`${day}T00:00:00.000Z`);
    if (day === undefined || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
      throw new LabPolicyError("invalid-change", `Cutoff ${cutoff} is not a UTC day at midnight.`);
    }
    return day;
  });
  const repeated = days.filter((day, k) => days.indexOf(day) !== k);
  if (repeated.length > 0) {
    throw new LabPolicyError(
      "invalid-change",
      `Cutoffs repeat ${[...new Set(repeated)].join(", ")}: one per day.`,
    );
  }
  return days.toSorted().map((day) => `${day}T00:00:00.000Z`);
}

export function isSealedPath(path: string): boolean {
  const segments = path.split(/[\\/]+/);
  return SEALED_PATH_SEGMENTS.some((sealed) => segments.includes(sealed));
}

export function assertNotSealed(input: {
  readonly cutoffs: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
}) {
  const cutoffs = input.cutoffs.filter(isSealedCutoff);
  if (cutoffs.length > 0) {
    throw new LabPolicyError(
      "sealed-partition",
      `Cutoffs ${cutoffs.join(", ")} belong to the frozen evaluation; the lab never runs them.`,
    );
  }
  const paths = input.paths.filter(isSealedPath);
  if (paths.length > 0) {
    throw new LabPolicyError(
      "sealed-partition",
      `${paths.join(", ")} belong to the frozen evaluation; the lab never reads them.`,
    );
  }
}

/** Kinds of change the manifest records but this delivery does not let a model create. */
export const UNSUPPORTED_CHANGE_KINDS = [
  "profile",
  "sources",
  "feeds",
  "labels",
  "retrain",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const finiteIn = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export interface ConfigChangeResult {
  readonly config: EngineConfig;
  /** Dotted path, from and to, for every field the change sets to a new value. */
  readonly diff: ReadonlyArray<{
    readonly path: string;
    readonly from: number | null;
    readonly to: number;
  }>;
}

/**
 * The configuration `change` makes of `base`: weights of `rank.weighted` (finite, 0..2, at
 * least one positive, never normalized) and `relevance.item_min`/`signal_min` (0..1). Any
 * other key is refused, not ignored.
 */
export function applyConfigChange(base: EngineConfig, change: unknown): ConfigChangeResult {
  if (!isRecord(change)) throw new LabPolicyError("invalid-change", "The change is not an object.");
  const unknown = Object.keys(change).filter((key) => key !== "weights" && key !== "relevance");
  if (unknown.length > 0) {
    const unsupported = unknown.filter((key) =>
      (UNSUPPORTED_CHANGE_KINDS as ReadonlyArray<string>).includes(key),
    );
    if (unsupported.length > 0) {
      throw new LabPolicyError(
        "unsupported-change",
        `Changes to ${unsupported.join(", ")} are recorded in the manifest but not created by the lab yet.`,
      );
    }
    throw new LabPolicyError(
      "invalid-change",
      `Unknown keys ${unknown.join(", ")}; a config change takes weights and relevance only.`,
    );
  }
  const diff: Array<ConfigChangeResult["diff"][number]> = [];
  const weights: Record<string, number> = { ...base.rank.weighted.weights };
  if (change.weights !== undefined) {
    if (!isRecord(change.weights)) {
      throw new LabPolicyError("invalid-change", "weights is not an object.");
    }
    for (const [name, value] of Object.entries(change.weights)) {
      if (!(RANK_VALUE_NAMES as ReadonlyArray<string>).includes(name)) {
        throw new LabPolicyError(
          "invalid-change",
          `Weight ${name} has no value in the engine; known: ${RANK_VALUE_NAMES.join(", ")}.`,
        );
      }
      if (!finiteIn(value, WEIGHT_MIN, WEIGHT_MAX)) {
        throw new LabPolicyError(
          "invalid-change",
          `Weight ${name} must be a finite number from ${WEIGHT_MIN} to ${WEIGHT_MAX}.`,
        );
      }
      if (name === "relevance" && base.relevance === undefined) {
        throw new LabPolicyError(
          "invalid-change",
          "Weight relevance needs a relevance model, which this base has not.",
        );
      }
      const weight = Number(value);
      const from = weights[name] ?? null;
      if (from !== weight) diff.push({ path: `rank.weighted.weights.${name}`, from, to: weight });
      weights[name] = weight;
    }
  }
  if (!Object.values(weights).some((weight) => weight > 0)) {
    throw new LabPolicyError("invalid-change", "At least one weight must be positive.");
  }
  let relevance = base.relevance;
  if (change.relevance !== undefined) {
    if (!isRecord(change.relevance)) {
      throw new LabPolicyError("invalid-change", "relevance is not an object.");
    }
    if (base.relevance === undefined) {
      throw new LabPolicyError(
        "unsupported-change",
        "This base has no relevance model, so item_min and signal_min do not apply.",
      );
    }
    const extra = Object.keys(change.relevance).filter(
      (key) => key !== "item_min" && key !== "signal_min",
    );
    if (extra.length > 0) {
      throw new LabPolicyError(
        "invalid-change",
        `Unknown relevance keys ${extra.join(", ")}; only item_min and signal_min change.`,
      );
    }
    const next = { ...base.relevance };
    for (const key of ["item_min", "signal_min"] as const) {
      const value = change.relevance[key];
      if (value === undefined) continue;
      if (!finiteIn(value, 0, 1)) {
        throw new LabPolicyError("invalid-change", `relevance.${key} must be from 0 to 1.`);
      }
      const typed = Number(value);
      if (next[key] !== typed) diff.push({ path: `relevance.${key}`, from: next[key], to: typed });
      next[key] = typed;
    }
    relevance = next;
  }
  if (diff.length === 0) {
    throw new LabPolicyError("invalid-change", "The change leaves the configuration as it is.");
  }
  const config: EngineConfig = {
    ...base,
    rank: { ...base.rank, weighted: { ...base.rank.weighted, weights } },
    ...(relevance === undefined ? {} : { relevance }),
  };
  return { config, diff };
}

/** The hash the nightly run keys its jobs with: canonical JSON of the whole configuration. */
export const configHash = (config: unknown) => sha256(canonicalJson(config));
