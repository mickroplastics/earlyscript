// @effect-diagnostics preferSchemaOverJson:off - the report is decoded with Schema; hashing needs the parsed value.
// The backtest report (backtest.json): its shape, the verdict rule and the logical hash. Kept
// apart from backtest.ts so a reader (the server's record-source-backtest script) checks a
// report without loading the engine or the embedder.
import * as Schema from "effect/Schema";

import { SourceId } from "@earlyscript/editorial-contracts/source";

import { canonicalJson, sha256 } from "./hash.ts";

/** 2: cutoffs split into complete and partial follow-up; the verdict reads complete ones only. */
export const BACKTEST_SCHEMA_VERSION = "earlyscript.backtest/2";

/**
 * Earlywindow's retrospective label (early-window/scripts/backtest.ts, RULE and labelOutcomes,
 * backtest.v0.02): each story of the `followup_days` after the cutoff joins the emitted trend
 * whose frozen centroid is closest above the cluster threshold; a trend is positive on the
 * first day its stories reach `event_stories` from `event_authors` distinct authors.
 */
export const LABEL_RULE = { followup_days: 14, event_stories: 5, event_authors: 2 } as const;

/** P@5 may drop by at most this much against the baseline arm (decision of 31 October 2026). */
export const P_AT_5_TOLERANCE = 0.02;

/** Fewer cutoffs with a complete follow-up than this leave the report provisional. */
export const MIN_COMPLETE_CUTOFFS = 7;

export type Verdict = "not-worse" | "worse";

/** final: at least MIN_COMPLETE_CUTOFFS complete cutoffs; provisional: fewer. */
export type BacktestStatus = "final" | "provisional";

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

/** Totals of one group of cutoffs: the complete ones, or the partial ones. */
export interface CutoffGroupTotal {
  /** Paired cutoffs in the group: both arms have candidates. */
  readonly cutoffs: number;
  readonly baseline: ArmTotal;
  readonly candidate: ArmTotal;
}

/**
 * The verdict reads only cutoffs whose follow-up was observed in full: a trend that crosses
 * the label after the corpus ends would otherwise count as a miss. With no complete cutoff
 * nothing shows the candidate is not worse.
 */
export function decideBacktest(complete: {
  readonly cutoffs: number;
  readonly baseline: VerdictInput["baseline"];
  readonly candidate: VerdictInput["candidate"];
}): { readonly status: BacktestStatus; readonly verdict: VerdictResult } {
  const status = complete.cutoffs >= MIN_COMPLETE_CUTOFFS ? "final" : "provisional";
  if (complete.cutoffs === 0) {
    return {
      status,
      verdict: {
        verdict: "worse",
        p_at_5_delta: null,
        median_lead_days_delta: null,
        reasons: ["no cutoff with a complete follow-up"],
      },
    };
  }
  return { status, verdict: decideVerdict(complete) };
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
const GroupSchema = Schema.Struct({
  cutoffs: Schema.Number,
  baseline: ArmTotalSchema,
  candidate: ArmTotalSchema,
});

/** What a reader needs; the rest of `logical` is hashed as it is. */
export const BacktestReportHead = Schema.Struct({
  schema_version: Schema.Literal(BACKTEST_SCHEMA_VERSION),
  backtest_id: Schema.String,
  logical_hash: Schema.String,
  /** When the backtest ran; outside the logical hash. */
  created_at: Schema.String,
  logical: Schema.Struct({
    status: Schema.Literals(["final", "provisional"]),
    inputs: Schema.Struct({
      baseline_sources: Schema.Array(SourceId),
      candidate_sources: Schema.Array(SourceId),
      truth_sources: Schema.Array(SourceId),
      cutoffs: Schema.Array(Schema.String),
    }),
    total: Schema.Struct({ complete: GroupSchema, partial: GroupSchema }),
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
  const decided = decideBacktest(report.logical.total.complete);
  if (decided.verdict.verdict !== report.logical.verdict.verdict) {
    problems.push(
      `recorded verdict ${report.logical.verdict.verdict}, totals give ${decided.verdict.verdict}`,
    );
  }
  if (decided.status !== report.logical.status) {
    problems.push(`recorded status ${report.logical.status}, totals give ${decided.status}`);
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

/** What the editorial settings keep of a recorded backtest and show next to the source. */
export interface BacktestSummary {
  readonly backtestId: string;
  readonly logicalHash: string;
  readonly experimentAt: string;
  readonly cutoffFrom: string;
  readonly cutoffTo: string;
  readonly status: BacktestStatus;
  readonly verdict: Verdict;
  readonly completeCutoffs: number;
  readonly partialCutoffs: number;
  /** Means over the complete cutoffs, the verdict's basis. */
  readonly p5Baseline: number | null;
  readonly p5Candidate: number | null;
  readonly leadBaseline: number | null;
  readonly leadCandidate: number | null;
  /** Means over the partial cutoffs, shown apart. */
  readonly partialP5Baseline: number | null;
  readonly partialP5Candidate: number | null;
}

export function backtestSummary(report: BacktestReportHead): BacktestSummary {
  const { complete, partial } = report.logical.total;
  const cutoffs = report.logical.inputs.cutoffs.toSorted();
  return {
    backtestId: report.backtest_id,
    logicalHash: report.logical_hash,
    experimentAt: report.created_at,
    cutoffFrom: (cutoffs[0] ?? "").slice(0, 10),
    cutoffTo: (cutoffs.at(-1) ?? "").slice(0, 10),
    status: report.logical.status,
    verdict: report.logical.verdict.verdict,
    completeCutoffs: complete.cutoffs,
    partialCutoffs: partial.cutoffs,
    p5Baseline: complete.baseline.mean_p_at_5,
    p5Candidate: complete.candidate.mean_p_at_5,
    leadBaseline: complete.baseline.median_lead_days,
    leadCandidate: complete.candidate.median_lead_days,
    partialP5Baseline: partial.baseline.mean_p_at_5,
    partialP5Candidate: partial.candidate.mean_p_at_5,
  };
}

/** The inputs a rerun needs, read from a report of any schema version. */
export const BacktestRerunInputs = Schema.Struct({
  corpus_dir: Schema.String,
  profile_path: Schema.String,
  logical: Schema.Struct({
    inputs: Schema.Struct({
      config: Schema.Unknown,
      cutoffs: Schema.Array(Schema.String),
      baseline_sources: Schema.Array(SourceId),
      candidate_sources: Schema.Array(SourceId),
      truth_sources: Schema.Array(SourceId),
    }),
  }),
});
export type BacktestRerunInputs = typeof BacktestRerunInputs.Type;
