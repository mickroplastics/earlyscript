// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library; inputs are decoded with Schema.
// engine.v3 run (contract v4.2 §2): a frozen corpus up to a cutoff, the channel profile and
// engine.v3.json in; run.json and dossiers/NN-<id>.json (dossier/2) out. Wikipedia is read and
// kept, never embedded nor clustered. No language model takes part.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import type { DossierV2 } from "@earlyscript/editorial-contracts/dossier";
import { ChannelProfile } from "@earlyscript/editorial-contracts/profile";
import {
  EngineConfig,
  RUN_SCHEMA_VERSION,
  type RunRecord,
} from "@earlyscript/editorial-contracts/run";
import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { type StackResult, stackItems } from "./cluster.ts";
import { readCorpus } from "./corpus.ts";
import { daysBefore } from "./days.ts";
import { dossierId, logicalHash } from "./dossier.ts";
import { createLocalEmbedder } from "./embed/local.ts";
import { defaultModelDir } from "./embed/model.ts";
import { type Embedder, embeddingSpec } from "./embed/spec.ts";
import {
  CutAnalysis,
  dossierV2,
  ENGINE_V3_VERSION,
  type KeywordList,
  type Placed,
  selectParamsOf,
  selectV3,
  type StackedTopic,
  type V3CutInput,
} from "./engine-v3.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { HOST } from "./host.ts";
import { prepare } from "./prepare.ts";
import { round6 } from "./rank.ts";
import { type LoadedRelevance, loadRelevance } from "./relevance.ts";
import {
  asQuery,
  CONFIG_DIR,
  DEFAULT_DATA_DIR,
  loadConfig,
  parseCutoff,
  type RunOptions,
} from "./run.ts";
import { type CoverageIndex, coverageSummary } from "./series.ts";
import { fixtureSources } from "./sources/index.ts";

const decodeConfig = Schema.decodeUnknownSync(EngineConfig);
const decodeProfile = Schema.decodeUnknownSync(ChannelProfile);

export const KEYWORDS_PATH = NodePath.join(CONFIG_DIR, "editorial-eval/keywords.v1.json");
export const V3_CONFIG_PATH = NodePath.join(CONFIG_DIR, "engine.v3.json");

/** `~/` is the home directory; a relative path is relative to the configuration directory. */
export function resolveProfilePath(path: string): string {
  if (path.startsWith("~/")) return NodePath.join(NodeOS.homedir(), path.slice(2));
  return NodePath.resolve(CONFIG_DIR, path);
}

export function readProfile(
  path: string,
  config: EngineConfig,
): { profile: ChannelProfile; hash: string; path: string } {
  const bytes = NodeFS.readFileSync(path);
  const hash = sha256(bytes);
  if (config.profile.sha256 !== undefined && config.profile.sha256 !== hash)
    throw new Error(
      `profile ${path} has ${hash}; ${config.config_version} expects ${config.profile.sha256}`,
    );
  return { profile: decodeProfile(JSON.parse(bytes.toString("utf8"))), hash, path };
}

export function readKeywords(path = KEYWORDS_PATH): { keywords: KeywordList; hash: string } {
  const bytes = NodeFS.readFileSync(path);
  const parsed = JSON.parse(bytes.toString("utf8")) as KeywordList;
  return { keywords: { version: parsed.version, terms: [...parsed.terms] }, hash: sha256(bytes) };
}

/** What a cutoff needs besides the corpus, shared by every cutoff of one process. */
export interface V3Shared {
  readonly embedder: Embedder;
  readonly stack: (
    items: Parameters<typeof stackItems>[0],
    threshold: number,
    activeDays: number,
  ) => StackResult;
  readonly relevance: LoadedRelevance;
  readonly relevanceMemo: Map<string, number>;
  readonly keywords: KeywordList;
  readonly profile: ChannelProfile;
  readonly profileVectors: { include: Array<Float32Array>; exclude: Array<Float32Array> };
}

export async function loadShared(options: {
  readonly config: EngineConfig;
  readonly profile: ChannelProfile;
  readonly embedder: Embedder;
  readonly stack?: V3Shared["stack"];
  readonly relevanceModel?: LoadedRelevance;
  readonly keywordsPath?: string;
}): Promise<V3Shared> {
  const { config, profile, embedder } = options;
  const ref = config.relevance;
  if (!ref) throw new Error("engine.v3 needs a relevance model");
  const relevance = options.relevanceModel ?? loadRelevance(ref, config.embedder, CONFIG_DIR);
  if (relevance.hash !== ref.sha256)
    throw new Error(`relevance model ${relevance.model.model_id} does not match its sha256`);
  const query = (topic: string) => asQuery(config.profile.query_instruction, topic);
  const profileVectors = {
    include: await embedder.embed(profile.include.map(query)),
    exclude: profile.exclude.length > 0 ? await embedder.embed(profile.exclude.map(query)) : [],
  };
  return {
    embedder,
    stack: options.stack ?? stackItems,
    relevance,
    relevanceMemo: new Map(),
    keywords: readKeywords(options.keywordsPath).keywords,
    profile,
    profileVectors,
  };
}

export interface PreparedCut {
  readonly input: V3CutInput;
  readonly corpus: {
    readonly dir: string;
    readonly usedHash: string;
    readonly manifestHash: string;
    readonly verified: boolean;
    readonly fromDay: string;
    readonly toDay: string;
  };
  readonly stats: {
    readonly read: number;
    readonly before_cutoff_by_source: Record<string, number>;
    /** Read and kept, never embedded (Wikipedia). */
    readonly not_clustered: Record<string, number>;
    /** Filtered before embedding: not English or a URL already seen. */
    readonly filtered: Record<string, Record<string, number>>;
    readonly embedded: Record<string, number>;
    /** Items of the clustered sources the cache had no vector for, embedded by this cutoff. */
    readonly missing_vectors_embedded: number;
    readonly comparisons: number;
    readonly topics: number;
  };
  readonly timings_ms: Record<string, number>;
}

/** Reads the corpus before the cutoff, embeds the kept items of the clustered sources and stacks them. */
export async function prepareV3Cut(
  options: {
    readonly corpusDir: string;
    readonly cutoff: string;
    readonly config: EngineConfig;
    readonly allowUnverifiedCorpus?: boolean;
    readonly priorDecision?: V3CutInput["priorDecision"];
  },
  shared: V3Shared,
): Promise<PreparedCut> {
  const { config } = options;
  const { cutoffMs, cutoffDay } = parseCutoff(options.cutoff);
  const clusteredSources = new Set<SourceId>(config.sources_cluster ?? []);
  const timings_ms: Record<string, number> = {};
  let mark = performance.now();
  const lap = (phase: string) => {
    const now = performance.now();
    timings_ms[phase] = Math.round(now - mark);
    mark = now;
  };
  const corpus = await readCorpus({
    dir: options.corpusDir,
    adapters: fixtureSources(options.corpusDir, config.sources),
    untilDay: cutoffDay,
    ...(options.allowUnverifiedCorpus ? { allowUnverified: true } : {}),
  });
  const beforeCutoff = corpus.items.filter((item) => Date.parse(item.published_at) < cutoffMs);
  const count = (items: ReadonlyArray<{ source: SourceId }>) => {
    const out: Record<string, number> = {};
    for (const item of items) out[item.source] = (out[item.source] ?? 0) + 1;
    return out;
  };
  const clustered = prepare(
    beforeCutoff.filter((item) => clusteredSources.has(item.source)),
    config.text,
  );
  const kept = clustered.filter((item) => item.excluded === null);
  const filtered: Record<string, Record<string, number>> = {};
  for (const item of clustered) {
    if (item.excluded === null) continue;
    const row = (filtered[item.excluded] ??= {});
    row[item.source] = (row[item.source] ?? 0) + 1;
  }
  const coverage: CoverageIndex = new Map();
  for (const row of corpus.coverage) {
    if (row.day >= cutoffDay) continue;
    if (!coverage.has(row.source)) coverage.set(row.source, new Map());
    coverage.get(row.source)!.set(row.day, row.status);
  }
  lap("load");
  const inferredBefore = Number(shared.embedder.stats?.()?.["inferred"] ?? 0);
  const vectors = await shared.embedder.embed(kept.map((item) => item.text));
  const inferred = Number(shared.embedder.stats?.()?.["inferred"] ?? 0) - inferredBefore;
  const vectorOf = new Map(kept.map((item, k) => [item.id, vectors[k]!]));
  lap("embed");
  const stacked = shared.stack(
    kept.map((item) => ({
      id: item.id,
      publishedMs: item.publishedMs,
      vector: vectorOf.get(item.id)!,
    })),
    config.cluster.threshold,
    config.cluster.active_days,
  );
  // A replay shares its signals with later cutoffs: copy what this cutoff sees.
  const topics: Array<StackedTopic> = stacked.signals.map((signal) => ({
    id: signal.id,
    itemIds: signal.itemIds.slice(),
    firstMs: signal.firstMs,
    lastMs: signal.lastMs,
    centroid: signal.centroid.slice(),
  }));
  lap("stack");
  return {
    input: {
      config,
      cutoffDay,
      corpusFromDay: corpus.fromDay,
      coverage,
      clustered,
      vectorOf,
      topics,
      profile: shared.profile,
      profileVectors: shared.profileVectors,
      relevance: shared.relevance,
      keywords: shared.keywords,
      relevanceMemo: shared.relevanceMemo,
      ...(options.priorDecision ? { priorDecision: options.priorDecision } : {}),
    },
    corpus: {
      dir: NodePath.resolve(options.corpusDir),
      usedHash: corpus.usedHash,
      manifestHash: corpus.manifestHash,
      verified: corpus.verified,
      fromDay: corpus.fromDay,
      toDay: corpus.toDay,
    },
    stats: {
      read: corpus.items.length,
      before_cutoff_by_source: count(beforeCutoff),
      not_clustered: count(beforeCutoff.filter((item) => !clusteredSources.has(item.source))),
      filtered,
      embedded: count(kept),
      missing_vectors_embedded: inferred,
      comparisons: stacked.comparisons,
      topics: topics.length,
    },
    timings_ms,
  };
}

/** One row per active topic: a stricter reproducibility check than the dossiers' hash. */
export function topicsHash(analysis: CutAnalysis): string {
  const rows = analysis.topics
    .map((t) => [
      t.id,
      t.series.weeks.join(","),
      round6(t.series.pop),
      t.movement,
      t.perennial ?? "",
      t.generic ? 1 : 0,
      round6(t.fit.include_score),
      round6(t.fit.exclude_score),
      round6(t.relevance),
    ])
    .toSorted((a, b) => (a[0]! < b[0]! ? -1 : 1));
  return sha256(JSON.stringify(rows));
}

const compact = (iso: string) => iso.replace(/[-:]/g, "").slice(0, 15);

export async function runEngineV3(options: RunOptions): Promise<RunRecord> {
  const started = new Date();
  const t0 = performance.now();
  const { cutoffAt, cutoffDay } = parseCutoff(options.cutoff);
  const { config, hash: configHash } = options.config
    ? {
        config: decodeConfig(options.config),
        hash: sha256(canonicalJson(decodeConfig(options.config))),
      }
    : loadConfig(options.configPath ?? V3_CONFIG_PATH);
  const profilePath =
    options.profilePath !== ""
      ? options.profilePath
      : config.profile.path !== undefined
        ? resolveProfilePath(config.profile.path)
        : "";
  if (profilePath === "") throw new Error("engine.v3 run needs a profile");
  const { profile, hash: profileHash } = readProfile(profilePath, config);
  const idHash = sha256(
    `${cutoffAt}\n${configHash}\n${profileHash}\n${NodePath.resolve(options.corpusDir)}\n${started.toISOString()}\n${process.pid}\n${performance.now()}`,
  );
  const runId = `run_${cutoffDay.replaceAll("-", "")}_${compact(started.toISOString())}_${idHash.slice(7, 13)}`;
  const finalDir = NodePath.join(options.outDir, runId);
  const partialDir = NodePath.join(options.outDir, `.partial-${runId}`);
  if (NodeFS.existsSync(finalDir)) throw new Error(`run directory ${finalDir} already exists`);
  NodeFS.mkdirSync(NodePath.join(partialDir, "dossiers"), { recursive: true });

  const spec = embeddingSpec(config.embedder);
  const embedder =
    options.embedder ??
    createLocalEmbedder(spec, {
      cacheFile:
        options.cacheFile ?? NodePath.join(DEFAULT_DATA_DIR, "embeddings/embeddings.sqlite"),
      modelDir: options.modelDir ?? defaultModelDir(DEFAULT_DATA_DIR, config.embedder.revision),
      workers: options.workers ?? 2,
      allowDownload: false,
      cacheOnly: options.cacheOnly ?? false,
      ...(options.log ? { log: options.log } : {}),
    });
  const base = {
    schema_version: RUN_SCHEMA_VERSION,
    run_id: runId,
    cutoff_at: cutoffAt,
    started_at: started.toISOString(),
    engine_version: ENGINE_V3_VERSION,
    config,
    config_hash: configHash,
    profile: {
      path: NodePath.resolve(profilePath),
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

  let timings_ms: Record<string, number> = {};
  let result: Pick<
    RunRecord,
    "status" | "error" | "corpus" | "coverage" | "stats" | "dossiers" | "files" | "logical_hash"
  >;
  try {
    let prepared: PreparedCut;
    try {
      const shared = await loadShared({
        config,
        profile,
        embedder,
        ...(options.stack ? { stack: options.stack } : {}),
        ...(options.relevanceModel ? { relevanceModel: options.relevanceModel } : {}),
      });
      prepared = await prepareV3Cut(
        {
          corpusDir: options.corpusDir,
          cutoff: options.cutoff,
          config,
          ...(options.allowUnverifiedCorpus ? { allowUnverifiedCorpus: true } : {}),
        },
        shared,
      );
    } finally {
      await embedder.dispose();
    }
    timings_ms = { ...prepared.timings_ms };
    let mark = performance.now();
    const analysis = new CutAnalysis(prepared.input);
    const selection = selectV3(analysis, selectParamsOf(config));
    timings_ms["series_movement_rank"] = Math.round(performance.now() - mark);
    mark = performance.now();
    const createdAt = new Date().toISOString();
    const placed: Array<Placed> = [...selection.moving, ...selection.background];
    const dossiers: Array<DossierV2> = placed.map((p) =>
      dossierV2(analysis, p, {
        runId,
        dossierId: dossierId(runId, p.topic.id),
        createdAt,
        cutoffAt,
        engine: {
          version: ENGINE_V3_VERSION,
          config_hash: configHash,
          corpus_hash: prepared.corpus.usedHash,
          embedding: embedder.spec,
        },
        profile: { name: profile.name, version: profile.version ?? null, hash: profileHash },
        selection,
      }),
    );
    const files = dossiers.map((dossier, k) => {
      const name = `dossiers/${String(k + 1).padStart(2, "0")}-${dossier.dossier_id}.json`;
      NodeFS.writeFileSync(
        NodePath.join(partialDir, name),
        `${JSON.stringify(dossier, null, 2)}\n`,
      );
      return name;
    });
    timings_ms["emit"] = Math.round(performance.now() - mark);
    const byMovement: Record<string, number> = {};
    for (const t of analysis.topics) byMovement[t.movement] = (byMovement[t.movement] ?? 0) + 1;
    result = {
      status: "ok",
      error: null,
      corpus: {
        dir: prepared.corpus.dir,
        corpus_used_hash: prepared.corpus.usedHash,
        corpus_manifest_hash: prepared.corpus.manifestHash,
        verified: prepared.corpus.verified,
        from_day: prepared.corpus.fromDay,
        to_day: prepared.corpus.toDay,
      },
      coverage: {
        window_days: config.comparable!.window_days,
        ...coverageSummary(
          prepared.input.coverage,
          analysis.cohort.comparable,
          daysBefore(cutoffDay, config.comparable!.window_days),
        ),
      },
      stats: {
        items: prepared.stats,
        cohort: analysis.cohort.rows,
        history_from: analysis.cohort.historyFrom,
        percentiles: {
          p50: analysis.p50 === null ? null : round6(analysis.p50),
          p90: analysis.p90 === null ? null : round6(analysis.p90),
          topics: analysis.percentileTopics,
          tau_days: analysis.tauDays,
        },
        topics: {
          active: analysis.topics.length,
          candidates: selection.candidates,
          by_movement: byMovement,
          perennial: analysis.topics.filter((t) => t.perennial !== null).length,
          generic: analysis.topics.filter((t) => t.generic).length,
          incomplete: analysis.topics.filter((t) => t.series.incomplete).length,
          admitted: selection.admitted,
          emitted: { moving: selection.moving.length, background: selection.background.length },
          folded: [...selection.related.values()].flat().length,
        },
        /** The nightly count of discards and by which exclude topic. */
        discarded_by_exclude: selection.discarded,
        window_units_w0: analysis.windowUnitsW0,
        topics_hash: topicsHash(analysis),
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
