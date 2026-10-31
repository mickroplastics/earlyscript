// @effect-diagnostics preferSchemaOverJson:off - the report is decoded with Schema; hashing needs the parsed value.
// The backtest report (backtest.json): its shape, the verdict rule and the logical hash. Kept
// apart from backtest.ts so a reader (the server's record-source-backtest script) checks a
// report without loading the engine or the embedder.
import * as Schema from "effect/Schema";

import { SourceId } from "@earlyscript/editorial-contracts/source";

import { canonicalJson, sha256 } from "./hash.ts";

export const BACKTEST_SCHEMA_VERSION = "earlyscript.backtest/1";

/**
 * Earlywindow's retrospective label (early-window/scripts/backtest.ts, RULE and labelOutcomes,
 * backtest.v0.02): each story of the `followup_days` after the cutoff joins the emitted trend
 * whose frozen centroid is closest above the cluster threshold; a trend is positive on the
 * first day its stories reach `event_stories` from `event_authors` distinct authors.
 */
export const LABEL_RULE = { followup_days: 14, event_stories: 5, event_authors: 2 } as const;

/** P@5 may drop by at most this much against the baseline arm (decision of 31 October 2026). */
export const P_AT_5_TOLERANCE = 0.02;

export type Verdict = "not-worse" | "worse";

export interface ArmTotal {
  /** Mean of the per-cutoff P@5 of the weighted ranking over the paired cutoffs. */
  readonly mean_p_at_5: number | null;
  readonly mean_p_at_10: number | null;
  /** Median lead_days pooled over every positive candidate of the paired cutoffs. */
  readonly median_lead_days: number | null;
  /** Median lead_days of the positives inside each weighted top 5, pooled. */
  readonly median_lead_days_at_5: number | null;
  readonly candidates: number;
  readonly positives: number;
}

export interface VerdictInput {
  readonly baseline: Pick<ArmTotal, "mean_p_at_5" | "median_lead_days">;
  readonly candidate: Pick<ArmTotal, "mean_p_at_5" | "median_lead_days">;
}

export interface VerdictResult {
  readonly verdict: Verdict;
  readonly p_at_5_delta: number | null;
  readonly median_lead_days_delta: number | null;
  readonly reasons: ReadonlyArray<string>;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/**
 * not-worse when the candidate's mean P@5 is at least the baseline's minus 0.02 and its median
 * lead is not shorter. A side without a value cannot show it is not worse: a missing candidate
 * P@5 or lead against a present baseline one is worse; with both missing the criterion is moot.
 */
export function decideVerdict({ baseline, candidate }: VerdictInput): VerdictResult {
  const reasons: Array<string> = [];
  const p5 =
    baseline.mean_p_at_5 === null || candidate.mean_p_at_5 === null
      ? null
      : round6(candidate.mean_p_at_5 - baseline.mean_p_at_5);
  if (candidate.mean_p_at_5 === null && baseline.mean_p_at_5 !== null) {
    reasons.push("candidate has no evaluable P@5");
  } else if (p5 !== null && p5 < -P_AT_5_TOLERANCE) {
    reasons.push(`P@5 drops by ${-p5} (tolerance ${P_AT_5_TOLERANCE})`);
  }
  const lead =
    baseline.median_lead_days === null || candidate.median_lead_days === null
      ? null
      : round6(candidate.median_lead_days - baseline.median_lead_days);
  if (candidate.median_lead_days === null && baseline.median_lead_days !== null) {
    reasons.push("candidate has no positive with a lead");
  } else if (lead !== null && lead < 0) {
    reasons.push(`median lead_days shortens by ${-lead}`);
  }
  return {
    verdict: reasons.length === 0 ? "not-worse" : "worse",
    p_at_5_delta: p5,
    median_lead_days_delta: lead,
    reasons,
  };
}

/** SHA-256 of the canonical `logical` block: what two backtests of the same inputs reproduce. */
export const backtestLogicalHash = (logical: unknown): string => sha256(canonicalJson(logical));

/** Short id that names the logical content; `recordBacktest` stores it. */
export const backtestId = (logicalHash: string): string =>
  `bt_${logicalHash.replace(/^sha256:/, "").slice(0, 16)}`;

const ArmTotalSchema = Schema.Struct({
  mean_p_at_5: Schema.NullOr(Schema.Number),
  median_lead_days: Schema.NullOr(Schema.Number),
});

/** What a reader needs; the rest of `logical` is hashed as it is. */
export const BacktestReportHead = Schema.Struct({
  schema_version: Schema.Literal(BACKTEST_SCHEMA_VERSION),
  backtest_id: Schema.String,
  logical_hash: Schema.String,
  logical: Schema.Struct({
    inputs: Schema.Struct({
      baseline_sources: Schema.Array(SourceId),
      candidate_sources: Schema.Array(SourceId),
      truth_sources: Schema.Array(SourceId),
    }),
    total: Schema.Struct({ baseline: ArmTotalSchema, candidate: ArmTotalSchema }),
    verdict: Schema.Struct({
      verdict: Schema.Literals(["not-worse", "worse"]),
      reasons: Schema.Array(Schema.String),
    }),
  }),
});
export type BacktestReportHead = typeof BacktestReportHead.Type;

const decodeHead = Schema.decodeUnknownSync(BacktestReportHead);

export interface BacktestCheck {
  readonly ok: boolean;
  readonly backtest_id: string;
  readonly recorded: string;
  readonly recomputed: string;
  readonly report: BacktestReportHead;
  readonly problems: ReadonlyArray<string>;
}

/**
 * Checks a parsed backtest.json: the logical hash recomputes, the id names it, and the recorded
 * verdict is the one the recorded totals give.
 */
export function checkBacktestReport(json: unknown): BacktestCheck {
  const report = decodeHead(json);
  const logical = (json as { logical: unknown }).logical;
  const recomputed = backtestLogicalHash(logical);
  const problems: Array<string> = [];
  if (recomputed !== report.logical_hash) problems.push("logical_hash does not recompute");
  if (backtestId(report.logical_hash) !== report.backtest_id) {
    problems.push("backtest_id does not name logical_hash");
  }
  const verdict = decideVerdict(report.logical.total);
  if (verdict.verdict !== report.logical.verdict.verdict) {
    problems.push(`recorded verdict ${report.logical.verdict.verdict}, totals give ${verdict.verdict}`);
  }
  return {
    ok: problems.length === 0,
    backtest_id: report.backtest_id,
    recorded: report.logical_hash,
    recomputed,
    report,
    problems,
  };
}
