// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - evaluation command over a frozen corpus.
// engine.v3 lists for the evaluation (contract v4.2 §4 and §5a, brief of Opus A item 8): for each
// cutoff, the "En movimiento" list of 10 (and "De fondo" of 5 for the v3 variants) of one arm,
// every arm over the same v3 stacking, movements and cards. No metric is computed here and no
// label is read. Files hold no timestamps: two runs write the same bytes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Dossier, DossierV2 } from "@earlyscript/editorial-contracts/dossier";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { dot } from "./cluster.ts";
import { dossierId } from "./dossier.ts";
import { EmbeddingCache } from "./embed/cache.ts";
import { createLocalEmbedder } from "./embed/local.ts";
import { defaultModelDir } from "./embed/model.ts";
import { type Embedder, embeddingSpec } from "./embed/spec.ts";
import {
  CutAnalysis,
  dossierV2,
  ENGINE_V3_VERSION,
  matchedTerms,
  type Discards,
  type Placed,
  type SelectParams,
  selectParamsOf,
  selectV3,
  type Selection,
  type TopicV3,
} from "./engine-v3.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { scoreProfile } from "./profile.ts";
import { dedupe, round6, score, type Scored } from "./rank.ts";
import type { LoadedRelevance } from "./relevance.ts";
import { readRun } from "./check.ts";
import {
  CONFIG_DIR,
  DEFAULT_DATA_DIR,
  type EmittedTrend,
  loadConfig,
  parseCutoff,
  runEngine,
} from "./run.ts";
import {
  loadShared,
  prepareV3Cut,
  readKeywords,
  readProfile,
  resolveProfilePath,
  topicsHash,
  V3_CONFIG_PATH,
} from "./run-v3.ts";
import { createStackReplay } from "./stack-replay.ts";
import { rareTermsByCutoff, sameTopic, TOPIC_IDENTITY } from "./topic-identity.ts";

export const LIST_SCHEMA_VERSION = "earlyscript.v3-list/1";
export const BAG_SCHEMA_VERSION = "earlyscript.v3-bag/1";
export const ARMS = ["V1", "V2", "V3", "V4", "R4", "R2", "R5", "v1", "v2"] as const;
export type Arm = (typeof ARMS)[number];
export const isArm = (value: string): value is Arm =>
  (ARMS as ReadonlyArray<string>).includes(value);

export const ARM_DEFINITIONS: Record<Arm, string> = {
  V1: "engine.v3.json as is: τ 7 d; order 1.0·relevance + 0.25·growth + 0.15·ln(1+n(W0)) + 0.10·sources_7d; two trajectory slots",
  V2: "V1 with popularity τ 14 d (percentiles, movements and trajectory slots recomputed); cards keep τ 7 d",
  V3: "V1 without the sources term: order 1.0·relevance + 0.25·growth + 0.15·ln(1+n(W0))",
  V4: "V1 with relevance weight 0.5",
  R4: "P1.3 keyword list (keywords.v1.json) on the v3 topics: growing (ln((n(W0)+1)/(n(W1)+1)) ≥ 0.69 and n(W0) ≥ 3), a keyword in the top terms or the W0 titles; n(W0) desc",
  R2: "volume: n(W0) desc among topics with include ≥ 0.60 and exclude < 0.60",
  R5: "regression to the mean: n(W0) = 3 and n(W1) ≥ 5; largest n(vida) first",
  v1: "engine.v1.json run with profile v2: its top 10 by weighted position, each projected onto the v3 topic it is the same topic as (TOPIC_IDENTITY; most shared items, then cosine)",
  v2: "engine.v2.json run with profile v2: its top 10 by weighted position, projected as v1",
};

const LIST_SIZE = 10;

/** Text vectors kept in memory across cutoffs and configurations of one process. */
export function memoEmbedder(inner: Embedder): Embedder & { readonly close: () => Promise<void> } {
  const memo = new Map<string, Float32Array>();
  return {
    spec: inner.spec,
    key: inner.key,
    embed: async (texts) => {
      const missing = [...new Set(texts.filter((t) => !memo.has(t)))];
      if (missing.length > 0) {
        const vectors = await inner.embed(missing);
        missing.forEach((text, k) => memo.set(text, vectors[k]!));
      }
      return texts.map((t) => memo.get(t)!);
    },
    dispose: async () => undefined,
    close: () => inner.dispose(),
    stats: () => ({ ...inner.stats?.(), memo: memo.size }),
  };
}

/** A card is the topic's dossier/2 without what depends on the arm: placement and rankings. */
export type Card = Omit<
  DossierV2,
  "rankings" | "dossier_id" | "run_id" | "created_at" | "movement"
> & {
  readonly movement: Omit<DossierV2["movement"], "section" | "slot" | "position">;
};

export interface ListEntry {
  readonly position: number;
  readonly slot: string;
  readonly topic_id: string;
  /** Members of the topic published before the cutoff (kept items of the clustered sources). */
  readonly item_ids: ReadonlyArray<string>;
  readonly arm_score: Scored | null;
  /** v1 and v2: the trend of that engine's run this entry projects. */
  readonly source_trend?: {
    id: string;
    label: string;
    position: number;
    shared_items: number;
    cosine: number;
  };
  readonly card: Card;
}

export interface ArmList {
  readonly schema_version: typeof LIST_SCHEMA_VERSION;
  readonly arm: Arm;
  readonly definition: string;
  readonly cutoff: string;
  readonly cutoff_at: string;
  readonly development: boolean;
  readonly engine: {
    readonly version: string;
    readonly config_hash: string;
    readonly corpus_used_hash: string;
    readonly embedding_key: string;
  };
  readonly profile_hash: string;
  readonly keywords_hash: string;
  readonly arm_params: Record<string, unknown>;
  readonly moving: Array<ListEntry>;
  readonly background: Array<ListEntry>;
  readonly unprojected: Array<{ id: string; label: string; position: number; reason: string }>;
  readonly counts: Record<string, number>;
  /** Candidates (n(W0) ≥ 3) that did not reach the list, by reason (engine-v3.ts Discards). */
  readonly discards: Discards;
  readonly logical_hash: string;
}

const byId = (a: TopicV3, b: TopicV3) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const genericLast = (key: (t: TopicV3) => number) => (a: TopicV3, b: TopicV3) =>
  Number(a.generic) - Number(b.generic) || key(b) - key(a) || byId(a, b);

/** Folds by topic identity and keeps the first `size`. */
function topList(analysis: CutAnalysis, ordered: ReadonlyArray<TopicV3>, size = LIST_SIZE) {
  const { kept } = dedupe(
    ordered,
    [],
    (t) => t.stacked.centroid,
    (a, b) => analysis.same(a, b),
  );
  return kept.slice(0, size);
}

export interface V1Run {
  readonly logicalHash: string;
  readonly dossiers: ReadonlyArray<Dossier>;
  readonly trends: ReadonlyMap<string, EmittedTrend>;
}

/**
 * Projects a run's top 10 onto the v3 topics of the same cutoff: a candidate is a topic with
 * TOPIC_IDENTITY (cosine > 0.80 and two shared rare terms, or half the smaller's items); the
 * one with the most shared items, then the highest cosine, then the smallest id, wins.
 */
export function projectRun(analysis: CutAnalysis, run: V1Run) {
  const top = run.dossiers
    .filter((d) => d.rankings.weighted.position <= LIST_SIZE)
    .toSorted((a, b) => a.rankings.weighted.position - b.rankings.weighted.position);
  const terms = new Set([
    ...analysis.topics.flatMap((t) => analysis.termsOf(t)),
    ...top.flatMap((d) => d.trend.top_terms),
  ]);
  const rare = rareTermsByCutoff(analysis.input.clustered, terms, [analysis.input.cutoffDay]).get(
    analysis.input.cutoffDay,
  )!;
  const entries: Array<{ topic: TopicV3; trend: NonNullable<ListEntry["source_trend"]> }> = [];
  const unprojected: ArmList["unprojected"] = [];
  const used = new Set<string>();
  for (const d of top) {
    const trend = run.trends.get(d.trend.id);
    if (!trend) throw new Error(`no centroid for trend ${d.trend.id}`);
    const items = new Set(trend.itemIds);
    const member = {
      key: d.trend.id,
      trendId: d.trend.id,
      centroid: trend.centroid,
      itemIds: items,
      terms: d.trend.top_terms,
    };
    let best: { topic: TopicV3; shared: number; cosine: number } | null = null;
    for (const topic of analysis.topics) {
      const cosine = dot(trend.centroid, topic.stacked.centroid);
      if (cosine <= TOPIC_IDENTITY.centroid_cosine_above) continue;
      const other = analysis.member(topic);
      if (!sameTopic(member, { ...other, terms: analysis.termsOf(topic) }, (t) => rare.has(t)))
        continue;
      let shared = 0;
      for (const id of topic.stacked.itemIds) if (items.has(id)) shared++;
      if (
        best === null ||
        shared > best.shared ||
        (shared === best.shared &&
          (cosine > best.cosine || (cosine === best.cosine && topic.id < best.topic.id)))
      )
        best = { topic, shared, cosine };
    }
    const position = d.rankings.weighted.position;
    if (!best) {
      unprojected.push({
        id: d.trend.id,
        label: d.trend.label,
        position,
        reason: "no v3 topic with the same topic identity",
      });
      continue;
    }
    if (used.has(best.topic.id)) {
      unprojected.push({
        id: d.trend.id,
        label: d.trend.label,
        position,
        reason: `projects onto ${best.topic.id}, already listed`,
      });
      continue;
    }
    used.add(best.topic.id);
    entries.push({
      topic: best.topic,
      trend: {
        id: d.trend.id,
        label: d.trend.label,
        position,
        shared_items: best.shared,
        cosine: round6(best.cosine),
      },
    });
  }
  return { entries, unprojected };
}

export interface CutLists {
  readonly lists: Map<Arm, ArmList>;
  readonly topics: Record<string, unknown>;
}

export interface ArmContext {
  readonly base: CutAnalysis;
  /** V2: the same cutoff with τ 14. */
  readonly slow: CutAnalysis | null;
  readonly params: SelectParams;
  readonly cardOf: (topic: TopicV3) => Card;
  readonly header: Omit<
    ArmList,
    | "arm"
    | "definition"
    | "arm_params"
    | "moving"
    | "background"
    | "unprojected"
    | "counts"
    | "discards"
    | "logical_hash"
    | "schema_version"
  >;
  readonly runs: Partial<Record<"v1" | "v2", V1Run>>;
}

/**
 * The selection parameters of variants V3 and V4 from engine.v3.json's (V1's): V3 drops the
 * sources term, V4 halves the relevance weight. config/engine.v3-sel.json is V3's as a product
 * configuration (selectParamsOf of it equals variantParams("V3", selectParamsOf(engine.v3.json))).
 */
export function variantParams(arm: "V3" | "V4", params: SelectParams): SelectParams {
  if (arm === "V3") {
    const { sources_7d: _dropped, ...rest } = params.weights;
    return { ...params, method: `${params.method}-sin-fuentes`, weights: rest };
  }
  return {
    ...params,
    method: `${params.method}-relevancia-0.5`,
    weights: { ...params.weights, relevance: 0.5 },
  };
}

/** One arm's list at a cutoff over the base analysis. */
export function armList(arm: Arm, ctx: ArmContext): ArmList {
  const { base, params } = ctx;
  const card = (topic: TopicV3) => ctx.cardOf(base.byId.get(topic.id)!);
  const fromSelection = (selection: Selection, armParams: Record<string, unknown>) => ({
    moving: selection.moving.map((p: Placed) => ({
      position: p.position,
      slot: p.slot,
      topic_id: p.topic.id,
      item_ids: base.byId.get(p.topic.id)!.stacked.itemIds,
      arm_score: p.scored,
      card: card(p.topic),
    })),
    background: selection.background.map((p: Placed) => ({
      position: p.position,
      slot: p.slot,
      topic_id: p.topic.id,
      item_ids: base.byId.get(p.topic.id)!.stacked.itemIds,
      arm_score: p.scored,
      card: card(p.topic),
    })),
    unprojected: [],
    counts: {
      candidates: selection.candidates,
      admitted_moving: selection.admitted.moving,
      admitted_background: selection.admitted.background,
      discarded_by_exclude: selection.discarded.total,
    },
    discards: selection.discards,
    arm_params: armParams,
  });
  const plain = (
    topics: ReadonlyArray<TopicV3>,
    pool: ReadonlyArray<TopicV3>,
    armParams: Record<string, unknown>,
    rule: (t: TopicV3) => string | null,
  ) => ({
    moving: topics.map((topic, k) => ({
      position: k + 1,
      slot: "rank",
      topic_id: topic.id,
      item_ids: topic.stacked.itemIds,
      arm_score: null,
      card: card(topic),
    })),
    background: [],
    unprojected: [],
    counts: { pool: pool.length },
    discards: referenceDiscards(base, pool, topics, rule),
    arm_params: armParams,
  });
  let body: Pick<
    ArmList,
    "moving" | "background" | "unprojected" | "counts" | "discards" | "arm_params"
  >;
  switch (arm) {
    case "V1":
      body = fromSelection(selectV3(base, params), { ...params });
      break;
    case "V2": {
      if (!ctx.slow) throw new Error("V2 needs the τ 14 analysis");
      body = fromSelection(selectV3(ctx.slow, params), { ...params, tau_days: ctx.slow.tauDays });
      break;
    }
    case "V3":
    case "V4": {
      const p = variantParams(arm, params);
      body = fromSelection(selectV3(base, p), { ...p });
      break;
    }
    case "R4": {
      const terms = base.input.keywords.terms;
      const rule = (t: TopicV3) => {
        const [n0 = 0, n1 = 0] = t.series.weeks;
        if (!(n0 >= 3 && Math.log((n0 + 1) / (n1 + 1)) >= 0.69)) return "not_growing";
        return matchedTerms(terms, [...base.termsOf(t), ...base.titlesW0(t)].join("\n")).length > 0
          ? null
          : "no_keyword";
      };
      const pool = base.topics.filter((t) => rule(t) === null);
      body = plain(
        topList(base, pool.toSorted(genericLast((t) => t.series.weeks[0] ?? 0))),
        pool,
        {
          keywords_version: base.input.keywords.version,
          growing: "ln((n0+1)/(n1+1)) >= 0.69 and n0 >= 3",
        },
        rule,
      );
      break;
    }
    case "R2": {
      const { include_min, exclude_max } = base.input.config.profile;
      const rule = (t: TopicV3) =>
        (t.series.weeks[0] ?? 0) < 1
          ? "no_items_w0"
          : t.fit.exclude_score >= exclude_max
            ? "exclude"
            : t.fit.include_score < include_min
              ? "below_include_min"
              : null;
      const pool = base.topics.filter((t) => rule(t) === null);
      body = plain(
        topList(base, pool.toSorted(genericLast((t) => t.series.weeks[0] ?? 0))),
        pool,
        { include_min, exclude_max, exclude: "absolute: exclude_score >= exclude_max" },
        rule,
      );
      break;
    }
    case "R5": {
      const rule = (t: TopicV3) =>
        t.series.weeks[0] === 3 && (t.series.weeks[1] ?? 0) >= 5 ? null : "not_n0_3_n1_5";
      const pool = base.topics.filter((t) => rule(t) === null);
      body = plain(
        topList(base, pool.toSorted(genericLast((t) => t.series.life * 1e6 + t.members.length))),
        pool,
        { n0: 3, n1_min: 5, order: "n(vida) desc, then members, then id" },
        rule,
      );
      break;
    }
    case "v1":
    case "v2": {
      const run = ctx.runs[arm];
      if (!run) throw new Error(`${arm} needs its engine run`);
      const { entries, unprojected } = projectRun(base, run);
      body = {
        moving: entries.map(({ topic, trend }, k) => ({
          position: k + 1,
          slot: "rank",
          topic_id: topic.id,
          item_ids: topic.stacked.itemIds,
          arm_score: null,
          source_trend: trend,
          card: card(topic),
        })),
        background: [],
        unprojected,
        counts: { run_top: entries.length + unprojected.length, projected: entries.length },
        discards: {
          ...referenceDiscards(base, [], [], () => "outside_the_run"),
          other: {
            run_entries_not_projected: unprojected.length,
            note_the_run_applies_its_own_rules: 1,
          },
        },
        arm_params: { run_logical_hash: run.logicalHash },
      };
      break;
    }
  }
  const list = {
    schema_version: LIST_SCHEMA_VERSION as typeof LIST_SCHEMA_VERSION,
    arm,
    definition: ARM_DEFINITIONS[arm],
    ...ctx.header,
    ...body,
  };
  return { ...list, logical_hash: sha256(canonicalJson(JSON.parse(JSON.stringify(list)))) };
}

/**
 * Discards of a reference arm over the same candidates (n(W0) ≥ 3): the arm's own rule decides;
 * `exclude` counts only what its rule excludes by the profile (R2), with the exclude topic.
 */
export function referenceDiscards(
  base: CutAnalysis,
  pool: ReadonlyArray<TopicV3>,
  listed: ReadonlyArray<TopicV3>,
  rule: (t: TopicV3) => string | null,
): Discards {
  const candidates = base.topics.filter((t) => (t.series.weeks[0] ?? 0) >= base.cfg.min_items_w0);
  const other: Record<string, number> = {};
  const byTopic: Record<string, number> = {};
  let exclude = 0;
  for (const t of candidates) {
    const reason = rule(t);
    if (reason === null) continue;
    if (reason === "exclude") {
      exclude++;
      const name = base.input.profile.exclude[t.fit.nearest_exclude] ?? "(none)";
      byTopic[name] = (byTopic[name] ?? 0) + 1;
    } else other[reason] = (other[reason] ?? 0) + 1;
  }
  const inPool = new Set(pool.map((t) => t.id));
  const admitted = candidates.filter((t) => inPool.has(t.id));
  const shown = new Set(listed.map((t) => t.id));
  other["admitted_not_listed"] = admitted.filter((t) => !shown.has(t.id)).length;
  return {
    candidates: candidates.length,
    exclude,
    exclude_by_topic: byTopic,
    generic: admitted.filter((t) => t.generic).length,
    incomplete: admitted.filter((t) => t.series.incomplete).length,
    other,
  };
}

/**
 * Every topic of the stacking at the cutoff, singletons and inactive ones included, with its
 * members before the cutoff: the bag the oracle matches against. Series fields only for the
 * topics with an observation in the history window.
 */
export function stackBag(analysis: CutAnalysis) {
  const input = analysis.input;
  const sourcesOf = new Map<string, string>();
  for (const item of input.clustered)
    if (item.excluded === null) sourcesOf.set(item.id, item.source);
  return {
    schema_version: BAG_SCHEMA_VERSION,
    cutoff: input.cutoffDay,
    profile_hash: null as string | null,
    history_from: analysis.cohort.historyFrom,
    comparable_sources: analysis.cohort.comparable,
    cohort: analysis.cohort.rows,
    p50: analysis.p50,
    p90: analysis.p90,
    percentile_topics: analysis.percentileTopics,
    window_units_w0: analysis.windowUnitsW0,
    topics_hash: topicsHash(analysis),
    topics: input.topics.map((stacked) => {
      const fit = scoreProfile(
        stacked.centroid,
        input.profileVectors,
        input.config.profile.include_min,
        input.config.profile.exclude_max,
      );
      const t = analysis.byId.get(stacked.id);
      return {
        topic_id: stacked.id,
        item_ids: stacked.itemIds,
        include_score: round6(fit.include_score),
        exclude_score: round6(fit.exclude_score),
        nearest_exclude: input.profile.exclude[fit.nearest_exclude] ?? null,
        sources: [...new Set(stacked.itemIds.map((id) => sourcesOf.get(id)!))].toSorted(),
        first_at: new Date(stacked.firstMs).toISOString(),
        last_at: new Date(stacked.lastMs).toISOString(),
        ...(t
          ? {
              weeks: t.series.weeks,
              life: t.series.life,
              pop: round6(t.series.pop),
              first_comparable_at:
                t.series.firstMs === null ? null : new Date(t.series.firstMs).toISOString(),
              movement: t.movement,
              perennial: t.perennial,
              generic: t.generic,
              incomplete: t.series.incomplete,
              excluded: t.excluded,
              sources_w0: t.series.sourcesW0,
              relevance: round6(t.relevance),
            }
          : {}),
      };
    }),
  };
}

export interface ListsOptions {
  readonly corpusDir: string;
  /** Cutoff days, any order; run ascending in one process so the stacking is replayed. */
  readonly cutoffs: ReadonlyArray<string>;
  readonly arms: ReadonlyArray<Arm>;
  /** Writes <outDir>/<arm>/<day>.json and manifest.json; or a single file with `outFile`. */
  readonly outDir?: string;
  readonly outFile?: string;
  /** Writes <bagsDir>/<day>.json (stackBag) for every cutoff when given. */
  readonly bagsDir?: string;
  /** Where the v1 and v2 runs go; defaults beside the lists. */
  readonly runsDir?: string;
  readonly developmentCutoffs?: ReadonlyArray<string>;
  /** Cutoffs whose lists are written; every cutoff by default (bags cover all of them). */
  readonly listCutoffs?: ReadonlyArray<string>;
  readonly configPath?: string;
  readonly profilePath?: string;
  readonly cacheFile?: string;
  readonly cacheOnly?: boolean;
  readonly modelDir?: string;
  readonly workers?: number;
  readonly log?: (line: string) => void;
  /** For tests. */
  readonly embedder?: Embedder;
  readonly config?: EngineConfig;
  readonly v1Config?: EngineConfig;
  readonly v2Config?: EngineConfig;
  readonly relevanceModel?: LoadedRelevance;
}

export interface ListsResult {
  readonly files: Array<{ arm: Arm; cutoff: string; path: string | null; logical_hash: string }>;
  readonly timings: Array<Record<string, unknown>>;
  readonly preflight: Record<string, unknown>;
  readonly lists: Array<ArmList>;
}

/** Items of the clustered sources the cache has no vector for, by source, at the last cutoff. */
function preflight(
  cacheFile: string,
  key: string,
  input: { clustered: ReadonlyArray<{ source: string; text: string; excluded: string | null }> },
) {
  const cache = new EmbeddingCache(cacheFile, key, true);
  const missing: Record<string, number> = {};
  const filtered: Record<string, number> = {};
  try {
    for (const item of input.clustered) {
      if (item.excluded !== null) {
        filtered[`${item.source}:${item.excluded}`] =
          (filtered[`${item.source}:${item.excluded}`] ?? 0) + 1;
        continue;
      }
      if (!cache.get(item.text)) missing[item.source] = (missing[item.source] ?? 0) + 1;
    }
  } finally {
    cache.close();
  }
  return { missing_vectors: missing, filtered };
}

export async function runLists(options: ListsOptions): Promise<ListsResult> {
  const log = options.log ?? (() => undefined);
  const { config, hash: configHash } = options.config
    ? { config: options.config, hash: sha256(canonicalJson(options.config)) }
    : loadConfig(options.configPath ?? V3_CONFIG_PATH);
  const profilePath = options.profilePath ?? resolveProfilePath(config.profile.path ?? "");
  const { profile, hash: profileHash } = readProfile(profilePath, config);
  const keywordsHash = readKeywords().hash;
  const cacheFile =
    options.cacheFile ?? NodePath.join(DEFAULT_DATA_DIR, "embeddings/embeddings.sqlite");
  const inner =
    options.embedder ??
    createLocalEmbedder(embeddingSpec(config.embedder), {
      cacheFile,
      modelDir: options.modelDir ?? defaultModelDir(DEFAULT_DATA_DIR, config.embedder.revision),
      workers: options.workers ?? 1,
      allowDownload: false,
      cacheOnly: options.cacheOnly ?? false,
      log,
    });
  const embedder = memoEmbedder(inner);
  const cutoffs = [...new Set(options.cutoffs)].toSorted();
  const development = new Set(options.developmentCutoffs ?? cutoffs);
  const listed = new Set(options.listCutoffs ?? cutoffs);
  const arms = [...new Set(options.arms)];
  const runsDir =
    options.runsDir ??
    NodePath.join(options.outDir ?? NodePath.dirname(options.outFile ?? "."), "runs");
  const engineConfigs: Partial<Record<"v1" | "v2", EngineConfig>> = {};
  if (arms.includes("v1"))
    engineConfigs.v1 =
      options.v1Config ?? loadConfig(NodePath.join(CONFIG_DIR, "engine.v1.json")).config;
  if (arms.includes("v2"))
    engineConfigs.v2 =
      options.v2Config ?? loadConfig(NodePath.join(CONFIG_DIR, "engine.v2.json")).config;
  const engineStacks = { v1: createStackReplay(), v2: createStackReplay() };
  const result: ListsResult = { files: [], timings: [], preflight: {}, lists: [] };
  try {
    const shared = await loadShared({
      config,
      profile,
      embedder,
      stack: createStackReplay(),
      ...(options.relevanceModel ? { relevanceModel: options.relevanceModel } : {}),
    });
    for (const cutoffDay of cutoffs) {
      const cutoff = `${cutoffDay}T00:00:00.000Z`;
      const { cutoffAt } = parseCutoff(cutoff);
      const t0 = performance.now();
      const prepared = await prepareV3Cut({ corpusDir: options.corpusDir, cutoff, config }, shared);
      if (cutoffDay === cutoffs.at(-1) && options.embedder === undefined)
        Object.assign(result.preflight, {
          cutoff: cutoffDay,
          ...preflight(cacheFile, embedder.key, prepared.input),
        });
      const tPrepared = performance.now();
      const base = new CutAnalysis(prepared.input);
      const slow = arms.includes("V2") ? new CutAnalysis(prepared.input, 14) : null;
      const runs: ArmContext["runs"] = {};
      for (const name of ["v1", "v2"] as const) {
        const engineConfig = engineConfigs[name];
        if (!engineConfig) continue;
        const trends = new Map<string, EmittedTrend>();
        const outDir = NodePath.join(runsDir, name);
        NodeFS.mkdirSync(outDir, { recursive: true });
        const record = await runEngine({
          corpusDir: options.corpusDir,
          cutoff,
          profilePath,
          outDir,
          config: engineConfig,
          embedder,
          stack: engineStacks[name],
          onEmitted: (emitted) => {
            for (const trend of emitted)
              trends.set(trend.id, {
                id: trend.id,
                centroid: trend.centroid.slice(),
                itemIds: [...trend.itemIds],
              });
          },
        });
        if (record.status !== "ok")
          throw new Error(`${name} run at ${cutoffDay} failed: ${record.error}`);
        const { dossiers } = readRun(NodePath.join(outDir, record.run_id));
        runs[name] = { logicalHash: record.logical_hash!, dossiers, trends };
      }
      const tRuns = performance.now();
      const cards = new Map<string, Card>();
      const params = selectParamsOf(config);
      const neutral = selectV3(base, params);
      const cardOf = (topic: TopicV3): Card => {
        let c = cards.get(topic.id);
        if (!c) {
          const placed: Placed = {
            topic,
            section: topic.perennial === null ? "moving" : "background",
            slot: "rank",
            position: 1,
            scored: score(params.method, params.weights, topic.values),
            weightedPosition: 1,
            baselinePosition: 1,
            eligible: 0,
          };
          const d = dossierV2(base, placed, {
            runId: "lists",
            dossierId: dossierId("lists", topic.id),
            createdAt: cutoffAt,
            cutoffAt,
            engine: {
              version: ENGINE_V3_VERSION,
              config_hash: configHash,
              corpus_hash: prepared.corpus.usedHash,
              embedding: embedder.spec,
            },
            profile: { name: profile.name, version: profile.version ?? null, hash: profileHash },
            selection: neutral,
          });
          const { rankings: _r, dossier_id: _d, run_id: _u, created_at: _c, movement, ...rest } = d;
          const { section: _s, slot: _l, position: _p, ...move } = movement;
          c = { ...rest, movement: move };
          cards.set(topic.id, c);
        }
        return c;
      };
      const header: ArmContext["header"] = {
        cutoff: cutoffDay,
        cutoff_at: cutoffAt,
        development: development.has(cutoffDay),
        engine: {
          version: ENGINE_V3_VERSION,
          config_hash: configHash,
          corpus_used_hash: prepared.corpus.usedHash,
          embedding_key: embedder.key,
        },
        profile_hash: profileHash,
        keywords_hash: keywordsHash,
      };
      for (const arm of listed.has(cutoffDay) ? arms : []) {
        const list = armList(arm, { base, slow, params, cardOf, header, runs });
        let path: string | null = null;
        if (options.outFile && cutoffs.length === 1 && arms.length === 1) path = options.outFile;
        else if (options.outDir) path = NodePath.join(options.outDir, arm, `${cutoffDay}.json`);
        if (path) {
          NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
          NodeFS.writeFileSync(path, `${JSON.stringify(list, null, 1)}\n`);
        }
        result.files.push({ arm, cutoff: cutoffDay, path, logical_hash: list.logical_hash });
        if (!path) result.lists.push(list);
      }
      if (options.bagsDir) {
        NodeFS.mkdirSync(options.bagsDir, { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(options.bagsDir, `${cutoffDay}.json`),
          `${JSON.stringify({ ...stackBag(base), profile_hash: profileHash })}\n`,
        );
      }
      const tDone = performance.now();
      const timing = {
        cutoff: cutoffDay,
        prepare_ms: Math.round(tPrepared - t0),
        prepare_detail_ms: prepared.timings_ms,
        engine_runs_ms: Math.round(tRuns - tPrepared),
        analysis_and_lists_ms: Math.round(tDone - tRuns),
        total_ms: Math.round(tDone - t0),
        topics: base.topics.length,
        missing_vectors_embedded: prepared.stats.missing_vectors_embedded,
        items: prepared.stats.embedded,
      };
      result.timings.push(timing);
      log(JSON.stringify(timing));
    }
  } finally {
    await embedder.close();
  }
  return result;
}
