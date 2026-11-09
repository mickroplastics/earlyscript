// @effect-diagnostics globalDate:off - compares the signed views' instants with their cutoffs.
// The promotion gate, sealed before any campaign: a prospective shadow of at least seven daily
// cutoffs after the candidate was frozen, labelled blind by Miguel on the union of both top 5.
// Only `pass` lets the operator promote a candidate that claims an editorial improvement.
import { canonicalJson, sha256 } from "./hash.ts";
import { isDuplicate, TOP } from "./compare.ts";
import type { ArmOutput, ArmTrend, ViewRecord, WorkerResult } from "./result.ts";

export const GATE_RULE = {
  schema: "earlyscript.engine-lab-gate/1",
  /** Distinct UTC days after the freeze; a repeated day counts once and makes the shadow invalid. */
  min_cutoffs: 7,
  g5_min: 0.65,
  g5_advantage_min: 0.05,
  g5_advantage_ci_lower_above: 0,
  p5_min: 0.8,
  p5_difference_ci_lower_min: -0.05,
  candidate_duplicates_max: 0,
  unsure_share_max: 0.1,
  bootstrap: { resamples: 4000, seed: 20_261_105, unit: "family", level: 0.95 },
  /** Fixed before any campaign: fewer families, or equal replicates, leave it inconclusive. */
  min_families: 5,
  degenerate_resample: "inconclusive",
  /**
   * Each arm's mean value per top-5 position, recomputed over the positions a resample of
   * families drew: each mean stays in [0, 1], the difference in [-1, 1]. Duplicate and empty
   * positions are units of their own worth 0, so the full sample gives the reported difference.
   */
  estimand: "difference of per-position means, family cluster bootstrap of the ratio",
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
  readonly distinct_days: number;
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

/** Families: cards linked across cutoffs when half the smaller's items are shared (also v3's §5a). */
export function familiesOf(
  members: ReadonlyArray<Pick<CardMember, "card_id" | "item_ids">>,
): Map<string, string> {
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
  /**
   * How the shadow was observed, from the server's records and the signed result: the views
   * the executor made, never before their cutoff, and the server's time the job started, after
   * the last cutoff. Absent, the shadow proves nothing about when it was run.
   */
  readonly observed: {
    readonly views: ReadonlyArray<ViewRecord> | undefined;
    readonly startedAt: string | null;
  };
}): GateResult {
  const { result } = input;
  const reasons: Array<string> = [];
  const views = input.observed.views ?? [];
  const lastCutoff = result.arms.reference.at(-1)?.cutoff;
  if (
    views.length !== result.arms.reference.length ||
    views.some((view, k) => view.cutoff !== result.arms.reference[k]?.cutoff)
  ) {
    reasons.push("The shadow carries no observation of each cutoff's corpus.");
  }
  const early = views.filter((view) => !(Date.parse(view.observed_at) >= Date.parse(view.cutoff)));
  if (early.length > 0) {
    reasons.push(
      `Cutoffs ${early.map((view) => view.cutoff.slice(0, 10)).join(", ")} were viewed before they passed.`,
    );
  }
  if (
    lastCutoff === undefined ||
    input.observed.startedAt === null ||
    !(Date.parse(input.observed.startedAt) >= Date.parse(lastCutoff))
  ) {
    reasons.push("The shadow job did not start after its last cutoff had passed.");
  }
  const cutoffs = result.arms.reference.map((arm) => arm.cutoff);
  // Days, not entries: the same day twice is one observation, whatever the array says.
  const days = new Set(cutoffs.map((cutoff) => cutoff.slice(0, 10)));
  if (days.size !== cutoffs.length) {
    reasons.push(
      `The shadow repeats days: ${cutoffs.length} cutoffs over ${days.size} distinct days.`,
    );
  }
  if (days.size < GATE_RULE.min_cutoffs) {
    reasons.push(`${days.size} distinct shadow days; the gate needs ${GATE_RULE.min_cutoffs}.`);
  }
  const beforeFreeze = cutoffs.filter((cutoff) => cutoff.slice(0, 10) <= input.frozenDay);
  if (beforeFreeze.length > 0)
    reasons.push(
      `Cutoffs ${beforeFreeze.join(", ")} are not after the freeze (${input.frozenDay}).`,
    );
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
  // Per family: the sum of position values and the number of positions of each arm, over
  // every cutoff. Duplicate and empty positions are units of their own, worth 0.
  interface Unit {
    gc: number;
    gr: number;
    pc: number;
    pr: number;
    nc: number;
    nr: number;
    readonly real: boolean;
  }
  const byFamily = new Map<string, Unit>();
  const unit = (key: string, real: boolean) => {
    const found = byFamily.get(key);
    if (found !== undefined) return found;
    const created: Unit = { gc: 0, gr: 0, pc: 0, pr: 0, nc: 0, nr: 0, real };
    byFamily.set(key, created);
    return created;
  };
  const totals = { candidate: { g: 0, p: 0, d: 0 }, reference: { g: 0, p: 0, d: 0 } };
  for (const [side, arms] of [
    ["candidate", result.arms.candidate],
    ["reference", result.arms.reference],
  ] as const) {
    for (const arm of arms) {
      const top = topOf(arm);
      for (let k = 0; k < TOP; k++) {
        const trend = top[k];
        const add = (entry: Unit, value: { g: number; p: number }) => {
          if (side === "candidate") {
            entry.gc += value.g;
            entry.pc += value.p;
            entry.nc++;
          } else {
            entry.gr += value.g;
            entry.pr += value.p;
            entry.nr++;
          }
        };
        if (trend === undefined) {
          add(unit(`empty:${side}:${arm.cutoff}:${k}`, false), { g: 0, p: 0 });
          continue;
        }
        if (top.slice(0, k).some((earlier) => isDuplicate(earlier, trend))) {
          totals[side].d++;
          add(unit(`duplicate:${side}:${arm.cutoff}:${k}`, false), { g: 0, p: 0 });
          continue;
        }
        const card = cardOfTrend.get(`${arm.cutoff}\n${trend.trend_id}`);
        const value = valueOf(card);
        totals[side].g += value.g;
        totals[side].p += value.p;
        add(unit(card === undefined ? `none:${trend.trend_id}` : families.get(card)!, true), value);
      }
    }
  }
  const slots = TOP * Math.max(1, cutoffs.length);
  const units = [...byFamily.values()];
  const realFamilies = units.filter((entry) => entry.real).length;
  if (realFamilies < GATE_RULE.min_families) {
    reasons.push(
      `${realFamilies} distinct topic families among the evaluated positions; the gate needs ${GATE_RULE.min_families} to infer.`,
    );
  }
  type Pick = (e: Unit) => { readonly c: number; readonly r: number };
  const differenceOf = (pick: Pick, sample: ReadonlyArray<Unit>) => {
    let c = 0;
    let r = 0;
    let nc = 0;
    let nr = 0;
    for (const entry of sample) {
      const value = pick(entry);
      c += value.c;
      r += value.r;
      nc += entry.nc;
      nr += entry.nr;
    }
    return (nc === 0 ? 0 : c / nc) - (nr === 0 ? 0 : r / nr);
  };
  let degenerate = false;
  const ci = (pick: Pick) => {
    const random = prng(GATE_RULE.bootstrap.seed);
    const stats: Array<number> = [];
    for (let r = 0; r < GATE_RULE.bootstrap.resamples; r++) {
      const sample = units.map(() => units[Math.floor(random() * units.length)]!);
      stats.push(differenceOf(pick, sample));
    }
    stats.sort((a, b) => a - b);
    if (stats.length === 0 || stats[0] === stats.at(-1)) degenerate = true;
    const lower = stats[Math.floor(0.025 * stats.length)] ?? 0;
    const upper = stats[Math.min(stats.length - 1, Math.floor(0.975 * stats.length))] ?? 0;
    return {
      mean: round(differenceOf(pick, units)),
      ci_lower: round(lower),
      ci_upper: round(upper),
    };
  };
  const g5Advantage = ci((e) => ({ c: e.gc, r: e.gr }));
  const p5Difference = ci((e) => ({ c: e.pc, r: e.pr }));
  if (degenerate) {
    reasons.push("Every bootstrap replicate is equal: the resample is degenerate.");
  }
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
    distinct_days: days.size,
    families: realFamilies,
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
