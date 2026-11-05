// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library; inputs are decoded with Schema.
// One run: a frozen corpus up to a cutoff, the channel profile and a configuration in;
// run.json and dossiers/NN-<id>.json out. Follows Earlywindow's src/engine/run.ts without
// its run database, agent or index. No language model takes part.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import {
  DOSSIER_SCHEMA_VERSION,
  type Dossier,
  type Evidence,
} from "@earlyscript/editorial-contracts/dossier";
import { ChannelProfile } from "@earlyscript/editorial-contracts/profile";
import {
  EngineConfig,
  RUN_SCHEMA_VERSION,
  type RunRecord,
} from "@earlyscript/editorial-contracts/run";
import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { dot, stackItems } from "./cluster.ts";
import { readCorpus } from "./corpus.ts";
import { dayOf, daysBefore, daysBetween } from "./days.ts";
import { dossierId, logicalHash, topTerms } from "./dossier.ts";
import { createLocalEmbedder } from "./embed/local.ts";
import { defaultModelDir } from "./embed/model.ts";
import { type Embedder, embeddingSpec } from "./embed/spec.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { HOST } from "./host.ts";
import { prepare } from "./prepare.ts";
import { scoreProfile } from "./profile.ts";
import { dedupe, positions, round6, score } from "./rank.ts";
import {
  rareTermsByCutoff,
  sameTopic,
  TOPIC_IDENTITY,
  type TopicMember,
} from "./topic-identity.ts";
import {
  aggregateRelevance,
  distinctTitles,
  type LoadedRelevance,
  loadRelevance,
  relevanceOf,
} from "./relevance.ts";
import {
  classify,
  corroboration,
  type CoverageIndex,
  coverageSummary,
  dailyCurve,
  type SeriesItem,
} from "./series.ts";
import { fixtureSources } from "./sources/index.ts";

export const ENGINE_VERSION = "0.1.0";
export const DEFAULT_CONFIG_PATH = NodePath.join(import.meta.dirname, "../config/engine.v1.json");
/** Where a configuration's relevance model file lives, whichever configuration file was read. */
export const CONFIG_DIR = NodePath.dirname(DEFAULT_CONFIG_PATH);
export const DEFAULT_DATA_DIR = NodePath.join(NodeOS.homedir(), "earlyscript-data");

const decodeConfig = Schema.decodeUnknownSync(EngineConfig);
const decodeProfile = Schema.decodeUnknownSync(ChannelProfile);

export interface RunOptions {
  readonly corpusDir: string;
  readonly cutoff: string;
  readonly profilePath: string;
  readonly outDir: string;
  readonly configPath?: string;
  /** Takes precedence over configPath; `check --rerun` passes the config a run recorded. */
  readonly config?: EngineConfig;
  /** Replaces the local Qwen embedder, for tests. The run disposes it. */
  readonly embedder?: Embedder;
  readonly cacheFile?: string;
  readonly cacheOnly?: boolean;
  /** Backtests can reuse an unchanged prefix; normal runs stack independently. */
  readonly stack?: typeof stackItems;
  readonly modelDir?: string;
  readonly workers?: number;
  readonly allowUnverifiedCorpus?: boolean;
  readonly log?: (line: string) => void;
  /** Replaces the model file `config.relevance` names, for tests; its hash must still match. */
  readonly relevanceModel?: LoadedRelevance;
  /** Receives each emitted trend's centroid; `engine backtest` freezes them to label the follow-up. */
  readonly onEmitted?: (trends: ReadonlyArray<EmittedTrend>) => void;
}

export interface EmittedTrend {
  readonly id: string;
  readonly centroid: Float32Array;
  /** Every member, published before the cutoff; `engine eval-editorial` builds blind cards from them. */
  readonly itemIds: ReadonlyArray<string>;
}

export function loadConfig(path: string): { config: EngineConfig; hash: string } {
  const config = decodeConfig(JSON.parse(NodeFS.readFileSync(path, "utf8")));
  return { config, hash: sha256(canonicalJson(config)) };
}

/** Qwen3-Embedding's query format; documents are embedded as they are. */
export const asQuery = (instruction: string | undefined, text: string): string =>
  instruction === undefined ? text : `Instruct: ${instruction}\nQuery:${text}`;

export function parseCutoff(cutoff: string): {
  cutoffAt: string;
  cutoffMs: number;
  cutoffDay: string;
} {
  const cutoffMs = Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) throw new Error(`cutoff ${cutoff} is not an ISO date-time`);
  if (cutoffMs % 86_400_000 !== 0) throw new Error(`cutoff ${cutoff} must be at 00:00:00Z`);
  return { cutoffAt: new Date(cutoffMs).toISOString(), cutoffMs, cutoffDay: dayOf(cutoffMs) };
}

const compact = (iso: string) => iso.replace(/[-:]/g, "").slice(0, 15);

export async function runEngine(options: RunOptions): Promise<RunRecord> {
  const started = new Date();
  const t0 = performance.now();
  const { cutoffAt, cutoffMs, cutoffDay } = parseCutoff(options.cutoff);
  const { config, hash: configHash } = options.config
    ? {
        config: decodeConfig(options.config),
        hash: sha256(canonicalJson(decodeConfig(options.config))),
      }
    : loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  const profileBytes = NodeFS.readFileSync(options.profilePath);
  const profile = decodeProfile(JSON.parse(profileBytes.toString("utf8")));
  const profileHash = sha256(profileBytes);
  // hash6 names the inputs and the instant, so two runs started in the same second differ.
  const idHash = sha256(
    `${cutoffAt}\n${configHash}\n${profileHash}\n${NodePath.resolve(options.corpusDir)}\n${started.toISOString()}\n${process.pid}\n${performance.now()}`,
  );
  const runId = `run_${cutoffDay.replaceAll("-", "")}_${compact(started.toISOString())}_${idHash.slice(7, 13)}`;
  const finalDir = NodePath.join(options.outDir, runId);
  const partialDir = NodePath.join(options.outDir, `.partial-${runId}`);
  if (NodeFS.existsSync(finalDir)) throw new Error(`run directory ${finalDir} already exists`);
  NodeFS.mkdirSync(NodePath.join(partialDir, "dossiers"), { recursive: true });

  const timings_ms: Record<string, number> = {};
  let mark = performance.now();
  const lap = (phase: string) => {
    const now = performance.now();
    timings_ms[phase] = Math.round(now - mark);
    mark = now;
  };

  const spec = embeddingSpec(config.embedder);
  const embedder =
    options.embedder ??
    createLocalEmbedder(spec, {
      cacheFile:
        options.cacheFile ?? NodePath.join(DEFAULT_DATA_DIR, "embeddings/embeddings.sqlite"),
      modelDir: options.modelDir ?? defaultModelDir(DEFAULT_DATA_DIR, config.embedder.revision),
      workers: options.workers ?? 2,
      allowDownload: true,
      cacheOnly: options.cacheOnly ?? false,
      ...(options.log ? { log: options.log } : {}),
    });

  const base = {
    schema_version: RUN_SCHEMA_VERSION,
    run_id: runId,
    cutoff_at: cutoffAt,
    started_at: started.toISOString(),
    engine_version: ENGINE_VERSION,
    config,
    config_hash: configHash,
    profile: {
      path: NodePath.resolve(options.profilePath),
      name: profile.name,
      version: profile.version ?? null,
      hash: profileHash,
    },
    embedding: { ...embedder.spec, config_hash: embedder.key },
    platform: {
      os: HOST.platform,
      arch: HOST.arch,
      node: process.version,
      cpus: NodeOS.availableParallelism(),
    },
  } as const;

  let result: Pick<
    RunRecord,
    "status" | "error" | "corpus" | "coverage" | "stats" | "dossiers" | "files" | "logical_hash"
  >;
  try {
    const sources: ReadonlyArray<SourceId> = config.sources;
    const corpus = await readCorpus({
      dir: options.corpusDir,
      adapters: fixtureSources(options.corpusDir, sources),
      untilDay: cutoffDay,
      ...(options.allowUnverifiedCorpus ? { allowUnverified: true } : {}),
    });
    // Nothing at or after the cutoff enters: day files are skipped by readCorpus, items here.
    const beforeCutoff = corpus.items.filter((item) => Date.parse(item.published_at) < cutoffMs);
    const items = prepare(beforeCutoff, config.text);
    const kept = items.filter((item) => item.excluded === null);
    const coverage: CoverageIndex = new Map();
    for (const row of corpus.coverage) {
      if (row.day >= cutoffDay) continue;
      if (!coverage.has(row.source)) coverage.set(row.source, new Map());
      coverage.get(row.source)!.set(row.day, row.status);
    }
    const relevanceRef = config.relevance ?? null;
    let relevance: LoadedRelevance | null = null;
    if (relevanceRef) {
      relevance =
        options.relevanceModel ?? loadRelevance(relevanceRef, config.embedder, CONFIG_DIR);
      if (relevance.hash !== relevanceRef.sha256)
        throw new Error(`relevance model ${relevance.model.model_id} does not match its sha256`);
    }
    lap("load");

    let vectors: Array<Float32Array>;
    let topics: { include: Array<Float32Array>; exclude: Array<Float32Array> };
    try {
      vectors = await embedder.embed(kept.map((item) => item.text));
      const query = (topic: string) => asQuery(config.profile.query_instruction, topic);
      topics = {
        include: await embedder.embed(profile.include.map(query)),
        exclude: profile.exclude.length > 0 ? await embedder.embed(profile.exclude.map(query)) : [],
      };
    } finally {
      await embedder.dispose();
    }
    const vectorOf = new Map(kept.map((item, k) => [item.id, vectors[k]!]));
    lap("embed");

    const stacked = (options.stack ?? stackItems)(
      kept.map((item) => ({
        id: item.id,
        publishedMs: item.publishedMs,
        vector: vectorOf.get(item.id)!,
      })),
      config.cluster.threshold,
      config.cluster.active_days,
    );
    lap("stack");

    const byId = new Map(kept.map((item) => [item.id, item]));
    const curveDays = daysBefore(cutoffDay, config.emit.curve_days);
    const last7 = new Set(daysBefore(cutoffDay, 7));
    const itemMinOf = relevanceRef?.item_min ?? 0;
    const relevanceById = relevance
      ? new Map(kept.map((item) => [item.id, relevanceOf(relevance, vectorOf.get(item.id)!)]))
      : null;
    // v1 counts every item with the configured rule; with a relevance model or equivalent
    // coverage, the trend's own counts keep the v1 meaning (per_source over all items).
    const rawStage =
      relevanceById !== null || config.stage.coverage_rule === "equivalent"
        ? { ...config.stage, coverage_rule: "per_source" as const }
        : null;
    const signals = stacked.signals.map((signal) => {
      const members = signal.itemIds.map((id) => byId.get(id)!);
      const seriesItems: Array<SeriesItem> = members.map((m) => ({
        id: m.id,
        source: m.source,
        day: m.day,
        author: m.author,
        entities: m.entities,
      }));
      const itemMin = relevanceRef?.item_min ?? 0;
      const counted = relevanceById
        ? seriesItems.filter((item) => relevanceById.get(item.id)! >= itemMin)
        : seriesItems;
      const stage = classify(counted, cutoffDay, coverage, sources, config.stage);
      const raw = rawStage ? classify(seriesItems, cutoffDay, coverage, sources, rawStage) : stage;
      let signalRelevance: { score: number; scored: number; distinct: number } | null = null;
      if (relevanceById) {
        const recent = members.filter((m) => last7.has(m.day));
        const scored = recent.length > 0 ? recent : members;
        signalRelevance = {
          score: aggregateRelevance(
            scored.map((m) => relevanceById.get(m.id)!),
            relevanceRef?.aggregate ?? "mean",
            itemMin,
          ),
          scored: scored.length,
          distinct: distinctTitles(
            recent.filter((m) => relevanceById.get(m.id)! >= itemMin).map((m) => m.title),
          ),
        };
      }
      const fit = scoreProfile(
        signal.centroid,
        topics,
        config.profile.include_min,
        config.profile.exclude_max,
      );
      const values = {
        items_7d: stage.items_7d,
        growth: stage.growth,
        log_authors_7d: Math.log(1 + stage.authors_7d),
        include_score: fit.include_score,
        log_items_7d: Math.log(1 + stage.items_7d),
        relevance: signalRelevance?.score ?? null,
      };
      return {
        id: signal.id,
        signal,
        members,
        seriesItems,
        stage,
        raw,
        counted,
        relevance: signalRelevance,
        fit,
        weighted: score(config.rank.weighted.method, config.rank.weighted.weights, values),
        baseline: score(config.rank.baseline.method, config.rank.baseline.weights, values),
      };
    });
    type Signal = (typeof signals)[number];
    // The dossier's top terms, computed once per signal for the topic identity.
    const termsMemo = new Map<string, Array<string>>();
    const termsOf = (s: Signal) => {
      let terms = termsMemo.get(s.id);
      if (!terms) {
        terms = topTerms(
          s.members.map((m) => `${m.title} ${m.cleanBody}`),
          config.emit.top_terms,
        );
        termsMemo.set(s.id, terms);
      }
      return terms;
    };
    const profileOk = (s: Signal) =>
      !relevanceRef || relevanceRef.profile_gate ? s.fit.passes : true;
    const relevant = (s: Signal) =>
      s.relevance === null ||
      (s.relevance.score >= relevanceRef!.signal_min &&
        s.relevance.distinct >= (relevanceRef!.min_relevant_distinct ?? 0));
    let eligible = signals.filter(
      (s) => s.stage.stage === "growing" && profileOk(s) && relevant(s),
    );
    const novelty = new Map<string, { prior_top_days: Array<string>; grew: boolean }>();
    const recurrent = new Set<string>();
    if (relevanceRef?.novelty && relevanceById) {
      const rule = relevanceRef.novelty;
      const priorTop = priorTopDays(signals, cutoffDay, rule, {
        eligibleAt: (s, day) => {
          const stageAt = classify(
            s.counted.filter((item) => item.day < day),
            day,
            coverage,
            sources,
            config.stage,
          );
          if (stageAt.stage !== "growing" || !profileOk(s)) return null;
          const week = new Set(daysBefore(day, 7));
          const recent = s.members.filter((m) => week.has(m.day));
          const probs = recent.map((m) => relevanceById.get(m.id)!);
          const rel = aggregateRelevance(probs, relevanceRef.aggregate ?? "mean", itemMinOf);
          const distinct = distinctTitles(
            recent.filter((m) => relevanceById.get(m.id)! >= itemMinOf).map((m) => m.title),
          );
          if (rel < relevanceRef.signal_min || distinct < (relevanceRef.min_relevant_distinct ?? 0))
            return null;
          return score(config.rank.weighted.method, config.rank.weighted.weights, {
            items_7d: stageAt.items_7d,
            growth: stageAt.growth,
            log_authors_7d: Math.log(1 + stageAt.authors_7d),
            include_score: s.fit.include_score,
            log_items_7d: Math.log(1 + stageAt.items_7d),
            relevance: rel,
          }).score;
        },
      });
      for (const s of eligible) {
        const days = priorTop.get(s.id);
        if (!days) continue;
        const last = days[days.length - 1]!;
        const since = daysBetween(last, cutoffDay);
        const before = new Set(daysBefore(last, 7));
        const rateSince = s.counted.filter((i) => i.day >= last).length / since.length;
        const rateBefore = s.counted.filter((i) => before.has(i.day)).length / 7;
        const grew = rateSince > 0 && rateSince >= rule.growth_ratio * rateBefore;
        novelty.set(s.id, { prior_top_days: days, grew });
        if (!grew) recurrent.add(s.id);
      }
      eligible = eligible.filter((s) => !recurrent.has(s.id));
    }
    const relatedTo = new Map<string, Array<{ signal: Signal; cosine: number }>>();
    const backfilled = new Set<string>();
    const dedupCosine = config.emit.dedup_cosine;
    if (dedupCosine !== undefined || config.emit.min_dossiers !== undefined) {
      // The candidate ranking decides which of two near-identical trends keeps the position.
      const order = positions(eligible, (s) => s.weighted.score);
      const ordered = eligible.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!);
      // Folding is the engine's topic identity (topic-identity.ts), the same function the
      // evaluation uses for opportunities and families; dedup_cosine must be its cosine.
      if (dedupCosine !== undefined && dedupCosine !== TOPIC_IDENTITY.centroid_cosine_above) {
        throw new Error(
          `emit.dedup_cosine ${dedupCosine} differs from the topic identity's ${TOPIC_IDENTITY.centroid_cosine_above}`,
        );
      }
      const rare =
        dedupCosine === undefined
          ? new Set<string>()
          : rareTermsByCutoff(
              beforeCutoff,
              new Set(
                signals
                  .filter((s) => s.stage.stage === "growing" || s.stage.stage === "steady")
                  .flatMap((s) => termsOf(s)),
              ),
              [cutoffDay],
            ).get(cutoffDay)!;
      const memberOf = (s: Signal): TopicMember => ({
        key: s.id,
        trendId: s.id,
        centroid: s.signal.centroid,
        itemIds: new Set(s.signal.itemIds),
        terms: termsOf(s),
      });
      const same = (a: Signal, b: Signal) =>
        dedupCosine !== undefined && sameTopic(memberOf(a), memberOf(b), (t) => rare.has(t));
      const fold = (list: ReadonlyArray<Signal>, kept: Array<Signal>) => {
        const result = dedupe(list, kept, (s) => s.signal.centroid, same);
        for (const [id, link] of result.related) {
          const entry = relatedTo.get(id) ?? [];
          entry.push(link);
          relatedTo.set(id, entry);
        }
        return result.kept;
      };
      eligible = fold(ordered, []);
      const min = config.emit.min_dossiers ?? 0;
      if (eligible.length < min) {
        // Not a reward for abstaining: the most relevant growing trends below signal_min,
        // then steady ones with enough recent items, fill the cut up to min_dossiers.
        if (!relevanceRef) throw new Error("emit.min_dossiers needs a relevance model");
        const taken = new Set([
          ...eligible,
          ...[...relatedTo.values()].flat().map((l) => l.signal),
        ]);
        const byRelevance = (a: Signal, b: Signal) =>
          b.relevance!.score - a.relevance!.score || (a.id < b.id ? -1 : 1);
        const pool = [
          ...signals
            .filter(
              (s) =>
                s.stage.stage === "growing" &&
                profileOk(s) &&
                !taken.has(s) &&
                !recurrent.has(s.id),
            )
            .toSorted(byRelevance),
          ...signals
            .filter(
              (s) =>
                s.stage.stage === "steady" &&
                s.stage.items_7d >= config.stage.growing_min_items_7d &&
                profileOk(s) &&
                !taken.has(s) &&
                !recurrent.has(s.id),
            )
            .toSorted(byRelevance),
          // Recurrent trends that did not grow come last.
          ...signals.filter((s) => recurrent.has(s.id) && !taken.has(s)).toSorted(byRelevance),
        ];
        const fill: Array<Signal> = [];
        for (const s of pool) {
          if (eligible.length + fill.length >= min) break;
          // A candidate that duplicates a kept trend is folded into it instead.
          if (fold([s], [...eligible, ...fill]).length === 1) fill.push(s);
        }
        for (const s of fill) backfilled.add(s.id);
        eligible = [...eligible, ...fill];
      }
    }
    // Backfilled trends rank after every relevant one in both orderings.
    const rankKey = (scoreOf: (s: Signal) => number) => (s: Signal) =>
      scoreOf(s) - (backfilled.has(s.id) ? 1e9 : 0);
    const baselinePos = positions(
      eligible,
      rankKey((s) => s.baseline.score),
    );
    const weightedPos = positions(
      eligible,
      rankKey((s) => s.weighted.score),
    );
    const max = config.emit.max_dossiers;
    const emitted = eligible
      .filter((s) => baselinePos.get(s.id)! <= max || weightedPos.get(s.id)! <= max)
      .toSorted((a, b) => baselinePos.get(a.id)! - baselinePos.get(b.id)!);
    const cov = coverageSummary(coverage, sources, curveDays);
    options.onEmitted?.(
      emitted.map((s) => ({ id: s.id, centroid: s.signal.centroid, itemIds: s.signal.itemIds })),
    );
    lap("series_stage_profile_rank");

    const createdAt = new Date().toISOString();
    const dossiers = emitted.map((s): Dossier => {
      const firstDay = dayOf(s.signal.firstMs);
      const terms = topTerms(
        s.members.map((m) => `${m.title} ${m.cleanBody}`),
        config.emit.top_terms,
      );
      const evidence = s.members
        .map((m) => ({ m, similarity: dot(vectorOf.get(m.id)!, s.signal.centroid) }))
        .toSorted((a, b) => b.similarity - a.similarity || (a.m.id < b.m.id ? -1 : 1))
        .slice(0, config.emit.max_evidence)
        .map(({ m, similarity }): Evidence => ({
          item_id: m.id,
          source: m.source,
          permalink: m.permalink,
          external_url: m.external_url,
          published_at: m.published_at,
          author: m.author,
          title: m.title,
          excerpt: m.cleanBody.slice(0, config.text.excerpt_chars),
          retrieved_at: m.retrieved_at,
          similarity: round6(similarity),
          ...(relevanceById ? { relevance: round6(relevanceById.get(m.id)!) } : {}),
        }));
      return {
        schema_version: DOSSIER_SCHEMA_VERSION,
        origin: "earlyscript",
        dossier_id: dossierId(runId, s.id),
        run_id: runId,
        created_at: createdAt,
        cutoff_at: cutoffAt,
        engine: {
          version: ENGINE_VERSION,
          config_hash: configHash,
          corpus_hash: corpus.usedHash,
          embedding: embedder.spec,
        },
        profile: { name: profile.name, version: profile.version ?? null, hash: profileHash },
        trend: {
          id: s.id,
          label: terms.length > 0 ? terms.slice(0, config.emit.label_terms).join(" ") : s.id,
          label_source: "terms",
          top_terms: terms,
          stage: s.stage.stage,
          corroboration: corroboration(s.seriesItems),
          first_seen_at: new Date(s.signal.firstMs).toISOString(),
          last_seen_at: new Date(s.signal.lastMs).toISOString(),
          sources: [...new Set(s.members.map((m) => m.source))].toSorted(),
          items_total: s.members.length,
          items_7d: s.raw.items_7d,
          items_prev_7d: s.raw.items_prev_7d,
          authors_7d: s.raw.authors_7d,
          growth: round6(s.raw.growth),
        },
        profile_fit: {
          include_score: round6(s.fit.include_score),
          exclude_score: round6(s.fit.exclude_score),
          passes: s.fit.passes,
          nearest_include: profile.include[s.fit.nearest_include] ?? null,
        },
        rankings: {
          eligible: eligible.length,
          baseline: { ...s.baseline, position: baselinePos.get(s.id)! },
          weighted: { ...s.weighted, position: weightedPos.get(s.id)! },
        },
        ...(relevance && relevanceRef && s.relevance
          ? {
              relevance: {
                score: round6(s.relevance.score),
                model_id: relevance.model.model_id,
                model_hash: relevance.hash,
                item_min: relevanceRef.item_min,
                signal_min: relevanceRef.signal_min,
                items_scored: s.relevance.scored,
                relevant_items_7d: s.stage.items_7d,
                relevant_items_prev_7d: s.stage.items_prev_7d,
                growth: round6(s.stage.growth),
                growth_sources: s.stage.growth_sources ?? [],
                eligibility: backfilled.has(s.id) ? ("backfill" as const) : ("relevant" as const),
                ...(relevanceRef.aggregate ? { aggregate: relevanceRef.aggregate } : {}),
                ...(relevanceRef.min_relevant_distinct !== undefined
                  ? { relevant_distinct_7d: s.relevance.distinct }
                  : {}),
                ...(relevanceRef.novelty
                  ? { novelty: novelty.get(s.id) ?? { prior_top_days: [], grew: false } }
                  : {}),
              },
            }
          : {}),
        ...(dedupCosine !== undefined
          ? {
              related: (relatedTo.get(s.id) ?? []).map(({ signal: r, cosine }) => {
                const terms = topTerms(
                  r.members.map((m) => `${m.title} ${m.cleanBody}`),
                  config.emit.label_terms,
                );
                return {
                  trend_id: r.id,
                  label: terms.length > 0 ? terms.join(" ") : r.id,
                  cosine: round6(cosine),
                  items_7d: r.raw.items_7d,
                  relevance: r.relevance ? round6(r.relevance.score) : null,
                };
              }),
            }
          : {}),
        curve: dailyCurve(
          s.seriesItems,
          curveDays.filter((day) => day >= firstDay),
          coverage,
          sources,
        ),
        coverage: {
          window_days: curveDays.length,
          by_source: cov.by_source,
          uncertain: cov.data_gaps.length > 0,
        },
        data_gaps: cov.data_gaps,
        evidence,
        evidence_status: evidence.length < config.emit.thin_below ? "thin" : "sufficient",
      };
    });
    const files = dossiers.map((dossier, k) => {
      const name = `dossiers/${String(k + 1).padStart(2, "0")}-${dossier.dossier_id}.json`;
      NodeFS.writeFileSync(
        NodePath.join(partialDir, name),
        `${JSON.stringify(dossier, null, 2)}\n`,
      );
      return name;
    });
    lap("emit");

    const exclusions = { not_english: 0, duplicate_url: 0 };
    for (const item of items) if (item.excluded) exclusions[item.excluded]++;
    const byStage = { growing: 0, steady: 0, fading: 0, unclassified: 0 };
    for (const s of signals) byStage[s.stage.stage]++;
    const signalRows = signals
      .map((s) => [
        s.id,
        s.members.length,
        s.stage.stage,
        s.stage.items_7d,
        s.stage.items_prev_7d,
        s.stage.authors_7d,
        round6(s.fit.include_score),
        round6(s.fit.exclude_score),
        ...(s.relevance ? [round6(s.relevance.score)] : []),
      ])
      .toSorted((a, b) => (a[0]! < b[0]! ? -1 : 1));
    result = {
      status: "ok",
      error: null,
      corpus: {
        dir: NodePath.resolve(options.corpusDir),
        corpus_used_hash: corpus.usedHash,
        corpus_manifest_hash: corpus.manifestHash,
        verified: corpus.verified,
        from_day: corpus.fromDay,
        to_day: corpus.toDay,
      },
      coverage: { window_days: curveDays.length, ...cov },
      stats: {
        items: {
          read: corpus.items.length,
          before_cutoff: items.length,
          excluded: exclusions,
          embedded: kept.length,
        },
        missing_days: corpus.missingDays,
        signals: {
          total: signals.length,
          by_stage: byStage,
          passing_profile: signals.filter((s) => s.fit.passes).length,
          eligible: eligible.length,
          ...(relevanceRef
            ? {
                passing_relevance: signals.filter(
                  (s) => s.relevance !== null && s.relevance.score >= relevanceRef.signal_min,
                ).length,
                backfilled: backfilled.size,
                ...(relevanceRef.novelty ? { recurrent: recurrent.size } : {}),
                folded: [...relatedTo.values()].flat().length,
              }
            : {}),
        },
        comparisons: stacked.comparisons,
        /** Every signal, not only the emitted ones: a stricter reproducibility check than logical_hash. */
        signals_hash: sha256(JSON.stringify(signalRows)),
        embedding: embedder.stats?.() ?? null,
      },
      dossiers: dossiers.length,
      files,
      logical_hash: logicalHash(dossiers),
    };
  } catch (error) {
    await embedder.dispose().catch(() => undefined);
    result = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      corpus: null,
      coverage: null,
      stats: null,
      dossiers: 0,
      files: [],
      logical_hash: null,
    };
  }
  const record: RunRecord = {
    ...base,
    ...result,
    finished_at: new Date().toISOString(),
    timings_ms,
    duration_ms: Math.round(performance.now() - t0),
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
  };
  NodeFS.writeFileSync(
    NodePath.join(partialDir, "run.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  NodeFS.renameSync(partialDir, finalDir);
  return record;
}

export const runDir = (outDir: string, record: RunRecord) => NodePath.join(outDir, record.run_id);

/**
 * For each signal, the previous cut days (cutoff - lookback_days .. cutoff - 1, ascending)
 * where it ranked in the top `top` of the trends eligible then, from items before each day.
 */
export function priorTopDays<
  T extends { readonly id: string; readonly members: ReadonlyArray<{ readonly day: string }> },
>(
  signals: ReadonlyArray<T>,
  cutoffDay: string,
  rule: { readonly lookback_days: number; readonly top: number },
  at: {
    /** The trend's weighted score at that cut when it was eligible then, else null. */
    readonly eligibleAt: (signal: T, day: string) => number | null;
  },
): Map<string, Array<string>> {
  const out = new Map<string, Array<string>>();
  for (const day of daysBefore(cutoffDay, rule.lookback_days)) {
    const week = new Set(daysBefore(day, 7));
    const scored: Array<{ id: string; score: number }> = [];
    for (const s of signals) {
      if (!s.members.some((m) => week.has(m.day))) continue;
      const value = at.eligibleAt(s, day);
      if (value !== null) scored.push({ id: s.id, score: value });
    }
    const order = positions(scored, (e) => e.score);
    for (const e of scored) {
      if (order.get(e.id)! > rule.top) continue;
      const days = out.get(e.id) ?? [];
      days.push(day);
      out.set(e.id, days);
    }
  }
  return out;
}
