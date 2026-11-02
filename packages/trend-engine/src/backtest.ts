// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library; reports are decoded with Schema.
// `engine backtest`: does adding a source keep the engine's precision? Runs the engine at each
// cutoff twice, with the baseline sources and with the candidate sources, and labels every
// emitted trend against the stories of the following days with Earlywindow's retrospective
// rule (early-window/scripts/backtest.ts, backtest.v0.02). The verdict compares the weighted
// ranking of both arms: P@5 and median lead_days.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import type { Dossier } from "@earlyscript/editorial-contracts/dossier";
import { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { CoverageStatus, SourceId } from "@earlyscript/editorial-contracts/source";

import {
  type ArmTotal,
  BACKTEST_SCHEMA_VERSION,
  backtestId,
  backtestLogicalHash,
  BacktestRerunInputs,
  checkBacktestReport,
  type CutoffGroupTotal,
  decideBacktest,
  LABEL_RULE,
  MIN_COMPLETE_CUTOFFS,
  P_AT_5_TOLERANCE,
  type VerdictResult,
} from "./backtest-report.ts";
import {
  type Candidate,
  labelCandidates,
  median,
  type RankingMetrics,
  rankingMetrics,
  type Story,
} from "./backtest-label.ts";
import { readRun } from "./check.ts";
import { dot } from "./cluster.ts";
import { readCorpus } from "./corpus.ts";
import { DAY_MS, dayOf, dayStart } from "./days.ts";
import { createLocalEmbedder } from "./embed/local.ts";
import { defaultModelDir } from "./embed/model.ts";
import { type Embedder, embeddingSpec } from "./embed/spec.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { prepare } from "./prepare.ts";
import { round6 } from "./rank.ts";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_DATA_DIR,
  ENGINE_VERSION,
  type EmittedTrend,
  loadConfig,
  parseCutoff,
  runDir,
  runEngine,
} from "./run.ts";
import { fixtureSources } from "./sources/index.ts";

const decodeConfig = Schema.decodeUnknownSync(EngineConfig);

const mean = (values: ReadonlyArray<number | null>): number | null => {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length === 0 ? null : round6(xs.reduce((a, b) => a + b, 0) / xs.length);
};

export type Arm = "baseline" | "candidate";
const ARMS: ReadonlyArray<Arm> = ["baseline", "candidate"];

export interface BacktestOptions {
  readonly corpusDir: string;
  readonly profilePath: string;
  readonly outDir: string;
  /** UTC days (YYYY-MM-DD) or ISO instants at 00:00Z. */
  readonly cutoffs: ReadonlyArray<string>;
  readonly baselineSources: ReadonlyArray<SourceId>;
  readonly candidateSources: ReadonlyArray<SourceId>;
  /** Sources whose follow-up stories decide the label; the baseline sources when absent. */
  readonly truthSources?: ReadonlyArray<SourceId>;
  readonly configPath?: string;
  /** Takes precedence over configPath; its `sources` is replaced by each arm's. */
  readonly config?: EngineConfig;
  /** Replaces the local Qwen embedder, for tests. The backtest disposes it. */
  readonly embedder?: Embedder;
  readonly cacheFile?: string;
  readonly modelDir?: string;
  readonly workers?: number;
  readonly allowUnverifiedCorpus?: boolean;
  readonly log?: (line: string) => void;
}

interface Row {
  readonly trend_id: string;
  readonly label: string;
  readonly weighted_position: number;
  readonly items_7d_position: number;
  readonly weighted_score: number;
  readonly items_7d: number;
  readonly sources: ReadonlyArray<string>;
  readonly positive: boolean;
  readonly event_day: string | null;
  readonly lead_days: number | null;
  readonly followup_stories: number;
  readonly followup_authors: number;
}

interface ArmCutoff {
  readonly run_logical_hash: string | null;
  readonly corpus_used_hash: string | null;
  readonly candidates: number;
  readonly positives: number;
  readonly weighted: RankingMetrics;
  /** Earlywindow's in-run baseline: the same candidates ordered by items_7d desc, id asc. */
  readonly items_7d: RankingMetrics;
  readonly lead_days: ReadonlyArray<number>;
  readonly median_lead_days: number | null;
  /** Evidence items whose similarity to the frozen centroid was recomputed and matched. */
  readonly centroid_checks: number;
  readonly rows: ReadonlyArray<Row>;
}

interface RunEntry {
  readonly arm: Arm;
  readonly cutoff_at: string;
  readonly run_id: string;
  readonly run_dir: string;
  readonly duration_ms: number;
}

/** Parses a cutoff list: comma-separated days or instants, and `from..to` inclusive day ranges. */
export function parseCutoffList(text: string): Array<string> {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .flatMap((part) => {
      const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(part);
      if (!range) return [part];
      const days: Array<string> = [];
      for (let ms = dayStart(range[1]!); ms <= dayStart(range[2]!); ms += DAY_MS) {
        days.push(dayOf(ms));
      }
      return days;
    });
}

const toInstant = (cutoff: string) =>
  parseCutoff(/^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? `${cutoff}T00:00:00Z` : cutoff);

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((x) => b.includes(x));

const COVERED: ReadonlySet<CoverageStatus> = new Set(["complete", "partial"]);

export interface BacktestResult {
  readonly path: string;
  readonly report: Record<string, unknown> & {
    readonly backtest_id: string;
    readonly logical_hash: string;
  };
  readonly status: "final" | "provisional";
  readonly verdict: VerdictResult;
  readonly total: { readonly complete: CutoffGroupTotal; readonly partial: CutoffGroupTotal };
}

export async function runBacktest(options: BacktestOptions): Promise<BacktestResult> {
  const started = new Date();
  const t0 = performance.now();
  const log = options.log ?? (() => undefined);
  const { config: baseConfig, hash: configHash } = options.config
    ? {
        config: decodeConfig(options.config),
        hash: sha256(canonicalJson(decodeConfig(options.config))),
      }
    : loadConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  const baselineSources = [...new Set(options.baselineSources)];
  const candidateSources = [...new Set(options.candidateSources)];
  const truthSources = [...new Set(options.truthSources ?? baselineSources)];
  if (baselineSources.length === 0 || candidateSources.length === 0) {
    throw new Error("backtest needs baseline and candidate sources");
  }
  if (sameSet(baselineSources, candidateSources)) {
    throw new Error("baseline and candidate sources are the same set");
  }
  const armConfig: Record<Arm, EngineConfig> = {
    baseline: decodeConfig({ ...baseConfig, sources: baselineSources }),
    candidate: decodeConfig({ ...baseConfig, sources: candidateSources }),
  };
  const cutoffs = [...new Set(options.cutoffs.map((c) => toInstant(c).cutoffAt))].toSorted();
  if (cutoffs.length === 0) throw new Error("backtest needs at least one cutoff");
  const profileHash = sha256(NodeFS.readFileSync(options.profilePath));
  const threshold = baseConfig.cluster.threshold;

  const inner =
    options.embedder ??
    createLocalEmbedder(embeddingSpec(baseConfig.embedder), {
      cacheFile:
        options.cacheFile ?? NodePath.join(DEFAULT_DATA_DIR, "embeddings/embeddings.sqlite"),
      modelDir: options.modelDir ?? defaultModelDir(DEFAULT_DATA_DIR, baseConfig.embedder.revision),
      workers: options.workers ?? 2,
      allowDownload: true,
      log,
    });
  // Runs dispose the embedder they get; the backtest shares one and disposes it once.
  const shared: Embedder = {
    spec: inner.spec,
    key: inner.key,
    embed: (texts) => inner.embed(texts),
    dispose: async () => undefined,
  };

  NodeFS.mkdirSync(options.outDir, { recursive: true });
  const runs: Array<RunEntry> = [];
  const perCutoff: Array<Record<Arm, ArmCutoff> & { cutoff_at: string }> = [];
  let truth: {
    usedHash: string;
    manifestHash: string;
    toDay: string;
    stories: Array<Story>;
    covered: Set<string>;
  };
  try {
    // Truth: every story of the truth sources up to the last follow-up window, prepared as a run
    // prepares it (duplicate URLs across the whole span excluded), embedded once.
    const lastEndMs = Date.parse(cutoffs.at(-1)!) + LABEL_RULE.followup_days * DAY_MS;
    const corpus = await readCorpus({
      dir: options.corpusDir,
      adapters: fixtureSources(options.corpusDir, truthSources),
      untilDay: dayOf(lastEndMs),
      ...(options.allowUnverifiedCorpus ? { allowUnverified: true } : {}),
    });
    const prepared = prepare(
      corpus.items.filter((item) => Date.parse(item.published_at) < lastEndMs),
      baseConfig.text,
    ).filter((item) => item.excluded === null);
    log(`backtest: embedding ${prepared.length} truth stories`);
    const vectors = await shared.embed(prepared.map((item) => item.text));
    truth = {
      usedHash: corpus.usedHash,
      manifestHash: corpus.manifestHash,
      toDay: corpus.toDay,
      stories: prepared.map((item, k) => ({
        id: item.id,
        publishedMs: item.publishedMs,
        author: item.author,
        vector: vectors[k]!,
      })),
      covered: new Set(
        corpus.coverage
          .filter((row) => COVERED.has(row.status))
          .map((row) => `${row.source}/${row.day}`),
      ),
    };
    const vectorOf = new Map(truth.stories.map((story) => [story.id, story.vector]));

    for (const cutoffAt of cutoffs) {
      const cutoffMs = Date.parse(cutoffAt);
      const entry = { cutoff_at: cutoffAt } as Record<Arm, ArmCutoff> & { cutoff_at: string };
      for (const arm of ARMS) {
        let emitted: ReadonlyArray<EmittedTrend> = [];
        const armOut = NodePath.join(options.outDir, "runs", arm);
        NodeFS.mkdirSync(armOut, { recursive: true });
        const record = await runEngine({
          corpusDir: options.corpusDir,
          cutoff: cutoffAt,
          profilePath: options.profilePath,
          outDir: armOut,
          config: armConfig[arm],
          embedder: shared,
          log,
          ...(options.allowUnverifiedCorpus ? { allowUnverifiedCorpus: true } : {}),
          onEmitted: (trends) => {
            emitted = trends;
          },
        });
        if (record.status !== "ok") {
          throw new Error(`${arm} run ${record.run_id} at ${cutoffAt} failed: ${record.error}`);
        }
        const dir = runDir(armOut, record);
        runs.push({
          arm,
          cutoff_at: cutoffAt,
          run_id: record.run_id,
          run_dir: dir,
          duration_ms: record.duration_ms,
        });
        const { dossiers } = readRun(dir);
        entry[arm] = {
          run_logical_hash: record.logical_hash,
          corpus_used_hash: record.corpus?.corpus_used_hash ?? null,
          ...scoreArm(dossiers, emitted, truth.stories, vectorOf, cutoffMs, threshold),
        };
        log(
          `backtest: ${cutoffAt.slice(0, 10)} ${arm} candidates=${entry[arm].candidates} ` +
            `p@5=${entry[arm].weighted.p_at_5} (${record.duration_ms} ms)`,
        );
      }
      perCutoff.push(entry);
    }
  } finally {
    await inner.dispose();
  }

  const cutoffRows = perCutoff.map((entry) => {
    const cutoffMs = Date.parse(entry.cutoff_at);
    const followup = Array.from({ length: LABEL_RULE.followup_days }, (_, k) =>
      dayOf(cutoffMs + k * DAY_MS),
    );
    const inCorpus = followup.filter((day) => day < truth.toDay);
    // Days of the window every truth source collected: what the label could observe.
    const followupDays = inCorpus.filter((day) =>
      truthSources.every((source) => truth.covered.has(`${source}/${day}`)),
    ).length;
    return {
      cutoff_at: entry.cutoff_at,
      followup_days_in_corpus: inCorpus.length,
      followup_days: followupDays,
      /** The whole follow-up window was observed: a negative label is final, not pending. */
      complete: followupDays >= LABEL_RULE.followup_days,
      paired: entry.baseline.candidates > 0 && entry.candidate.candidates > 0,
      baseline: entry.baseline,
      candidate: entry.candidate,
    };
  });
  type CutoffRow = (typeof cutoffRows)[number];
  const armTotal = (
    paired: ReadonlyArray<CutoffRow>,
    arm: Arm,
  ): ArmTotal & { items_7d_mean_p_at_5: number | null } => ({
    mean_p_at_5: mean(paired.map((row) => row[arm].weighted.p_at_5)),
    mean_p_at_10: mean(paired.map((row) => row[arm].weighted.p_at_10)),
    median_lead_days: median(paired.flatMap((row) => row[arm].lead_days)),
    median_lead_days_at_5: median(paired.flatMap((row) => row[arm].weighted.lead_days_at_5)),
    candidates: paired.reduce((sum, row) => sum + row[arm].candidates, 0),
    positives: paired.reduce((sum, row) => sum + row[arm].positives, 0),
    items_7d_mean_p_at_5: mean(paired.map((row) => row[arm].items_7d.p_at_5)),
  });
  const group = (complete: boolean): CutoffGroupTotal & { cutoff_dates: Array<string> } => {
    const paired = cutoffRows.filter((row) => row.paired && row.complete === complete);
    return {
      cutoffs: paired.length,
      cutoff_dates: paired.map((row) => row.cutoff_at.slice(0, 10)),
      baseline: armTotal(paired, "baseline"),
      candidate: armTotal(paired, "candidate"),
    };
  };
  const total = {
    cutoffs: cutoffRows.length,
    cutoffs_paired: cutoffRows.filter((row) => row.paired).length,
    complete: group(true),
    partial: group(false),
  };
  const { status, verdict } = decideBacktest(total.complete);

  const logical = {
    status,
    inputs: {
      engine_version: ENGINE_VERSION,
      corpus_manifest_hash: truth.manifestHash,
      truth_corpus_used_hash: truth.usedHash,
      profile_hash: profileHash,
      config: baseConfig,
      config_hash: configHash,
      arm_config_hashes: {
        baseline: sha256(canonicalJson(armConfig.baseline)),
        candidate: sha256(canonicalJson(armConfig.candidate)),
      },
      embedding: { ...shared.spec, config_hash: shared.key },
      baseline_sources: baselineSources,
      candidate_sources: candidateSources,
      truth_sources: truthSources,
      cutoffs,
    },
    rule: {
      ...LABEL_RULE,
      threshold,
      source: "early-window/scripts/backtest.ts (backtest.v0.02), original label",
      candidates: "dossiers emitted at the cutoff",
      weighted_order: "rankings.weighted.position",
      items_7d_order: "items_7d desc, trend id asc",
      precision:
        "P@k over min(k, candidates); mean over the paired cutoffs (both arms have candidates) of each group",
      lead: "lead_days = event day - cutoff day; median pooled over every positive candidate",
      complete: `a cutoff is complete when its truth sources cover all ${LABEL_RULE.followup_days} follow-up days`,
      verdict: `complete cutoffs only: not-worse when candidate mean P@5 >= baseline - ${P_AT_5_TOLERANCE} and candidate median lead_days >= baseline; worse with no complete cutoff`,
      status: `provisional with fewer than ${MIN_COMPLETE_CUTOFFS} complete cutoffs`,
    },
    cutoffs: cutoffRows,
    total,
    verdict,
  };
  const logicalHash = backtestLogicalHash(logical);
  const report = {
    schema_version: BACKTEST_SCHEMA_VERSION,
    backtest_id: backtestId(logicalHash),
    logical_hash: logicalHash,
    created_at: started.toISOString(),
    duration_ms: Math.round(performance.now() - t0),
    corpus_dir: NodePath.resolve(options.corpusDir),
    profile_path: NodePath.resolve(options.profilePath),
    out_dir: NodePath.resolve(options.outDir),
    runs,
    logical,
  };
  const path = NodePath.join(options.outDir, "backtest.json");
  const partial = `${path}.partial`;
  NodeFS.writeFileSync(partial, `${JSON.stringify(report, null, 2)}\n`);
  NodeFS.renameSync(partial, path);
  return { path, report, status, verdict, total };
}

function scoreArm(
  dossiers: ReadonlyArray<Dossier>,
  emitted: ReadonlyArray<EmittedTrend>,
  stories: ReadonlyArray<Story>,
  vectorOf: ReadonlyMap<string, Float32Array>,
  cutoffMs: number,
  threshold: number,
): Omit<ArmCutoff, "run_logical_hash" | "corpus_used_hash"> {
  const centroidOf = new Map(emitted.map((trend) => [trend.id, trend.centroid]));
  let centroidChecks = 0;
  const candidates = dossiers.map((dossier): Candidate => {
    const centroid = centroidOf.get(dossier.trend.id);
    if (!centroid) throw new Error(`run emitted no centroid for ${dossier.trend.id}`);
    // The frozen centroid must give back the similarities the run stored for its evidence.
    for (const evidence of dossier.evidence) {
      const vector = vectorOf.get(evidence.item_id);
      if (!vector || evidence.similarity === null) continue;
      if (Math.abs(dot(vector, centroid) - evidence.similarity) > 1e-5) {
        throw new Error(`centroid of ${dossier.trend.id} does not match its evidence`);
      }
      centroidChecks++;
    }
    return { id: dossier.trend.id, centroid };
  });
  const labels = labelCandidates(candidates, stories, cutoffMs, threshold);
  const byWeighted = dossiers.toSorted(
    (a, b) => a.rankings.weighted.position - b.rankings.weighted.position,
  );
  const byItems = dossiers.toSorted(
    (a, b) =>
      b.trend.items_7d - a.trend.items_7d ||
      (a.trend.id < b.trend.id ? -1 : a.trend.id > b.trend.id ? 1 : 0),
  );
  const labelOf = (dossier: Dossier) => labels.get(dossier.trend.id)!;
  const leads = byWeighted.flatMap((d) => {
    const lead = labelOf(d).lead_days;
    return lead === null ? [] : [lead];
  });
  return {
    candidates: dossiers.length,
    positives: leads.length,
    weighted: rankingMetrics(byWeighted.map(labelOf)),
    items_7d: rankingMetrics(byItems.map(labelOf)),
    lead_days: leads,
    median_lead_days: median(leads),
    centroid_checks: centroidChecks,
    rows: byWeighted.map((d) => ({
      trend_id: d.trend.id,
      label: d.trend.label,
      weighted_position: d.rankings.weighted.position,
      items_7d_position: byItems.indexOf(d) + 1,
      weighted_score: d.rankings.weighted.score,
      items_7d: d.trend.items_7d,
      sources: d.trend.sources,
      ...labelOf(d),
    })),
  };
}

export interface BacktestCheckResult {
  readonly backtest_id: string;
  readonly ok: boolean;
  readonly recorded: string;
  readonly recomputed: string;
  readonly problems: ReadonlyArray<string>;
  readonly rerun?: { readonly backtest_id: string; readonly logical_hash: string };
}

const decodeRerunInputs = Schema.decodeUnknownSync(BacktestRerunInputs);

/**
 * Recomputes the logical hash of a backtest.json; with `rerun`, runs it again from the inputs
 * it recorded and compares. A report of an older schema fails the check, and its rerun writes
 * the current schema: that is how an old report is regenerated.
 */
export async function checkBacktest(
  file: string,
  rerun?: {
    readonly outDir: string;
    readonly options?: Pick<
      BacktestOptions,
      "cacheFile" | "modelDir" | "workers" | "log" | "allowUnverifiedCorpus" | "embedder"
    >;
  },
): Promise<BacktestCheckResult> {
  const json: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const recorded = json as {
    schema_version?: unknown;
    backtest_id?: unknown;
    logical_hash?: unknown;
    logical?: unknown;
  };
  const current =
    recorded.schema_version === BACKTEST_SCHEMA_VERSION ? checkBacktestReport(json) : null;
  const result = current
    ? {
        backtest_id: current.backtest_id,
        ok: current.ok,
        recorded: current.recorded,
        recomputed: current.recomputed,
        problems: current.problems,
      }
    : {
        backtest_id: String(recorded.backtest_id),
        ok: false,
        recorded: String(recorded.logical_hash),
        recomputed: backtestLogicalHash(recorded.logical),
        problems: [
          `schema ${String(recorded.schema_version)} is not ${BACKTEST_SCHEMA_VERSION}; --rerun writes the current one`,
        ],
      };
  if (!rerun) return result;
  const { corpus_dir, profile_path, logical } = decodeRerunInputs(json);
  const again = await runBacktest({
    ...rerun.options,
    corpusDir: corpus_dir,
    profilePath: profile_path,
    outDir: rerun.outDir,
    cutoffs: logical.inputs.cutoffs,
    baselineSources: logical.inputs.baseline_sources,
    candidateSources: logical.inputs.candidate_sources,
    truthSources: logical.inputs.truth_sources,
    config: logical.inputs.config as EngineConfig,
  });
  const same = again.report.logical_hash === result.recorded;
  return {
    ...result,
    ok: result.ok && same,
    problems: same ? result.problems : [...result.problems, "rerun gives another logical_hash"],
    rerun: { backtest_id: again.report.backtest_id, logical_hash: again.report.logical_hash },
  };
}
