// The promotion gate, sealed before any campaign: a prospective shadow of at least seven daily
// cutoffs after the candidate was frozen, labelled blind by Miguel on the union of both top 5.
// Only `pass` lets the operator promote a candidate that claims an editorial improvement.
import { canonicalJson, sha256 } from "./hash.ts";
import { isDuplicate, TOP } from "./compare.ts";
import type { ArmOutput, ArmTrend, WorkerResult } from "./result.ts";

export const GATE_RULE = {
  schema: "earlyscript.engine-lab-gate/1",
  min_cutoffs: 7,
  g5_min: 0.65,
  g5_advantage_min: 0.05,
  g5_advantage_ci_lower_above: 0,
  p5_min: 0.8,
  p5_difference_ci_lower_min: -0.05,
  candidate_duplicates_max: 0,
  unsure_share_max: 0.1,
  bootstrap: { resamples: 4000, seed: 20_261_105, unit: "family", level: 0.95 },
  values: "core 1, adjacent 0.5, no / unsure / empty / duplicate 0; a yes needs a grade",
} as const;

export const GATE_RULE_HASH = sha256(canonicalJson(GATE_RULE));

export interface ShadowCard {
  readonly card_id: string;
  readonly cutoff: string;
  readonly terms: string;
  readonly headlines: ArmTrend["headlines"];
}

interface CardMember {
  readonly card_id: string;
  readonly cutoff: string;
  readonly item_ids: ReadonlyArray<string>;
  readonly trend_ids: ReadonlyArray<string>;
}

const shortHash = (text: string) => sha256(text).slice(7, 19);

/** Mulberry32: the same seed gives the same card order and bootstrap everywhere. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const topOf = (arm: ArmOutput) =>
  arm.top.filter((trend) => trend.position <= TOP).toSorted((a, b) => a.position - b.position);

/**
 * One card per topic of the union of both top 5 at each cutoff: a trend of one arm that is a
 * trend of the other (same id, or half the smaller's items) shares its card. Cards carry no
 * arm, position or score, and come shuffled.
 */
export function shadowCards(result: WorkerResult): {
  cards: Array<ShadowCard>;
  members: Array<CardMember>;
} {
  const members: Array<{
    card_id: string;
    cutoff: string;
    item_ids: Array<string>;
    trend_ids: Array<string>;
    trend: ArmTrend;
  }> = [];
  result.arms.reference.forEach((ref, k) => {
    const cand = result.arms.candidate[k]!;
    const groups: Array<{ trends: Array<ArmTrend> }> = [];
    for (const trend of [...topOf(ref), ...topOf(cand)]) {
      const group = groups.find((g) =>
        g.trends.some((t) => t.trend_id === trend.trend_id || isDuplicate(t, trend)),
      );
      if (group) group.trends.push(trend);
      else groups.push({ trends: [trend] });
    }
    for (const group of groups) {
      const trendIds = [...new Set(group.trends.map((t) => t.trend_id))].toSorted();
      members.push({
        card_id: `card_${shortHash(`${result.token}\n${ref.cutoff}\n${trendIds.join(",")}`)}`,
        cutoff: ref.cutoff,
        item_ids: [...new Set(group.trends.flatMap((t) => t.item_ids))],
        trend_ids: trendIds,
        trend: group.trends[0]!,
      });
    }
  });
  const random = prng(GATE_RULE.bootstrap.seed);
  const order = members
    .map((member) => ({ member, key: random() }))
    .toSorted((a, b) => a.key - b.key);
  return {
    cards: order.map(({ member }) => ({
      card_id: member.card_id,
      cutoff: member.cutoff,
      terms: member.trend.label,
      headlines: member.trend.headlines,
    })),
    members: members.map(({ trend: _trend, ...rest }) => rest),
  };
}

export interface CardLabel {
  readonly card_id: string;
  readonly label: "yes" | "no" | "unsure";
  readonly grade: "core" | "adjacent" | null;
}

export type GateVerdict = "pass" | "fail" | "inconclusive";

export interface GateResult {
  readonly rule_hash: string;
  readonly verdict: GateVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly cutoffs: number;
  readonly families: number;
  readonly labels_hash: string;
  readonly candidate: { readonly g5: number; readonly p5: number; readonly duplicates: number };
  readonly reference: { readonly g5: number; readonly p5: number; readonly duplicates: number };
  readonly g5_advantage: {
    readonly mean: number;
    readonly ci_lower: number;
    readonly ci_upper: number;
  };
  readonly p5_difference: {
    readonly mean: number;
    readonly ci_lower: number;
    readonly ci_upper: number;
  };
  readonly unsure_share: number;
}

const round = (x: number) => Math.round(x * 1e4) / 1e4;

/** Families: cards linked across cutoffs when half the smaller's items are shared. */
function familiesOf(members: ReadonlyArray<CardMember>): Map<string, string> {
  const parent = new Map(members.map((m) => [m.card_id, m.card_id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!;
      const b = members[j]!;
      const [small, large] = a.item_ids.length <= b.item_ids.length ? [a, b] : [b, a];
      if (small.item_ids.length === 0) continue;
      const big = new Set(large.item_ids);
      if (small.item_ids.filter((id) => big.has(id)).length >= small.item_ids.length / 2) {
        parent.set(find(a.card_id), find(b.card_id));
      }
    }
  }
  return new Map(members.map((m) => [m.card_id, find(m.card_id)]));
}

export function evaluateGate(input: {
  readonly result: WorkerResult;
  readonly members: ReadonlyArray<CardMember>;
  readonly labels: ReadonlyArray<CardLabel>;
  /** The day the candidate was frozen (its promotion request): every cutoff comes after it. */
  readonly frozenDay: string;
}): GateResult {
  const { result } = input;
  const reasons: Array<string> = [];
  const cutoffs = result.arms.reference.map((arm) => arm.cutoff);
  if (cutoffs.length < GATE_RULE.min_cutoffs) {
    reasons.push(`${cutoffs.length} shadow cutoffs; the gate needs ${GATE_RULE.min_cutoffs}.`);
  }
  const early = cutoffs.filter((cutoff) => cutoff.slice(0, 10) <= input.frozenDay);
  if (early.length > 0)
    reasons.push(`Cutoffs ${early.join(", ")} are not after the freeze (${input.frozenDay}).`);
  const labelOf = new Map(input.labels.map((label) => [label.card_id, label]));
  const pending = input.members.filter((m) => !labelOf.has(m.card_id)).length;
  if (pending > 0) reasons.push(`${pending} of ${input.members.length} cards have no label.`);
  const ungraded = input.labels.filter((l) => l.label === "yes" && l.grade === null).length;
  if (ungraded > 0) reasons.push(`${ungraded} yes labels have no grade.`);
  const unsure = input.labels.filter((l) => l.label === "unsure").length;
  const unsureShare = input.members.length === 0 ? 0 : unsure / input.members.length;
  if (unsureShare > GATE_RULE.unsure_share_max)
    reasons.push(`Unsure share ${round(unsureShare)} above ${GATE_RULE.unsure_share_max}.`);

  const families = familiesOf(input.members);
  const cardOfTrend = new Map<string, string>();
  for (const member of input.members) {
    for (const id of member.trend_ids) cardOfTrend.set(`${member.cutoff}\n${id}`, member.card_id);
  }
  const valueOf = (card: string | undefined) => {
    const label = card === undefined ? undefined : labelOf.get(card);
    if (label === undefined || label.label !== "yes") return { g: 0, p: 0 };
    return { g: label.grade === "core" ? 1 : label.grade === "adjacent" ? 0.5 : 0, p: 1 };
  };
  // Per family: sum of position values of each arm, over every cutoff.
  const byFamily = new Map<string, { gc: number; gr: number; pc: number; pr: number }>();
  const totals = { candidate: { g: 0, p: 0, d: 0 }, reference: { g: 0, p: 0, d: 0 } };
  for (const [side, arms] of [
    ["candidate", result.arms.candidate],
    ["reference", result.arms.reference],
  ] as const) {
    for (const arm of arms) {
      const top = topOf(arm);
      for (const [k, trend] of top.entries()) {
        const duplicate = top.slice(0, k).some((earlier) => isDuplicate(earlier, trend));
        if (duplicate) {
          totals[side].d++;
          continue;
        }
        const card = cardOfTrend.get(`${arm.cutoff}\n${trend.trend_id}`);
        const value = valueOf(card);
        totals[side].g += value.g;
        totals[side].p += value.p;
        const family = card === undefined ? `none:${trend.trend_id}` : families.get(card)!;
        const entry = byFamily.get(family) ?? { gc: 0, gr: 0, pc: 0, pr: 0 };
        if (side === "candidate") {
          entry.gc += value.g;
          entry.pc += value.p;
        } else {
          entry.gr += value.g;
          entry.pr += value.p;
        }
        byFamily.set(family, entry);
      }
    }
  }
  const slots = TOP * Math.max(1, cutoffs.length);
  const diffs = [...byFamily.values()];
  const meanOf = (
    pick: (e: (typeof diffs)[number]) => number,
    sample: ReadonlyArray<(typeof diffs)[number]>,
  ) => sample.reduce((sum, e) => sum + pick(e), 0) / slots;
  const ci = (pick: (e: (typeof diffs)[number]) => number) => {
    const random = prng(GATE_RULE.bootstrap.seed);
    const stats: Array<number> = [];
    for (let r = 0; r < GATE_RULE.bootstrap.resamples; r++) {
      const sample = diffs.map(() => diffs[Math.floor(random() * diffs.length)]!);
      stats.push(meanOf(pick, sample));
    }
    stats.sort((a, b) => a - b);
    const lower = stats[Math.floor(0.025 * stats.length)] ?? 0;
    const upper = stats[Math.min(stats.length - 1, Math.floor(0.975 * stats.length))] ?? 0;
    return { mean: round(meanOf(pick, diffs)), ci_lower: round(lower), ci_upper: round(upper) };
  };
  const g5Advantage = ci((e) => e.gc - e.gr);
  const p5Difference = ci((e) => e.pc - e.pr);
  const candidate = {
    g5: round(totals.candidate.g / slots),
    p5: round(totals.candidate.p / slots),
    duplicates: totals.candidate.d,
  };
  const reference = {
    g5: round(totals.reference.g / slots),
    p5: round(totals.reference.p / slots),
    duplicates: totals.reference.d,
  };

  const insufficient = reasons.length > 0;
  const misses: Array<string> = [];
  if (candidate.duplicates > GATE_RULE.candidate_duplicates_max)
    misses.push(`Candidate has ${candidate.duplicates} duplicates in its top 5.`);
  if (candidate.g5 < GATE_RULE.g5_min)
    misses.push(`Candidate G@5 ${candidate.g5} below ${GATE_RULE.g5_min}.`);
  if (g5Advantage.mean < GATE_RULE.g5_advantage_min)
    misses.push(`G@5 advantage ${g5Advantage.mean} below ${GATE_RULE.g5_advantage_min}.`);
  if (g5Advantage.ci_lower <= GATE_RULE.g5_advantage_ci_lower_above)
    misses.push(`G@5 advantage CI lower bound ${g5Advantage.ci_lower} not above 0.`);
  if (candidate.p5 < GATE_RULE.p5_min)
    misses.push(`Candidate P@5 ${candidate.p5} below ${GATE_RULE.p5_min}.`);
  if (p5Difference.ci_lower < GATE_RULE.p5_difference_ci_lower_min)
    misses.push(
      `P@5 difference CI lower bound ${p5Difference.ci_lower} below ${GATE_RULE.p5_difference_ci_lower_min}.`,
    );
  const clearlyWorse = !insufficient && (candidate.duplicates > 0 || g5Advantage.ci_upper < 0);
  const verdict: GateVerdict = insufficient
    ? "inconclusive"
    : misses.length === 0
      ? "pass"
      : clearlyWorse
        ? "fail"
        : "inconclusive";
  return {
    rule_hash: GATE_RULE_HASH,
    verdict,
    reasons: [...reasons, ...misses],
    cutoffs: cutoffs.length,
    families: diffs.length,
    labels_hash: sha256(
      canonicalJson(input.labels.toSorted((a, b) => (a.card_id < b.card_id ? -1 : 1))),
    ),
    candidate,
    reference,
    g5_advantage: g5Advantage,
    p5_difference: p5Difference,
    unsure_share: round(unsureShare),
  };
}
