// @effect-diagnostics globalDate:off - pure computation on ISO instants.
// engine.v3 (contract v4.2 §2): one cutoff from a stacked corpus to topics with movement,
// features and the two sections, and a topic's dossier/2. Pure: the caller reads the corpus,
// embeds and stacks (run-v3.ts for a run, lists-v3.ts for the evaluation arms). Nothing at or
// after the cutoff enters: every series refuses such an item.
import type {
  DossierV2,
  EmbeddingSpec,
  EvidenceV2,
  Movement,
  SourceWeekRow,
} from "@earlyscript/editorial-contracts/dossier";
import type { ChannelProfile } from "@earlyscript/editorial-contracts/profile";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { type Cohort, cohortAt, SERIES_WEEKS, WEEK_DAYS } from "./comparable.ts";
import { dot } from "./cluster.ts";
import { DAY_MS, dayOf, daysBefore } from "./days.ts";
import { topTerms } from "./dossier.ts";
import type { PreparedItem } from "./prepare.ts";
import { type ProfileScore, type ProfileVectors, scoreProfile } from "./profile.ts";
import { dedupe, positions, round6, score, type Scored } from "./rank.ts";
import { aggregateRelevance, type LoadedRelevance, relevanceOf } from "./relevance.ts";
import {
  canonicalUrl,
  type CoverageIndex,
  corroboration,
  coverageSummary,
  dailyCurve,
  type SeriesItem,
  type UnitItem,
  weeklySeries,
  type WeeklySeries,
} from "./series.ts";
import {
  rareTermsByCutoff,
  sameTopic,
  TOPIC_IDENTITY,
  type TopicMember,
} from "./topic-identity.ts";
import {
  GENERIC_SHARE,
  heavyWeeks,
  MOVING,
  movementOf,
  percentile,
  perennialRule,
  type TrajectoryConfig,
} from "./trajectory.ts";

export const ENGINE_V3_VERSION = "0.3.0";
/** Values the v3 weighted order can name; rank.score throws on any other weight. */
export const V3_RANK_VALUES = [
  "relevance",
  "growth",
  "log_items_7d",
  "sources_7d",
  "items_7d",
  "include_score",
  "log_authors_7d",
] as const;

export interface StackedTopic {
  readonly id: string;
  /** Members published before the cutoff, in stacking order. */
  readonly itemIds: ReadonlyArray<string>;
  readonly firstMs: number;
  readonly lastMs: number;
  readonly centroid: Float32Array;
}

export interface KeywordList {
  readonly version: string;
  readonly terms: ReadonlyArray<string>;
}

export interface V3CutInput {
  readonly config: EngineConfig;
  readonly cutoffDay: string;
  readonly corpusFromDay: string;
  /** Coverage rows of days before the cutoff. */
  readonly coverage: CoverageIndex;
  /** Prepared items of the clustered sources published before the cutoff, excluded ones too. */
  readonly clustered: ReadonlyArray<PreparedItem>;
  readonly vectorOf: ReadonlyMap<string, Float32Array>;
  /** The stacking of the kept clustered items before the cutoff, copied (not shared with a replay). */
  readonly topics: ReadonlyArray<StackedTopic>;
  readonly profile: ChannelProfile;
  readonly profileVectors: ProfileVectors;
  readonly relevance: LoadedRelevance;
  readonly keywords: KeywordList;
  /** Memo of item relevance across cutoffs of one process; filled when given. */
  readonly relevanceMemo?: Map<string, number>;
  /**
   * Hook for "en caída solo con decisión previa pendiente" and "ya decidido el <fecha>": the
   * earlier decision on the same topic, if any. No decision store exists yet: absent, every
   * en caída stays out and decided_at is null.
   */
  readonly priorDecision?: (topic: TopicV3) => { decided_at: string; pending: boolean } | null;
}

/** A topic at the cutoff with its series, movement and features. */
export interface TopicV3 {
  readonly index: number;
  readonly id: string;
  readonly stacked: StackedTopic;
  /** Kept members of the clustered sources. */
  readonly members: ReadonlyArray<PreparedItem>;
  /** Observations for the series: members and the items with their URL, ordered by time. */
  readonly units: ReadonlyArray<UnitItem>;
  readonly series: WeeklySeries;
  readonly movement: Movement;
  readonly perennial: "heavy_weeks" | "life" | null;
  readonly generic: boolean;
  readonly fit: ProfileScore;
  /** exclude ≥ min (and > include when relative): the only discard. */
  readonly excluded: boolean;
  readonly relevance: number;
  readonly relevanceScored: number;
  readonly values: Readonly<Record<string, number>>;
}

const tokenRe = /[a-z][a-z0-9]{2,}/g;

/** Index of the first element whose ms is ≥ ms (units are sorted by ms). */
function lowerBound(units: ReadonlyArray<UnitItem>, ms: number): number {
  let lo = 0;
  let hi = units.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid]!.ms < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The keyword list's terms found in a text, in list order (P1.3 matching, per term). */
export function matchedTerms(terms: ReadonlyArray<string>, text: string): Array<string> {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return terms.filter((term) =>
    new RegExp(
      `(?<![a-z0-9])(?:${escape(term.trim().toLowerCase()).replace(/[\s-]+/g, "[\\s-]+")})(?![a-z0-9])`,
      "i",
    ).test(text),
  );
}

export const trajectoryOf = (config: EngineConfig): TrajectoryConfig => {
  if (!config.trajectory || !config.comparable || !config.sources_cluster)
    throw new Error(
      "engine.v3 needs sources_cluster, comparable and trajectory in the configuration",
    );
  return config.trajectory;
};

/** The cutoff's topics for one popularity τ; movements of earlier cutoffs are computed on demand. */
export class CutAnalysis {
  readonly input: V3CutInput;
  readonly cfg: TrajectoryConfig;
  readonly tauDays: number;
  readonly cutoffMs: number;
  readonly cohort: Cohort;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly percentileTopics: number;
  /** Topics with an observation in the history window. */
  readonly topics: ReadonlyArray<TopicV3>;
  readonly byId: ReadonlyMap<string, TopicV3>;
  readonly alsoIn: ReadonlyMap<string, ReadonlyArray<PreparedItem>>;
  readonly windowUnitsW0: number;
  private readonly allUnits: ReadonlyArray<ReadonlyArray<UnitItem>>;
  private readonly itemsById: ReadonlyMap<string, PreparedItem>;
  private readonly movementsAt = new Map<string, Map<number, Movement>>();
  private readonly sinceMemo = new Map<number, { since: string; capped: boolean }>();
  private termsMemo = new Map<number, Array<string>>();
  private rareMemo: Set<string> | null = null;

  constructor(input: V3CutInput, tauDays?: number) {
    this.input = input;
    const config = input.config;
    this.cfg = trajectoryOf(config);
    this.tauDays = tauDays ?? this.cfg.tau_days;
    const cohort = cohortAt(
      input.coverage,
      config.sources,
      config.sources_cluster!,
      input.cutoffDay,
      input.corpusFromDay,
      config.comparable!,
    );
    this.cohort = cohort;
    this.cutoffMs = cohort.cutoffMs;

    const kept = input.clustered.filter((item) => item.excluded === null);
    const keyOf = (item: PreparedItem) => canonicalUrl(item.external_url) ?? `id:${item.id}`;
    const firstKept = new Map<string, PreparedItem>();
    const byKey = new Map<string, Array<PreparedItem>>();
    for (const item of input.clustered) {
      if (item.excluded === "not_english") continue;
      if (item.publishedMs >= this.cutoffMs)
        throw new Error(`item ${item.id} is not before the cutoff`);
      const key = keyOf(item);
      const list = byKey.get(key) ?? [];
      list.push(item);
      byKey.set(key, list);
      if (item.excluded === null && !firstKept.has(key)) firstKept.set(key, item);
    }
    const alsoIn = new Map<string, Array<PreparedItem>>();
    for (const item of kept) {
      const others = byKey.get(keyOf(item))!.filter((other) => other.id !== item.id);
      if (others.length > 0) alsoIn.set(item.id, others);
    }
    this.alsoIn = alsoIn;
    this.itemsById = new Map(kept.map((item) => [item.id, item]));
    const topicOf = new Map<string, number>();
    input.topics.forEach((topic, t) => {
      for (const id of topic.itemIds) topicOf.set(id, t);
    });
    const unitOf = (item: PreparedItem, key: string): UnitItem => ({
      id: item.id,
      source: item.source,
      ms: item.publishedMs,
      author: item.author,
      key,
    });
    const units: Array<Array<UnitItem>> = input.topics.map(() => []);
    const members: Array<Array<PreparedItem>> = input.topics.map(() => []);
    for (const item of kept) {
      const t = topicOf.get(item.id);
      if (t === undefined) throw new Error(`kept item ${item.id} is in no stacked topic`);
      members[t]!.push(item);
      units[t]!.push(unitOf(item, keyOf(item)));
    }
    // An item dropped as a repeated URL is the same observation: it joins the topic of the
    // first kept item with that URL and counts once there, its source noted.
    for (const item of input.clustered) {
      if (item.excluded !== "duplicate_url") continue;
      const key = keyOf(item);
      const owner = firstKept.get(key);
      const t = owner ? topicOf.get(owner.id) : undefined;
      if (t !== undefined) units[t]!.push(unitOf(item, key));
    }
    for (const list of units) list.sort((a, b) => a.ms - b.ms || (a.id < b.id ? -1 : 1));
    this.allUnits = units;

    const tau = this.tauDays;
    const active: Array<number> = [];
    const seriesOf = new Map<number, WeeklySeries>();
    input.topics.forEach((topic, t) => {
      if (topic.lastMs < cohort.historyFromMs) return;
      const series = weeklySeries(units[t]!, cohort, tau);
      if (series.life === 0 && series.bySource.size === 0) return;
      active.push(t);
      seriesOf.set(t, series);
    });
    const { p50, p90, count } = this.percentilesOf([...seriesOf.values()]);
    this.p50 = p50;
    this.p90 = p90;
    this.percentileTopics = count;

    const comparable = new Set(cohort.comparable);
    const w0Keys = new Set<string>();
    for (const t of active)
      for (const unit of units[t]!)
        if (
          comparable.has(unit.source) &&
          unit.ms >= this.cutoffMs - WEEK_DAYS * DAY_MS &&
          unit.ms >= cohort.historyFromMs &&
          !cohort.unknown.has(`${unit.source}|0`)
        )
          w0Keys.add(unit.key);
    this.windowUnitsW0 = w0Keys.size;
    const genericShare = this.cfg.generic_share ?? GENERIC_SHARE;
    const excludeRule = config.exclude ?? { min: config.profile.exclude_max, relative: true };
    const relevanceRef = config.relevance!;
    const memo = input.relevanceMemo;
    const itemRelevance = (item: PreparedItem) => {
      let value = memo?.get(item.id);
      if (value === undefined) {
        value = relevanceOf(input.relevance, input.vectorOf.get(item.id)!);
        memo?.set(item.id, value);
      }
      return value;
    };
    const w0From = this.cutoffMs - WEEK_DAYS * DAY_MS;
    const topics: Array<TopicV3> = active.map((t) => {
      const stacked = input.topics[t]!;
      const series = seriesOf.get(t)!;
      const perennial = perennialRule(series.weeks, series.life, this.cfg);
      const movement = movementOf(
        {
          weeks: series.weeks,
          firstMs: series.firstMs,
          cutoffMs: this.cutoffMs,
          pop: series.pop,
          p50,
          p90,
        },
        this.cfg,
      );
      const fit = scoreProfile(
        stacked.centroid,
        input.profileVectors,
        config.profile.include_min,
        config.profile.exclude_max,
      );
      const recent = members[t]!.filter(
        (m) =>
          m.publishedMs >= w0From &&
          comparable.has(m.source) &&
          !cohort.unknown.has(`${m.source}|0`),
      );
      const scored = recent.length > 0 ? recent : members[t]!;
      const relevance = aggregateRelevance(
        scored.map(itemRelevance),
        relevanceRef.aggregate ?? "mean",
        relevanceRef.item_min,
      );
      const [n0 = 0, n1 = 0] = series.weeks;
      return {
        index: t,
        id: stacked.id,
        stacked,
        members: members[t]!,
        units: units[t]!,
        series,
        movement,
        perennial,
        generic: n0 > genericShare * this.windowUnitsW0,
        fit,
        excluded:
          fit.exclude_score >= excludeRule.min &&
          (!excludeRule.relative || fit.exclude_score > fit.include_score),
        relevance,
        relevanceScored: scored.length,
        values: {
          relevance,
          growth: Math.log((n0 + 1) / (n1 + 1)),
          log_items_7d: Math.log(1 + n0),
          sources_7d: series.sourcesW0.length,
          items_7d: n0,
          include_score: fit.include_score,
          log_authors_7d: Math.log(1 + series.authorsW0),
        },
      };
    });
    this.topics = topics;
    this.byId = new Map(topics.map((topic) => [topic.id, topic]));
  }

  private percentilesOf(all: ReadonlyArray<WeeklySeries>) {
    const pops = all
      .filter((s) => (s.weeks[0] ?? 0) >= this.cfg.min_items_w0 && !s.incomplete)
      .map((s) => s.pop);
    return {
      p50: percentile(pops, this.cfg.weak_pct),
      p90: percentile(pops, this.cfg.strong_pct),
      count: pops.length,
    };
  }

  /** Movement of every topic that existed at an earlier cutoff day, from its items before it. */
  private movementsOn(day: string): Map<number, Movement> {
    let map = this.movementsAt.get(day);
    if (map) return map;
    const config = this.input.config;
    const cohort = cohortAt(
      this.input.coverage,
      config.sources,
      config.sources_cluster!,
      day,
      this.input.corpusFromDay,
      config.comparable!,
    );
    const series = new Map<number, WeeklySeries>();
    this.input.topics.forEach((topic, t) => {
      if (topic.firstMs >= cohort.cutoffMs || topic.lastMs < cohort.historyFromMs - 0) return;
      const units = this.allUnits[t]!;
      const before = units.slice(0, lowerBound(units, cohort.cutoffMs));
      if (before.length === 0) return;
      series.set(t, weeklySeries(before, cohort, this.tauDays));
    });
    const { p50, p90 } = this.percentilesOf([...series.values()]);
    map = new Map();
    for (const [t, s] of series)
      map.set(
        t,
        movementOf(
          { weeks: s.weeks, firstMs: s.firstMs, cutoffMs: cohort.cutoffMs, pop: s.pop, p50, p90 },
          this.cfg,
        ),
      );
    this.movementsAt.set(day, map);
    return map;
  }

  /**
   * "Fecha de entrada": the first cutoff of the run of daily cutoffs ending here with the same
   * movement, looked for back to the start of the history window (then `capped`).
   */
  since(topic: TopicV3): { since: string; capped: boolean } {
    const memo = this.sinceMemo.get(topic.index);
    if (memo) return memo;
    const days = daysBefore(this.input.cutoffDay, this.input.config.comparable!.window_days);
    let since = this.input.cutoffDay;
    let capped = true;
    for (let k = days.length - 1; k >= 0; k--) {
      const day = days[k]!;
      const earlier = this.movementsOn(day).get(topic.index);
      if (earlier !== topic.movement) {
        capped = false;
        break;
      }
      since = day;
    }
    const result = { since, capped };
    this.sinceMemo.set(topic.index, result);
    return result;
  }

  termsOf(topic: TopicV3): Array<string> {
    let terms = this.termsMemo.get(topic.index);
    if (!terms) {
      terms = topTerms(
        topic.members.map((m) => `${m.title} ${m.cleanBody}`),
        this.input.config.emit.top_terms,
      );
      this.termsMemo.set(topic.index, terms);
    }
    return terms;
  }

  /** Rare terms at the cutoff (TOPIC_IDENTITY) among the terms of the active topics. */
  rare(): Set<string> {
    if (!this.rareMemo) {
      const candidates = new Set(this.topics.flatMap((topic) => this.termsOf(topic)));
      this.rareMemo = rareTermsByCutoff(this.input.clustered, candidates, [
        this.input.cutoffDay,
      ]).get(this.input.cutoffDay)!;
    }
    return this.rareMemo;
  }

  member(topic: TopicV3): TopicMember {
    return {
      key: topic.id,
      trendId: topic.id,
      centroid: topic.stacked.centroid,
      itemIds: new Set(topic.stacked.itemIds),
      terms: this.termsOf(topic),
    };
  }

  /** TOPIC_IDENTITY between two topics of this cutoff (emit dedup_cosine 0.80). */
  same(a: TopicV3, b: TopicV3): boolean {
    const rare = this.rare();
    return sameTopic(this.member(a), this.member(b), (t) => rare.has(t));
  }

  /** W0 titles of kept members, any clustered source. */
  titlesW0(topic: TopicV3): Array<string> {
    const from = this.cutoffMs - WEEK_DAYS * DAY_MS;
    return topic.members.filter((m) => m.publishedMs >= from).map((m) => m.title);
  }

  item(id: string): PreparedItem | undefined {
    return this.itemsById.get(id);
  }
}

export interface Placed {
  readonly topic: TopicV3;
  readonly section: "moving" | "background";
  readonly slot: "rank" | "trajectory" | "background" | "pending_decision";
  readonly position: number;
  readonly scored: Scored;
  /** Position in the section's weighted order after dedup (rankings.weighted.position). */
  readonly weightedPosition: number;
  readonly baselinePosition: number;
  readonly eligible: number;
}

export interface Selection {
  readonly moving: Array<Placed>;
  readonly background: Array<Placed>;
  readonly related: Map<string, Array<{ topic: TopicV3; cosine: number }>>;
  readonly candidates: number;
  readonly discarded: { total: number; by_topic: Record<string, number> };
  readonly admitted: { moving: number; background: number };
  readonly discards: Discards;
}

/**
 * Why candidates (n(W0) ≥ 3) missed a list. `exclude` is the only discard (§2.8), with its
 * topic; `generic` and `incomplete` count admitted topics carrying those marks (ordered last,
 * still eligible); `other`: movements no section admits, folded, and admitted below the list.
 */
export interface Discards {
  readonly candidates: number;
  readonly exclude: number;
  readonly exclude_by_topic: Record<string, number>;
  readonly generic: number;
  readonly incomplete: number;
  readonly other: Record<string, number>;
}

export interface SelectParams {
  readonly method: string;
  readonly weights: Readonly<Record<string, number>>;
  readonly moving: number;
  readonly slots: number;
  readonly background: number;
  readonly trajectoryIncludeMin: number;
}

export const selectParamsOf = (config: EngineConfig): SelectParams => ({
  method: config.rank.weighted.method,
  weights: config.rank.weighted.weights,
  moving: config.emit.moving ?? 10,
  slots: config.emit.moving_trajectory_slots ?? 2,
  background: config.emit.background ?? 5,
  trajectoryIncludeMin: config.emit.trajectory_include_min ?? 0.4,
});

const byId = (a: TopicV3, b: TopicV3) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * §2.9. Moving: nueva/débil/fuerte/rebote without perennial, by weighted order (generic last),
 * folded; first `moving − slots`, then `slots` by sources in W0 then pop (include ≥ min, not
 * generic), then the order again. Background: perennial, n(W0) ≥ 3, not en caída, by relevance.
 */
export function selectV3(analysis: CutAnalysis, params: SelectParams): Selection {
  const { cfg } = analysis;
  const candidates = analysis.topics.filter((t) => (t.series.weeks[0] ?? 0) >= cfg.min_items_w0);
  const decision = analysis.input.priorDecision;
  const pending = (t: TopicV3) => t.movement === "en_caida" && decision?.(t)?.pending === true;
  const profile = analysis.input.profile;
  const discarded = { total: 0, by_topic: {} as Record<string, number> };
  for (const t of candidates) {
    if (!t.excluded) continue;
    discarded.total++;
    const name = profile.exclude[t.fit.nearest_exclude] ?? "(none)";
    discarded.by_topic[name] = (discarded.by_topic[name] ?? 0) + 1;
  }
  const scoredOf = new Map(
    candidates.map((t) => [t.id, score(params.method, params.weights, t.values)] as const),
  );
  const movingPool = candidates.filter(
    (t) => !t.excluded && t.perennial === null && (MOVING.has(t.movement) || pending(t)),
  );
  const backgroundPool = candidates.filter(
    (t) => !t.excluded && t.perennial !== null && (t.movement !== "en_caida" || pending(t)),
  );
  const genericLast = (key: (t: TopicV3) => number) => (a: TopicV3, b: TopicV3) =>
    Number(a.generic) - Number(b.generic) || key(b) - key(a) || byId(a, b);
  const related = new Map<string, Array<{ topic: TopicV3; cosine: number }>>();
  const fold = (ordered: ReadonlyArray<TopicV3>, kept: ReadonlyArray<TopicV3>) => {
    const result = dedupe(
      ordered,
      kept,
      (t) => t.stacked.centroid,
      (a, b) => analysis.same(a, b),
    );
    for (const [id, link] of result.related) {
      const list = related.get(id) ?? [];
      list.push({ topic: link.signal, cosine: link.cosine });
      related.set(id, list);
    }
    return result.kept;
  };
  const weighted = (t: TopicV3) => scoredOf.get(t.id)!.score;
  const movingOrdered = fold(movingPool.toSorted(genericLast(weighted)), []);
  const weightedPos = new Map(movingOrdered.map((t, k) => [t.id, k + 1]));
  const baselinePos = positions(movingOrdered, (t) => t.series.weeks[0] ?? 0);
  const byRank = Math.max(0, params.moving - params.slots);
  const chosen: Array<{ topic: TopicV3; slot: Placed["slot"] }> = movingOrdered
    .slice(0, byRank)
    .map((topic) => ({ topic, slot: pending(topic) ? "pending_decision" : "rank" }));
  const taken = new Set(chosen.map((c) => c.topic.id));
  const trajectoryOrder = movingOrdered
    .filter(
      (t) =>
        !taken.has(t.id) &&
        !t.generic &&
        t.fit.include_score >= params.trajectoryIncludeMin &&
        !pending(t),
    )
    .toSorted(
      (a, b) =>
        b.series.sourcesW0.length - a.series.sourcesW0.length ||
        b.series.pop - a.series.pop ||
        byId(a, b),
    );
  for (const topic of trajectoryOrder.slice(0, params.slots)) {
    chosen.push({ topic, slot: "trajectory" });
    taken.add(topic.id);
  }
  for (const topic of movingOrdered) {
    if (chosen.length >= params.moving) break;
    if (taken.has(topic.id)) continue;
    chosen.push({ topic, slot: pending(topic) ? "pending_decision" : "rank" });
    taken.add(topic.id);
  }
  const moving = chosen.map(({ topic, slot }, k): Placed => ({
    topic,
    section: "moving",
    slot,
    position: k + 1,
    scored: scoredOf.get(topic.id)!,
    weightedPosition: weightedPos.get(topic.id)!,
    baselinePosition: baselinePos.get(topic.id)!,
    eligible: movingOrdered.length,
  }));
  const backgroundOrdered = fold(
    backgroundPool.toSorted(genericLast((t) => t.relevance)),
    moving.map((p) => p.topic),
  );
  const bgWeighted = positions(backgroundOrdered, weighted);
  const bgBaseline = positions(backgroundOrdered, (t) => t.series.weeks[0] ?? 0);
  const background = backgroundOrdered.slice(0, params.background).map((topic, k): Placed => ({
    topic,
    section: "background",
    slot: pending(topic) ? "pending_decision" : "background",
    position: k + 1,
    scored: scoredOf.get(topic.id)!,
    weightedPosition: bgWeighted.get(topic.id)!,
    baselinePosition: bgBaseline.get(topic.id)!,
    eligible: backgroundOrdered.length,
  }));
  const admitted = [...movingPool, ...backgroundPool];
  const emitted = new Set([...moving, ...background].map((p) => p.topic.id));
  const kept = new Set([...movingOrdered, ...backgroundOrdered].map((t) => t.id));
  const notAdmitted = candidates.filter(
    (t) => !t.excluded && !movingPool.includes(t) && !backgroundPool.includes(t),
  );
  const count = (list: ReadonlyArray<TopicV3>, test: (t: TopicV3) => boolean) =>
    list.filter(test).length;
  return {
    moving,
    background,
    related,
    candidates: candidates.length,
    discarded,
    admitted: { moving: movingOrdered.length, background: backgroundOrdered.length },
    discards: {
      candidates: candidates.length,
      exclude: discarded.total,
      exclude_by_topic: discarded.by_topic,
      generic: count(admitted, (t) => t.generic),
      incomplete: count(admitted, (t) => t.series.incomplete),
      other: {
        en_caida_without_pending_decision: count(notAdmitted, (t) => t.movement === "en_caida"),
        estable_without_perennial: count(notAdmitted, (t) => t.movement === "estable"),
        folded_by_topic_identity: admitted.length - kept.size,
        admitted_below_list: kept.size - emitted.size,
      },
    },
  };
}

export interface DossierContext {
  readonly runId: string;
  readonly dossierId: string;
  readonly createdAt: string;
  readonly cutoffAt: string;
  readonly engine: {
    version: string;
    config_hash: string;
    corpus_hash: string;
    embedding: EmbeddingSpec;
  };
  readonly profile: { name: string; version: number | null; hash: string };
  readonly selection: Selection;
}

/** The dossier/2 of a placed topic. Same content for a topic whatever arm placed it, but the placement. */
export function dossierV2(analysis: CutAnalysis, placed: Placed, ctx: DossierContext): DossierV2 {
  const { topic } = placed;
  const { config, profile, relevance } = analysis.input;
  const cohort = analysis.cohort;
  const comparable = new Set(cohort.comparable);
  const terms = analysis.termsOf(topic);
  const [n0 = 0, n1 = 0] = topic.series.weeks;
  const growth = Math.log((n0 + 1) / (n1 + 1));
  const stage =
    growth >= config.stage.growth_min && n0 >= config.stage.growing_min_items_7d
      ? "growing"
      : growth <= config.stage.fading_max
        ? "fading"
        : "steady";
  const counted = topic.units.filter(
    (u) => comparable.has(u.source) && u.ms >= cohort.historyFromMs,
  );
  const seriesItems: Array<SeriesItem> = counted.map((u) => {
    const member = analysis.item(u.id);
    return {
      id: u.id,
      source: u.source,
      day: dayOf(u.ms),
      author: u.author,
      entities: member?.entities ?? [],
    };
  });
  const curveDays = daysBefore(analysis.input.cutoffDay, config.emit.curve_days);
  const firstDay = dayOf(topic.stacked.firstMs);
  const cov = coverageSummary(analysis.input.coverage, cohort.comparable, curveDays);
  const weekOfMs = (ms: number) => {
    if (ms < cohort.historyFromMs) return null;
    const k = Math.floor((analysis.cutoffMs - ms) / (WEEK_DAYS * DAY_MS));
    return k < SERIES_WEEKS ? k : null;
  };
  const sourceOrder = [...topic.series.bySource]
    .map(([source, row]) => ({
      source,
      n: row.weeks.reduce<number>((sum, v) => sum + (v ?? 0), 0),
      comparable: comparable.has(source),
    }))
    .toSorted(
      (a, b) =>
        Number(b.comparable) - Number(a.comparable) || b.n - a.n || (a.source < b.source ? -1 : 1),
    )
    .map((row) => row.source);
  const rankOfSource = (source: SourceId) => {
    const k = sourceOrder.indexOf(source);
    return k < 0 ? sourceOrder.length : k;
  };
  const similarity = (m: PreparedItem) =>
    dot(analysis.input.vectorOf.get(m.id)!, topic.stacked.centroid);
  const evidence = topic.members
    .map((m) => ({ m, week: weekOfMs(m.publishedMs), sim: similarity(m) }))
    .toSorted(
      (a, b) =>
        (a.week ?? 99) - (b.week ?? 99) ||
        rankOfSource(a.m.source) - rankOfSource(b.m.source) ||
        b.sim - a.sim ||
        (a.m.id < b.m.id ? -1 : 1),
    )
    .slice(0, config.emit.max_evidence)
    .map(({ m, week, sim }): EvidenceV2 => ({
      item_id: m.id,
      source: m.source,
      permalink: m.permalink,
      external_url: m.external_url,
      published_at: m.published_at,
      author: m.author,
      title: m.title,
      excerpt: m.cleanBody.slice(0, config.text.excerpt_chars),
      retrieved_at: m.retrieved_at,
      similarity: round6(sim),
      relevance: round6(
        analysis.input.relevanceMemo?.get(m.id) ??
          relevanceOf(relevance, analysis.input.vectorOf.get(m.id)!),
      ),
      week,
      also_in: (analysis.alsoIn.get(m.id) ?? []).map((o) => ({
        source: o.source,
        item_id: o.id,
        permalink: o.permalink,
        published_at: o.published_at,
      })),
    }));
  const w0From = analysis.cutoffMs - WEEK_DAYS * DAY_MS;
  const seenTitles = new Set<string>();
  const headlines = topic.members
    .filter((m) => m.publishedMs >= w0From)
    .map((m) => ({ m, sim: similarity(m) }))
    .toSorted((a, b) => b.sim - a.sim || (a.m.id < b.m.id ? -1 : 1))
    .filter(({ m }) => {
      const key = m.title.toLowerCase();
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, 2)
    .map(({ m }) => ({ item_id: m.id, source: m.source, title: m.title, permalink: m.permalink }));
  const firsts = [...topic.series.firstBySource]
    .map(([source, first]) => ({ source, ...first }))
    .toSorted((a, b) => a.ms - b.ms || (a.source < b.source ? -1 : 1));
  const firstOf = (k: number) => {
    const f = firsts[k];
    return f ? { source: f.source, at: new Date(f.ms).toISOString(), item_id: f.id } : null;
  };
  const by_source: Array<SourceWeekRow> = cohort.rows.map((row) => {
    if (row.status === "no_usada")
      return { source: row.source, status: row.status, weeks: [], total: null, authors_w0: null };
    const weeks = topic.series.bySource.get(row.source)?.weeks ?? [0, 0, 0, 0, 0];
    const known = weeks.filter((v): v is number => v !== null);
    return {
      source: row.source,
      status: row.status,
      weeks,
      total: known.reduce((sum, v) => sum + v, 0),
      authors_w0:
        weeks[0] === null ? null : (topic.series.bySource.get(row.source)?.authorsW0 ?? 0),
    };
  });
  const since = analysis.since(topic);
  const decision = analysis.input.priorDecision?.(topic) ?? null;
  const relevanceRef = config.relevance!;
  const sel = ctx.selection;
  const baseline = score("baseline.items_7d", { items_7d: 1 }, { items_7d: n0 });
  return {
    schema_version: "earlyscript.dossier/2",
    origin: "earlyscript",
    dossier_id: ctx.dossierId,
    run_id: ctx.runId,
    created_at: ctx.createdAt,
    cutoff_at: ctx.cutoffAt,
    engine: ctx.engine,
    profile: ctx.profile,
    trend: {
      id: topic.id,
      label: terms.length > 0 ? terms.slice(0, config.emit.label_terms).join(" ") : topic.id,
      label_source: "terms",
      top_terms: terms,
      stage,
      corroboration: corroboration(seriesItems),
      first_seen_at: new Date(topic.stacked.firstMs).toISOString(),
      last_seen_at: new Date(topic.stacked.lastMs).toISOString(),
      sources: [...new Set(topic.members.map((m) => m.source))].toSorted(),
      items_total: topic.members.length,
      items_7d: n0,
      items_prev_7d: n1,
      authors_7d: topic.series.authorsW0,
      growth: round6(growth),
    },
    profile_fit: {
      include_score: round6(topic.fit.include_score),
      exclude_score: round6(topic.fit.exclude_score),
      passes: topic.fit.passes,
      nearest_include: profile.include[topic.fit.nearest_include] ?? null,
    },
    rankings: {
      eligible: placed.eligible,
      baseline: { ...baseline, position: placed.baselinePosition },
      weighted: { ...placed.scored, position: placed.weightedPosition },
    },
    related: (sel.related.get(topic.id) ?? []).map(({ topic: r, cosine }) => ({
      trend_id: r.id,
      label: analysis.termsOf(r).slice(0, config.emit.label_terms).join(" ") || r.id,
      cosine: round6(cosine),
      items_7d: r.series.weeks[0] ?? 0,
      relevance: round6(r.relevance),
    })),
    curve: dailyCurve(
      seriesItems,
      curveDays.filter((day) => day >= firstDay),
      analysis.input.coverage,
      cohort.comparable,
    ),
    coverage: {
      window_days: curveDays.length,
      by_source: cov.by_source,
      uncertain: cov.data_gaps.length > 0,
    },
    data_gaps: cov.data_gaps,
    evidence,
    evidence_status: evidence.length < config.emit.thin_below ? "thin" : "sufficient",
    movement: {
      section: placed.section,
      slot: placed.slot,
      position: placed.position,
      movement: topic.movement,
      movement_since: since.since,
      movement_since_capped: since.capped,
      first_at: topic.series.firstMs === null ? null : new Date(topic.series.firstMs).toISOString(),
      perennial: topic.perennial !== null,
      perennial_rule: topic.perennial,
      incomplete: topic.series.incomplete,
      generic: topic.generic,
      weeks: topic.series.weeks,
      history_from: cohort.historyFrom,
      items_life: topic.series.life,
      pop: round6(topic.series.pop),
      tau_days: analysis.tauDays,
      authors_w0: topic.series.authorsW0,
      sources_w0: topic.series.sourcesW0,
      by_source,
      first_source: firstOf(0),
      second_source: firstOf(1),
      fit: {
        nearest_include: profile.include[topic.fit.nearest_include] ?? null,
        nearest_exclude: profile.exclude[topic.fit.nearest_exclude] ?? null,
        matched_terms: matchedTerms(
          analysis.input.keywords.terms,
          analysis.titlesW0(topic).join("\n"),
        ),
        keywords_version: analysis.input.keywords.version,
        headlines,
      },
      saturation: {
        items_life: topic.series.life,
        items_total: topic.members.length,
        heavy_weeks: heavyWeeks(topic.series.weeks, analysis.cfg),
        perennial: topic.perennial !== null,
        decided_at: decision ? decision.decided_at : null,
      },
      relevance: {
        score: round6(topic.relevance),
        model_id: relevance.model.model_id,
        model_hash: relevance.hash,
        aggregate: relevanceRef.aggregate ?? "mean",
        items_scored: topic.relevanceScored,
      },
      cut: {
        p50: analysis.p50 === null ? null : round6(analysis.p50),
        p90: analysis.p90 === null ? null : round6(analysis.p90),
        percentile_topics: analysis.percentileTopics,
        comparable_sources: [...cohort.comparable],
        candidates: sel.candidates,
        discarded_by_exclude: sel.discarded.total,
      },
    },
  };
}

/** Exported for tests and the arms: the tokens topTerms and the keyword match read. */
export const tokensOf = (text: string): Array<string> => text.toLowerCase().match(tokenRe) ?? [];
export { TOPIC_IDENTITY };
