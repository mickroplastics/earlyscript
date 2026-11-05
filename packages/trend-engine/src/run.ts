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
import { dayOf, daysBefore } from "./days.ts";
import { dossierId, logicalHash, topTerms } from "./dossier.ts";
import { createLocalEmbedder } from "./embed/local.ts";
import { defaultModelDir } from "./embed/model.ts";
import { type Embedder, embeddingSpec } from "./embed/spec.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { HOST } from "./host.ts";
import { prepare } from "./prepare.ts";
import { scoreProfile } from "./profile.ts";
import { positions, round6, score } from "./rank.ts";
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
    lap("load");

    let vectors: Array<Float32Array>;
    let topics: { include: Array<Float32Array>; exclude: Array<Float32Array> };
    try {
      vectors = await embedder.embed(kept.map((item) => item.text));
      topics = {
        include: await embedder.embed(profile.include),
        exclude: profile.exclude.length > 0 ? await embedder.embed(profile.exclude) : [],
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
    const signals = stacked.signals.map((signal) => {
      const members = signal.itemIds.map((id) => byId.get(id)!);
      const seriesItems: Array<SeriesItem> = members.map((m) => ({
        id: m.id,
        source: m.source,
        day: m.day,
        author: m.author,
        entities: m.entities,
      }));
      const stage = classify(seriesItems, cutoffDay, coverage, sources, config.stage);
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
      };
      return {
        id: signal.id,
        signal,
        members,
        seriesItems,
        stage,
        fit,
        weighted: score(config.rank.weighted.method, config.rank.weighted.weights, values),
        baseline: score(config.rank.baseline.method, config.rank.baseline.weights, values),
      };
    });
    const eligible = signals.filter((s) => s.stage.stage === "growing" && s.fit.passes);
    const baselinePos = positions(eligible, (s) => s.baseline.score);
    const weightedPos = positions(eligible, (s) => s.weighted.score);
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
          items_7d: s.stage.items_7d,
          items_prev_7d: s.stage.items_prev_7d,
          authors_7d: s.stage.authors_7d,
          growth: round6(s.stage.growth),
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
