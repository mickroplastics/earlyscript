// The development comparison: candidate and reference over the same cutoffs, corpus, profile
// and novelty memory, scored with Miguel's labels where they exist. Unlabelled positions give
// ranges (0 at the lower bound, 1 at the upper), never a point estimate.
import { canonicalJson, sha256 } from "./hash.ts";
import type { ArmOutput, ArmTrend, WorkerResult } from "./result.ts";

export const REPORT_SCHEMA = "earlyscript.engine-lab-report/1";
export const TOP = 5;

export type LabelValue = "yes" | "no" | "unsure";
export type Grade = "core" | "adjacent";

/** A labelled topic at one cutoff, with the member keys of its card's headlines. */
export interface LabelledTopic {
  readonly topic_id: string;
  readonly cutoff: string;
  readonly label: LabelValue;
  readonly grade: Grade | null;
  readonly keys: ReadonlyArray<string>;
}

export interface LabelSource {
  readonly labeler: string;
  /** Human: the operator's own labels. Judge: a model's, never validated item by item. */
  readonly kind: "human" | "judge";
  readonly hash: string;
  readonly topics: ReadonlyArray<LabelledTopic>;
}

export const memberKey = (member: {
  readonly source: string;
  readonly published_at: string;
  readonly title: string;
}) => sha256(`${member.source}\n${member.published_at}\n${member.title}`);

export interface Range {
  readonly lo: number;
  readonly hi: number;
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;
const range = (lo: number, hi: number): Range => ({ lo: round(lo), hi: round(hi) });

/** Two trends of one ranking are the same topic when half the smaller's items are shared. */
export function isDuplicate(a: ArmTrend, b: ArmTrend): boolean {
  const [small, large] = a.item_ids.length <= b.item_ids.length ? [a, b] : [b, a];
  if (small.item_ids.length === 0) return false;
  const big = new Set(large.item_ids);
  return small.item_ids.filter((id) => big.has(id)).length >= small.item_ids.length / 2;
}

/**
 * The labelled topic a trend is, by its card's headlines among the trend's members: at least
 * two shared (one when the card has one). None or a conflicting match is unlabelled.
 */
export function matchLabel(
  trend: ArmTrend,
  cutoff: string,
  labels: ReadonlyArray<LabelledTopic>,
): LabelledTopic | null {
  const members = new Set(trend.member_keys);
  const hits = labels.filter(
    (topic) =>
      topic.cutoff === cutoff.slice(0, 10) &&
      topic.keys.length > 0 &&
      topic.keys.filter((key) => members.has(key)).length >= Math.min(2, topic.keys.length),
  );
  if (hits.length === 0) return null;
  const first = hits[0]!;
  return hits.every((hit) => hit.label === first.label && hit.grade === first.grade) ? first : null;
}

type SlotState =
  | "empty"
  | "duplicate"
  | "unlabelled"
  | "yes"
  | "yes-ungraded"
  | "core"
  | "adjacent"
  | "no"
  | "unsure";

export interface Slot {
  readonly position: number;
  readonly trend_id: string | null;
  readonly label: string | null;
  readonly state: SlotState;
  readonly topic_id: string | null;
}

const slotBounds = (state: SlotState) => {
  // [p5 lo, p5 hi, g5 lo, g5 hi, core lo, core hi]
  switch (state) {
    case "empty":
    case "duplicate":
    case "no":
    case "unsure":
      return [0, 0, 0, 0, 0, 0];
    case "unlabelled":
      return [0, 1, 0, 1, 0, 1];
    case "core":
      return [1, 1, 1, 1, 1, 1];
    case "adjacent":
      return [1, 1, 0.5, 0.5, 0, 0];
    case "yes":
    case "yes-ungraded":
      return [1, 1, 0.5, 1, 0, 1];
  }
};

export function slotsOf(arm: ArmOutput, labels: ReadonlyArray<LabelledTopic>): Array<Slot> {
  const top = arm.top
    .filter((trend) => trend.position <= TOP)
    .toSorted((a, b) => a.position - b.position);
  const slots: Array<Slot> = [];
  for (let position = 1; position <= TOP; position++) {
    const trend = top.find((entry) => entry.position === position);
    if (trend === undefined) {
      slots.push({ position, trend_id: null, label: null, state: "empty", topic_id: null });
      continue;
    }
    const earlier = top.filter((entry) => entry.position < position);
    if (earlier.some((entry) => isDuplicate(entry, trend))) {
      slots.push({
        position,
        trend_id: trend.trend_id,
        label: trend.label,
        state: "duplicate",
        topic_id: null,
      });
      continue;
    }
    const hit = matchLabel(trend, arm.cutoff, labels);
    const state: SlotState =
      hit === null
        ? "unlabelled"
        : hit.label === "yes"
          ? hit.grade === "core"
            ? "core"
            : hit.grade === "adjacent"
              ? "adjacent"
              : "yes-ungraded"
          : hit.label;
    slots.push({
      position,
      trend_id: trend.trend_id,
      label: trend.label,
      state,
      topic_id: hit?.topic_id ?? null,
    });
  }
  return slots;
}

export interface ArmMetrics {
  readonly p5: Range;
  readonly g5: Range;
  readonly core5: Range;
  /** Labelled positions over all positions with a distinct trend. */
  readonly coverage: number;
  readonly duplicates: number;
  readonly empty: number;
}

export function armMetrics(
  arms: ReadonlyArray<ArmOutput>,
  labels: ReadonlyArray<LabelledTopic>,
): {
  metrics: ArmMetrics;
  slots: Array<{ cutoff: string; slots: Array<Slot> }>;
} {
  const sums = [0, 0, 0, 0, 0, 0];
  let labelled = 0;
  let distinct = 0;
  let duplicates = 0;
  let empty = 0;
  const slots = arms.map((arm) => {
    const cut = slotsOf(arm, labels);
    for (const slot of cut) {
      const bounds = slotBounds(slot.state);
      for (let k = 0; k < 6; k++) sums[k]! += bounds[k]! / TOP;
      if (slot.state === "duplicate") duplicates++;
      else if (slot.state === "empty") empty++;
      else {
        distinct++;
        if (slot.state !== "unlabelled") labelled++;
      }
    }
    return { cutoff: arm.cutoff, slots: cut };
  });
  const n = Math.max(1, arms.length);
  return {
    metrics: {
      p5: range(sums[0]! / n, sums[1]! / n),
      g5: range(sums[2]! / n, sums[3]! / n),
      core5: range(sums[4]! / n, sums[5]! / n),
      coverage: round(distinct === 0 ? 0 : labelled / distinct),
      duplicates,
      empty,
    },
    slots,
  };
}

/** candidate − reference, as the widest difference the two ranges allow. */
export const rangeDelta = (candidate: Range, reference: Range): Range =>
  range(candidate.lo - reference.hi, candidate.hi - reference.lo);

export type DevVerdict = "better" | "worse" | "undetermined";

export const verdictOf = (delta: Range): DevVerdict =>
  delta.lo > 0 ? "better" : delta.hi < 0 ? "worse" : "undetermined";

export interface CutoffDiff {
  readonly cutoff: string;
  readonly logically_equal: boolean;
  readonly entered: ReadonlyArray<{
    readonly trend_id: string;
    readonly label: string;
    readonly position: number;
  }>;
  readonly left: ReadonlyArray<{
    readonly trend_id: string;
    readonly label: string;
    readonly position: number;
  }>;
  readonly moved: ReadonlyArray<{
    readonly trend_id: string;
    readonly from: number;
    readonly to: number;
  }>;
}

export function cutoffDiffs(
  reference: ReadonlyArray<ArmOutput>,
  candidate: ReadonlyArray<ArmOutput>,
): Array<CutoffDiff> {
  return reference.map((ref, k) => {
    const cand = candidate[k]!;
    const top = (arm: ArmOutput) => arm.top.filter((trend) => trend.position <= TOP);
    const refTop = top(ref);
    const candTop = top(cand);
    const refIds = new Map(refTop.map((trend) => [trend.trend_id, trend]));
    const candIds = new Map(candTop.map((trend) => [trend.trend_id, trend]));
    return {
      cutoff: ref.cutoff,
      logically_equal: ref.logical_hash === cand.logical_hash,
      entered: candTop
        .filter((trend) => !refIds.has(trend.trend_id))
        .map((trend) => ({
          trend_id: trend.trend_id,
          label: trend.label,
          position: trend.position,
        })),
      left: refTop
        .filter((trend) => !candIds.has(trend.trend_id))
        .map((trend) => ({
          trend_id: trend.trend_id,
          label: trend.label,
          position: trend.position,
        })),
      moved: candTop
        .filter(
          (trend) =>
            refIds.has(trend.trend_id) && refIds.get(trend.trend_id)!.position !== trend.position,
        )
        .map((trend) => ({
          trend_id: trend.trend_id,
          from: refIds.get(trend.trend_id)!.position,
          to: trend.position,
        })),
    };
  });
}

export interface LabelBlock {
  readonly labeler: string;
  readonly kind: "human" | "judge";
  readonly labels_hash: string;
  /** False for a judge: its agreement with Miguel was never validated item by item. */
  readonly validated_per_item: boolean;
  readonly reference: ArmMetrics;
  readonly candidate: ArmMetrics;
  readonly delta: { readonly p5: Range; readonly g5: Range; readonly core5: Range };
  readonly verdict: DevVerdict;
  readonly slots: {
    readonly reference: ReadonlyArray<{ cutoff: string; slots: ReadonlyArray<Slot> }>;
    readonly candidate: ReadonlyArray<{ cutoff: string; slots: ReadonlyArray<Slot> }>;
  };
}

export interface DevelopmentReport {
  readonly schema: typeof REPORT_SCHEMA;
  readonly kind: "development";
  readonly job_token: string;
  readonly campaign_id: string;
  readonly reference_hash: string;
  readonly candidate_hash: string;
  readonly cutoffs: ReadonlyArray<string>;
  /** Equal logical hashes at every cutoff: the candidate emits exactly what the reference does. */
  readonly equivalent: boolean;
  readonly human: LabelBlock | null;
  readonly judge: LabelBlock | null;
  readonly diffs: ReadonlyArray<CutoffDiff>;
  readonly runs: {
    readonly reference: ReadonlyArray<{
      cutoff: string;
      run_id: string;
      logical_hash: string;
      duration_ms: number;
    }>;
    readonly candidate: ReadonlyArray<{
      cutoff: string;
      run_id: string;
      logical_hash: string;
      duration_ms: number;
    }>;
  };
  readonly sandbox: "bwrap" | "none";
  readonly result_signature: string;
  readonly notes: ReadonlyArray<string>;
}

const labelBlock = (source: LabelSource, result: WorkerResult): LabelBlock => {
  const reference = armMetrics(result.arms.reference, source.topics);
  const candidate = armMetrics(result.arms.candidate, source.topics);
  const delta = {
    p5: rangeDelta(candidate.metrics.p5, reference.metrics.p5),
    g5: rangeDelta(candidate.metrics.g5, reference.metrics.g5),
    core5: rangeDelta(candidate.metrics.core5, reference.metrics.core5),
  };
  return {
    labeler: source.labeler,
    kind: source.kind,
    labels_hash: source.hash,
    validated_per_item: source.kind === "human",
    reference: reference.metrics,
    candidate: candidate.metrics,
    delta,
    verdict: verdictOf(delta.g5),
    slots: { reference: reference.slots, candidate: candidate.slots },
  };
};

/** The report of a verified worker result. The same inputs always give the same report. */
export function developmentReport(input: {
  readonly result: WorkerResult;
  readonly campaignId: string;
  readonly cutoffs: ReadonlyArray<string>;
  readonly human: LabelSource | null;
  readonly judge: LabelSource | null;
}): DevelopmentReport {
  const { result } = input;
  const runsOf = (arms: ReadonlyArray<ArmOutput>) =>
    arms.map((arm) => ({
      cutoff: arm.cutoff,
      run_id: arm.run_id,
      logical_hash: arm.logical_hash,
      duration_ms: arm.duration_ms,
    }));
  const diffs = cutoffDiffs(result.arms.reference, result.arms.candidate);
  const notes = [
    "Development evidence over cutoffs the operator chose; it is not the promotion gate.",
    "Unlabelled positions count 0 at the lower bound and 1 at the upper bound.",
  ];
  if (input.judge !== null)
    notes.push("The judge's labels are a model's signal, not validated item by item.");
  return {
    schema: REPORT_SCHEMA,
    kind: "development",
    job_token: result.token,
    campaign_id: input.campaignId,
    reference_hash: result.reference_hash,
    candidate_hash: result.candidate_hash,
    cutoffs: input.cutoffs,
    equivalent: diffs.every((diff) => diff.logically_equal),
    human: input.human === null ? null : labelBlock(input.human, result),
    judge: input.judge === null ? null : labelBlock(input.judge, result),
    diffs,
    runs: { reference: runsOf(result.arms.reference), candidate: runsOf(result.arms.candidate) },
    sandbox: result.executor.sandbox,
    result_signature: result.signature,
    notes,
  };
}

export const reportHash = (report: unknown) => sha256(canonicalJson(report));
