// @effect-diagnostics nodeBuiltinImport:off - tests write temporary corpora and model files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { readRun } from "./check.ts";
import { dot, normalized } from "./cluster.ts";
import { daysBefore } from "./days.ts";
import { fingerprintEmbedder } from "./embed/fingerprint.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { dedupe } from "./rank.ts";
import {
  aggregateRelevance,
  checkEmbedding,
  distinctTitles,
  loadRelevance,
  parseRelevanceModel,
  RELEVANCE_SCHEMA_VERSION,
  relevanceOf,
} from "./relevance.ts";
import { CONFIG_DIR, DEFAULT_CONFIG_PATH, loadConfig, priorTopDays, runEngine } from "./run.ts";
import { classify, type CoverageIndex, type SeriesItem } from "./series.ts";
import {
  CUTOFF,
  tempDir,
  testConfig,
  writeProfile,
  writeSyntheticCorpus,
} from "./testkit/syntheticCorpus.ts";

const V2_PATH = NodePath.join(CONFIG_DIR, "engine.v2.json");

/** A probe that scores texts with `word` high: the word's fingerprint direction. */
async function wordProbe(word: string, embedder: EngineConfig["embedder"]) {
  const [direction] = await fingerprintEmbedder().embed([word]);
  const model = {
    schema_version: RELEVANCE_SCHEMA_VERSION,
    model_id: "relevance.test",
    method: "test",
    embedding: {
      model: embedder.model,
      revision: embedder.revision,
      dtype: embedder.dtype,
      pooling: embedder.pooling,
    },
    weights: [...direction!].map((w) => w * 12),
    bias: -3,
    threshold: 0.5,
    training: {},
    cv: {},
  };
  return parseRelevanceModel(new TextEncoder().encode(JSON.stringify(model)));
}

function v2TestConfig(
  sha: string,
  emit: Partial<EngineConfig["emit"]> = {},
  relevance: Partial<NonNullable<EngineConfig["relevance"]>> = {},
): EngineConfig {
  const base = testConfig();
  return {
    ...base,
    stage: { ...base.stage, coverage_rule: "equivalent" },
    relevance: {
      model: "relevance.test.json",
      sha256: sha,
      item_min: 0.5,
      signal_min: 0.5,
      profile_gate: false,
      ...relevance,
    },
    rank: {
      baseline: base.rank.baseline,
      weighted: {
        method: "weighted_sum.v0.02",
        weights: { growth: 0.25, relevance: 1, log_items_7d: 0.15 },
      },
    },
    emit: { ...base.emit, dedup_cosine: 0.8, ...emit },
  };
}

async function setup() {
  const root = tempDir("trend-relevance");
  const corpusDir = NodePath.join(root, "corpus");
  await writeSyntheticCorpus(corpusDir);
  return { root, corpusDir, profilePath: writeProfile(root), outDir: NodePath.join(root, "runs") };
}

describe("engine v1 reproducibility", () => {
  it("keeps the logical hash the base commit e1f2043779 produced on the synthetic corpus", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    const record = await runEngine({
      corpusDir,
      cutoff: CUTOFF,
      profilePath,
      outDir,
      config: testConfig(),
      embedder: fingerprintEmbedder(),
    });
    expect(record.status).toBe("ok");
    expect(record.logical_hash).toBe(V1_SYNTHETIC_LOGICAL_HASH);
  });

  it("keeps the shipped v1 configuration hash", () => {
    expect(loadConfig(DEFAULT_CONFIG_PATH).hash).toBe(V1_CONFIG_HASH);
  });
});

describe("relevance model", () => {
  it("scores the same vector the same way and refuses a model that does not match", async () => {
    const { config } = loadConfig(DEFAULT_CONFIG_PATH);
    const probe = await wordProbe("rust", config.embedder);
    const [rust, garden] = await fingerprintEmbedder().embed(["rust agents", "tomato garden"]);
    expect(relevanceOf(probe, rust!)).toBe(relevanceOf(probe, rust!));
    expect(relevanceOf(probe, rust!)).toBeGreaterThan(0.5);
    expect(relevanceOf(probe, garden!)).toBeLessThan(0.5);
    expect(() => relevanceOf(probe, new Float32Array(3))).toThrow(/dimensions/);
    expect(() => checkEmbedding(probe, { ...config.embedder, revision: "other" })).toThrow(
      /another embedder/,
    );

    const dir = tempDir("relevance-model");
    const bytes = NodeFS.readFileSync(NodePath.join(CONFIG_DIR, "relevance.v2.json"));
    NodeFS.writeFileSync(NodePath.join(dir, "m.json"), bytes);
    const ref = {
      model: "m.json",
      sha256: sha256(bytes),
      item_min: 0.5,
      signal_min: 0.5,
      profile_gate: false,
    };
    expect(loadRelevance(ref, config.embedder, dir).weights.length).toBe(1024);
    expect(() => loadRelevance({ ...ref, sha256: "sha256:0" }, config.embedder, dir)).toThrow(
      /does not match/,
    );
    expect(() => loadRelevance({ ...ref, model: "../m.json" }, config.embedder, dir)).toThrow(
      /file name/,
    );
  });

  it("ships engine.v2.json pointing at relevance.v2.json by its hash", () => {
    const { config } = loadConfig(V2_PATH);
    expect(config.relevance).toBeDefined();
    const loaded = loadRelevance(config.relevance!, config.embedder, CONFIG_DIR);
    expect(loaded.hash).toBe(config.relevance!.sha256);
    expect(config.rank.weighted.method).toBe("weighted_sum.v0.02");
    expect(Object.keys(config.rank.weighted.weights)).not.toContain("log_authors_7d");
    expect(config.emit.min_dossiers).toBeGreaterThanOrEqual(5);
    expect(config.relevance!.novelty).toBeDefined();
    expect(config.relevance!.min_relevant_distinct).toBeGreaterThanOrEqual(1);
    expect(canonicalJson(config)).not.toBe(canonicalJson(loadConfig(DEFAULT_CONFIG_PATH).config));
  });
});

describe("trend relevance", () => {
  it("aggregates by mean, share above the item bar or trimmed mean", () => {
    const values = [0.9, 0.8, 0.1, 0.1, 0.1];
    expect(aggregateRelevance(values, "mean", 0.5)).toBeCloseTo(0.4, 12);
    expect(aggregateRelevance(values, "share", 0.5)).toBe(0.4);
    // One fifth dropped at each end: 0.1 and 0.9.
    expect(aggregateRelevance(values, "trimmed_mean", 0.5)).toBeCloseTo(1 / 3, 12);
    expect(aggregateRelevance([], "share", 0.5)).toBe(0);
  });

  it("counts versions of a package and reposts once", () => {
    expect(distinctTitles(["pkg 1.2.3", "PKG 1.2.4", "Claude Code tips", "claude code tips"])).toBe(
      2,
    );
  });

  it("finds the previous cuts where a trend was in the top", () => {
    const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
    const signals = [
      { id: "a", members: [{ day: day(5) }, { day: day(8) }] },
      { id: "b", members: [{ day: day(8) }] },
    ];
    const top = priorTopDays(
      signals,
      day(10),
      { lookback_days: 3, top: 1 },
      {
        // a leads until the 9th; b overtakes from then on.
        eligibleAt: (s, d) => (s.id === "a" ? 1 : d >= day(9) ? 2 : 0),
      },
    );
    expect(top.get("a")).toEqual([day(7), day(8)]);
    expect(top.get("b")).toEqual([day(9)]);
  });
});

describe("dedupe", () => {
  const v = (...xs: Array<number>) => normalized(Float32Array.from(xs));
  it("folds a near-identical entry into the better-ranked one it is closest to", () => {
    const entries = [
      { id: "a", v: v(1, 0, 0) },
      { id: "b", v: v(0, 1, 0) },
      { id: "a2", v: v(1, 0.1, 0) },
      { id: "c", v: v(0.7, 0.7, 0.1) },
    ];
    const near = (a: { v: Float32Array }, b: { v: Float32Array }) => dot(a.v, b.v) > 0.8;
    const { kept, related } = dedupe(entries, [], (e) => e.v, near);
    expect(kept.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(related.map(([primary, link]) => [primary, link.signal.id])).toEqual([["a", "a2"]]);
    expect(
      dedupe(
        entries,
        [],
        (e) => e.v,
        () => false,
      ).kept.length,
    ).toBe(4);
  });
});

describe("equivalent coverage", () => {
  const CUTOFF_DAY = "2026-10-15";
  const DAYS = daysBefore(CUTOFF_DAY, 14);
  const STAGE = {
    context_days: 14,
    growth_min: 0.69,
    growing_min_items_7d: 3,
    fading_max: -0.69,
    coverage_rule: "equivalent" as const,
  };
  const hnDaily = DAYS.map((day, d) => ({
    id: `hn-${d}`,
    source: "hn" as const,
    day,
    author: `a${d}`,
    entities: [],
  }));

  it("adds no growth for a source that starts collecting inside the last window", () => {
    // HN steady at one item a day; RSS starts on day 10 of 14 with three items a day.
    const startsAt = DAYS[10]!;
    const rss: Array<SeriesItem> = DAYS.filter((day) => day >= startsAt).flatMap((day) =>
      [0, 1, 2].map((k) => ({
        id: `rss-${day}-${k}`,
        source: "rss" as const,
        day,
        author: null,
        entities: [],
      })),
    );
    const coverage: CoverageIndex = new Map([
      ["hn", new Map(DAYS.map((day) => [day, "complete" as const]))],
      [
        "rss",
        new Map(DAYS.filter((day) => day >= startsAt).map((day) => [day, "complete" as const])),
      ],
    ]);
    const items = [...hnDaily, ...rss];
    const equivalent = classify(items, CUTOFF_DAY, coverage, ["hn", "rss"], STAGE);
    expect(equivalent.growth).toBe(0);
    expect(equivalent.stage).toBe("steady");
    expect(equivalent.growth_sources?.find((s) => s.source === "rss")?.comparable).toBe(false);
    // The v1 rule reads the same capture as growth.
    const perSource = classify(items, CUTOFF_DAY, coverage, ["hn", "rss"], {
      ...STAGE,
      coverage_rule: "per_source",
    });
    expect(perSource.stage).toBe("growing");
  });

  it("compares rates when the earlier window was collected on fewer days", () => {
    // HN collected only 2 of the 7 earlier days, one item a day throughout: no growth.
    const missing = new Set(DAYS.slice(0, 5));
    const coverage: CoverageIndex = new Map([
      [
        "hn",
        new Map(DAYS.filter((day) => !missing.has(day)).map((day) => [day, "complete" as const])),
      ],
    ]);
    const items = hnDaily.filter((item) => !missing.has(item.day));
    const result = classify(items, CUTOFF_DAY, coverage, ["hn"], STAGE);
    expect(result.growth).toBeCloseTo(0, 12);
    expect(result.growth_sources).toEqual([
      {
        source: "hn",
        days_7d: 7,
        days_prev_7d: 2,
        items_7d: 7,
        items_prev_7d: 2,
        comparable: true,
      },
    ]);
    // Partial days of a census source do not count as collected.
    const partial: CoverageIndex = new Map([
      [
        "hn",
        new Map(
          DAYS.map((day) => [day, missing.has(day) ? ("partial" as const) : ("complete" as const)]),
        ),
      ],
    ]);
    expect(classify(hnDaily, CUTOFF_DAY, partial, ["hn"], STAGE).growth).toBeCloseTo(0, 12);
  });
});

describe("engine v2 on the synthetic corpus", () => {
  it("scores relevance, explains it and reproduces its hash", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    const { config: base } = loadConfig(DEFAULT_CONFIG_PATH);
    const probe = await wordProbe("compiler", base.embedder);
    const run = () =>
      runEngine({
        corpusDir,
        cutoff: CUTOFF,
        profilePath,
        outDir,
        config: v2TestConfig(probe.hash),
        relevanceModel: probe,
        embedder: fingerprintEmbedder(),
      });
    const first = await run();
    const second = await run();
    expect(first.status).toBe("ok");
    expect(first.logical_hash).toBe(second.logical_hash);
    const { dossiers } = readRun(NodePath.join(outDir, first.run_id));
    const growing = dossiers.find((d) => d.trend.top_terms.includes("compiler"))!;
    expect(growing.relevance?.score).toBeGreaterThan(0.5);
    expect(growing.relevance?.eligibility).toBe("relevant");
    expect(growing.related).toEqual([]);
    expect(growing.rankings.weighted.components.map((c) => c.name)).toEqual([
      "growth",
      "relevance",
      "log_items_7d",
    ]);
    expect(growing.rankings.weighted.components[1]!.value).toBe(growing.relevance!.score);
    expect(growing.evidence.every((e) => typeof e.relevance === "number")).toBe(true);
    // Every dossier passed the relevance bar: the off-topic signals are not growing anyway.
    expect(dossiers.every((d) => d.relevance!.score >= 0.5)).toBe(true);
  });

  it("fills the cut up to min_dossiers with the most relevant trends, ranked last", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    const { config: base } = loadConfig(DEFAULT_CONFIG_PATH);
    const probe = await wordProbe("compiler", base.embedder);
    const record = await runEngine({
      corpusDir,
      cutoff: CUTOFF,
      profilePath,
      outDir,
      // Every item counts, so the steady off-topic signals have the recent items a fill needs.
      config: v2TestConfig(probe.hash, { min_dossiers: 3 }, { item_min: 0 }),
      relevanceModel: probe,
      embedder: fingerprintEmbedder(),
    });
    expect(record.status).toBe("ok");
    const { dossiers } = readRun(NodePath.join(outDir, record.run_id));
    expect(dossiers.length).toBe(3);
    const filled = dossiers.filter((d) => d.relevance?.eligibility === "backfill");
    expect(filled.length).toBe(2);
    const firstRelevant = dossiers.find((d) => d.relevance?.eligibility === "relevant")!;
    expect(firstRelevant.rankings.weighted.position).toBe(1);
    expect(filled.every((d) => d.rankings.weighted.position > 1)).toBe(true);
  });

  it("keeps a recurrent trend out of the positions unless it grew since its last top cut", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    const { config: base } = loadConfig(DEFAULT_CONFIG_PATH);
    const probe = await wordProbe("compiler", base.embedder);
    const run = (growth_ratio: number) =>
      runEngine({
        corpusDir,
        cutoff: CUTOFF,
        profilePath,
        outDir,
        config: v2TestConfig(
          probe.hash,
          {},
          {
            aggregate: "share",
            min_relevant_distinct: 1,
            novelty: { lookback_days: 7, top: 5, growth_ratio },
          },
        ),
        relevanceModel: probe,
        embedder: fingerprintEmbedder(),
      });
    // The compiler topic leads every earlier cut at a steady three items a day.
    const strict = await run(1.5);
    expect(strict.status).toBe("ok");
    expect(strict.dossiers).toBe(0);
    expect((strict.stats!["signals"] as { recurrent: number }).recurrent).toBeGreaterThan(0);
    const lenient = await run(0);
    expect(lenient.dossiers).toBeGreaterThan(0);
    const dossier = readRun(NodePath.join(outDir, lenient.run_id)).dossiers.find((d) =>
      d.trend.top_terms.includes("compiler"),
    );
    expect(dossier?.relevance?.novelty?.grew).toBe(true);
    expect(dossier?.relevance?.novelty?.prior_top_days.length).toBeGreaterThan(0);
    expect(dossier?.relevance?.aggregate).toBe("share");
    expect(dossier?.relevance?.relevant_distinct_7d).toBeGreaterThanOrEqual(1);
  });

  it("refuses a relevance model whose hash the configuration does not record", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    const { config: base } = loadConfig(DEFAULT_CONFIG_PATH);
    const probe = await wordProbe("compiler", base.embedder);
    const record = await runEngine({
      corpusDir,
      cutoff: CUTOFF,
      profilePath,
      outDir,
      config: v2TestConfig("sha256:other"),
      relevanceModel: probe,
      embedder: fingerprintEmbedder(),
    });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/does not match its sha256/);
  });
});

// Recorded on e1f2043779 (before relevance existed) with the same synthetic corpus,
// fingerprint embedder and testConfig().
const V1_SYNTHETIC_LOGICAL_HASH =
  "sha256:341c652753ebeaeca2ce05681b69b9fd3fbd1c71581ef74b011ac7091fc58dd1";
const V1_CONFIG_HASH = "sha256:290b9ddeec9bf5bc4e0512972d047c106623a3d050789fe0a8c145504d2e9095";
