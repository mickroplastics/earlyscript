// @effect-diagnostics nodeBuiltinImport:off - tests write temporary corpora.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DossierV2 } from "@earlyscript/editorial-contracts/dossier";
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { CoverageStatus, SourceId } from "@earlyscript/editorial-contracts/source";

import { cohortAt, ROW_UNKNOWN_DAYS } from "./comparable.ts";
import { readRun } from "./check.ts";
import { DAY_MS, dayStart, daysBefore, daysBetween } from "./days.ts";
import { fingerprintEmbedder } from "./embed/fingerprint.ts";
import type { Embedder } from "./embed/spec.ts";
import { CutAnalysis, matchedTerms, selectParamsOf, selectV3 } from "./engine-v3.ts";
import { ARMS, runLists } from "./lists-v3.ts";
import { parseRelevanceModel, RELEVANCE_SCHEMA_VERSION } from "./relevance.ts";
import { CONFIG_DIR, DEFAULT_CONFIG_PATH, loadConfig, runEngine } from "./run.ts";
import { loadShared, prepareV3Cut } from "./run-v3.ts";
import { canonicalUrl, type CoverageIndex, type UnitItem, weeklySeries } from "./series.ts";
import { createStackReplay } from "./stack-replay.ts";
import {
  item,
  PROFILE,
  tempDir,
  testConfig,
  writeSyntheticCorpus,
} from "./testkit/syntheticCorpus.ts";
import { movementOf, percentile, perennialRule } from "./trajectory.ts";

const decodeDossierV2 = Schema.decodeUnknownSync(DossierV2);
const V3 = loadConfig(NodePath.join(CONFIG_DIR, "engine.v3.json")).config;
const TRAJ = V3.trajectory!;
const CMP = V3.comparable!;
const CUT_DAY = "2026-10-10";
const CUT_MS = dayStart(CUT_DAY);
const H = 3_600_000;

/** Coverage with every day of every source `complete`, then the overrides. */
function coverageOf(
  sources: ReadonlyArray<SourceId>,
  from: string,
  to: string,
  overrides: Record<string, CoverageStatus | null> = {},
): CoverageIndex {
  const index: CoverageIndex = new Map();
  for (const source of sources) {
    const days = new Map<string, CoverageStatus>();
    for (const day of daysBetween(from, to)) {
      const o = overrides[`${source}/${day}`];
      if (o === null) continue;
      days.set(day, o ?? "complete");
    }
    index.set(source, days);
  }
  return index;
}

const unit = (
  id: string,
  source: SourceId,
  ms: number,
  key = `id:${id}`,
  author: string | null = id,
): UnitItem => ({
  id,
  source,
  ms,
  author,
  key,
});

describe("comparable sources and gaps (§2.2, §2.5)", () => {
  const all: Array<SourceId> = ["hn", "github", "rss", "wikipedia"];
  const clustered: Array<SourceId> = ["hn", "github", "rss"];

  it("keeps a source with one unavailable day per week and marks a week with two as unknown", () => {
    const w0 = daysBefore(CUT_DAY, 7);
    const w1 = daysBefore(daysBefore(CUT_DAY, 7)[0]!, 7);
    const cov = coverageOf(all, "2026-08-01", CUT_DAY, {
      [`hn/${w0[2]}`]: "unavailable",
      [`github/${w1[1]}`]: "unavailable",
      [`github/${w1[4]}`]: "unavailable",
    });
    const cohort = cohortAt(cov, all, clustered, CUT_DAY, "2026-08-01", CMP);
    expect(cohort.comparable).toEqual(["hn", "github", "rss"]);
    expect(cohort.rows.find((r) => r.source === "hn")!.unknown_weeks).toEqual([]);
    expect(cohort.rows.find((r) => r.source === "github")!.unknown_weeks).toEqual([1]);
    expect(cohort.rows.find((r) => r.source === "wikipedia")!.status).toBe("no_usada");
    expect(ROW_UNKNOWN_DAYS).toBe(2);
  });

  it("drops a source with more than 3 unavailable days or a missing day; a late starter is parcial", () => {
    const days = daysBefore(CUT_DAY, 35);
    const cov = coverageOf(all, "2026-08-01", CUT_DAY, {
      ...Object.fromEntries([0, 8, 16, 24].map((k) => [`hn/${days[k]}`, "unavailable" as const])),
      [`github/${days[10]}`]: null,
      ...Object.fromEntries(daysBetween("2026-08-01", "2026-09-20").map((d) => [`rss/${d}`, null])),
    });
    const cohort = cohortAt(cov, all, clustered, CUT_DAY, "2026-08-01", CMP);
    expect(cohort.rows.map((r) => [r.source, r.status])).toEqual([
      ["hn", "no_comparable"],
      ["github", "no_comparable"],
      ["rss", "parcial"],
      ["wikipedia", "no_usada"],
    ]);
    expect(cohort.comparable).toEqual([]);
  });

  it("finds hn, github, huggingface and npm comparable on the 21 development cutoffs of the real coverage", () => {
    const cov: CoverageIndex = new Map();
    const lines = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "testkit/coverage-eval-largo-to-2026-10-31.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { source: SourceId; day: string; status: CoverageStatus });
    expect(lines.every((r) => r.day <= "2026-10-31")).toBe(true);
    for (const row of lines) {
      if (!cov.has(row.source)) cov.set(row.source, new Map());
      cov.get(row.source)!.set(row.day, row.status);
    }
    for (const day of daysBetween("2026-10-04", "2026-10-25")) {
      const before: CoverageIndex = new Map(
        [...cov].map(([s, m]) => [s, new Map([...m].filter(([d]) => d < day))]),
      );
      const cohort = cohortAt(before, V3.sources, V3.sources_cluster!, day, "2026-08-30", CMP);
      expect(cohort.comparable, day).toEqual(["hn", "github", "huggingface", "npm"]);
      expect(cohort.rows.find((r) => r.source === "rss")!.status, day).toBe("parcial");
      expect(cohort.rows.find((r) => r.source === "wikipedia")!.status, day).toBe("no_usada");
      expect(cohort.unknown.size, day).toBe(0);
      expect(cohort.historyFrom, day).toBe(daysBefore(day, 35)[0]);
    }
  });
});

describe("weekly series (§2.5)", () => {
  const cohort = {
    cutoffMs: CUT_MS,
    historyFromMs: CUT_MS - 35 * DAY_MS,
    comparable: ["hn", "github"] as Array<SourceId>,
    unknown: new Set<string>(),
    incompleteShare: 0.3,
  };

  it("counts a URL once across sources, notes both sources and refuses items at the cutoff", () => {
    const url = canonicalUrl("https://github.com/acme/tool")!;
    const items = [
      unit("a", "hn", CUT_MS - 2 * H, url),
      unit("b", "github", CUT_MS - 1 * H, url),
      unit("c", "hn", CUT_MS - 8 * DAY_MS),
      unit("d", "rss", CUT_MS - 3 * H),
    ];
    const s = weeklySeries(items, cohort, 7);
    expect(s.weeks).toEqual([1, 1, 0, 0, 0]);
    expect(s.sourcesW0).toEqual(["github", "hn"]);
    expect(s.bySource.get("github")!.weeks).toEqual([1, 0, 0, 0, 0]);
    expect(s.bySource.get("rss")!.weeks).toEqual([1, 0, 0, 0, 0]);
    expect(s.life).toBe(2);
    expect(s.pop).toBeCloseTo(2 ** (-2 / 24 / 7) + 2 ** (-8 / 7), 12);
    expect(() => weeklySeries([unit("z", "hn", CUT_MS)], cohort, 7)).toThrow(
      /not before the cutoff/,
    );
  });

  it("leaves the items of a '?' week out of n(W) and marks the topic incomplete at 30 %", () => {
    const unknown = { ...cohort, unknown: new Set(["github|1"]) };
    const items = [
      ...[1, 2, 3].map((k) => unit(`h${k}`, "hn", CUT_MS - k * H)),
      ...[1, 2].map((k) => unit(`g${k}`, "github", CUT_MS - 8 * DAY_MS - k * H)),
      unit("h9", "hn", CUT_MS - 9 * DAY_MS),
    ];
    const s = weeklySeries(items, unknown, 7);
    expect(s.weeks).toEqual([3, 1, 0, 0, 0]);
    expect(s.bySource.get("github")!.weeks[1]).toBeNull();
    expect(s.unknownShare).toBeCloseTo(2 / 6, 12);
    expect(s.incomplete).toBe(true);
    expect(weeklySeries(items.slice(0, 5), unknown, 7).incomplete).toBe(true);
    expect(weeklySeries(items.slice(0, 4), unknown, 7).incomplete).toBe(false);
    expect(
      weeklySeries(
        [...items, ...[4, 5, 6].map((k) => unit(`x${k}`, "hn", CUT_MS - k * H))],
        unknown,
        7,
      ).incomplete,
    ).toBe(false);
  });

  it("normalizes the URL two sources share", () => {
    expect(canonicalUrl("http://www.Example.com/a/?utm_source=x&b=2#top")).toBe(
      "https://example.com/a?b=2",
    );
    expect(canonicalUrl("https://example.com/a/")).toBe(canonicalUrl("https://example.com/a"));
    expect(canonicalUrl(null)).toBeNull();
    expect(canonicalUrl("mailto:x@y")).toBeNull();
  });
});

describe("movement and perennial antecedent (§2.7)", () => {
  const at = (weeks: Array<number>, extra: Partial<Parameters<typeof movementOf>[0]> = {}) =>
    movementOf(
      { weeks, firstMs: CUT_MS - 30 * DAY_MS, cutoffMs: CUT_MS, pop: 5, p50: 2, p90: 4, ...extra },
      TRAJ,
    );

  it("applies each movement in the contract's order", () => {
    expect(at([2, 6, 1, 0, 0])).toBe("en_caida");
    expect(at([1, 4, 6, 0, 0])).toBe("en_caida");
    expect(at([2, 4, 6, 0, 0])).toBe("estable");
    expect(at([4, 3, 6, 0, 0])).toBe("rebote");
    expect(at([3, 2, 4, 0, 0])).toBe("senal_debil");
    expect(at([3, 2, 4, 0, 0], { pop: 1 })).toBe("estable");
    expect(at([3, 0, 0, 0, 0], { firstMs: CUT_MS - 6 * DAY_MS })).toBe("nueva");
    expect(at([2, 0, 0, 0, 0], { firstMs: CUT_MS - 6 * DAY_MS })).toBe("estable");
    expect(at([9, 9, 1, 0, 0])).toBe("senal_fuerte");
    expect(at([9, 9, 1, 0, 0], { pop: 3.9 })).toBe("estable");
    expect(at([3, 2, 1, 0, 0], { pop: 2 })).toBe("senal_debil");
    expect(at([4, 0, 1, 0, 0], { pop: 2 })).toBe("senal_debil");
    expect(at([4, 3, 1, 0, 0], { pop: 2 })).toBe("estable");
    expect(at([3, 2, 1, 0, 0], { pop: 1.9 })).toBe("estable");
    expect(at([3, 2, 1, 0, 0], { p50: null, p90: null })).toBe("estable");
  });

  it("marks the perennial antecedent by heavy weeks or by life", () => {
    expect(perennialRule([5, 5, 5, 0, 0], 15, TRAJ)).toBe("heavy_weeks");
    expect(perennialRule([5, 0, 5, 0, 5], 15, TRAJ)).toBe("heavy_weeks");
    expect(perennialRule([20, 5, 0, 0, 0], 30, TRAJ)).toBeNull();
    expect(perennialRule([20, 0, 5, 0, 0], 30, TRAJ)).toBe("life");
    expect(perennialRule([20, 0, 5, 0, 0], 29, TRAJ)).toBeNull();
  });

  it("uses the type 7 percentile", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBeCloseTo(9.1, 12);
    expect(percentile([], 50)).toBeNull();
  });

  it("finds the keyword list's terms as P1.3 matched them", () => {
    expect(
      matchedTerms(["agent", "fine-tuning", "LLM"], "Fine tuning an LLM agentic thing"),
    ).toEqual(["fine-tuning", "LLM"]);
  });
});

// Synthetic corpus for the pipeline: 40 days, hn and github comparable, rss late, Wikipedia read.
const FROM = "2026-08-31";
const TO = "2026-10-12";
const CUTOFF = `${CUT_DAY}T00:00:00.000Z`;

function v3Items(): Array<Item> {
  const items: Array<Item> = [];
  daysBetween(FROM, TO).forEach((day, d) => {
    const future = day >= CUT_DAY;
    const word = future ? " futuretoken" : "";
    // A new topic: only in the last 5 days before the cutoff, on hn and github.
    if (day >= "2026-10-05") {
      for (let k = 0; k < 2; k++)
        items.push(
          item("hn", day, 1 + k, `Zephyr agent harness ships sandbox runner${word}`, `z${d}${k}`),
        );
      items.push({
        ...item("github", day, 3, `zephyr agent harness sandbox runner${word}`, "zephyrorg"),
        external_url: `https://github.com/zephyr/harness${d}`,
      });
    }
    // A perennial topic, every day.
    items.push(item("hn", day, 10, `Tomato garden soil watering tips${word}`, `g${d % 5}`));
    items.push(item("hn", day, 11, `Tomato garden compost watering schedule${word}`, `g${d % 7}`));
    // An excluded topic.
    if (d % 2 === 0)
      items.push(item("hn", day, 12, `Football league scores weekend results${word}`, `f${d % 3}`));
    items.push({
      ...item("wikipedia", day, 13, `Zephyr agent harness wiki page${word}`, "wiki"),
      body: "Fixed body",
    });
    if (day >= "2026-10-03")
      items.push(item("rss", day, 14, `Zephyr agent harness newsletter${word}`, "news"));
  });
  return items.toSorted(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
  );
}

async function probeFor(word: string, embedder: EngineConfig["embedder"]) {
  const [direction] = await fingerprintEmbedder().embed([word]);
  return parseRelevanceModel(
    new TextEncoder().encode(
      JSON.stringify({
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
      }),
    ),
  );
}

async function v3Setup() {
  const root = tempDir("engine-v3");
  const corpusDir = NodePath.join(root, "corpus");
  const items = v3Items();
  await writeSyntheticCorpus(corpusDir, {
    items,
    fromDay: FROM,
    toDay: TO,
    extraSources: ["wikipedia", "rss"],
    coverage: (row) => (row.source === "rss" && row.day < "2026-10-03" ? null : row),
  });
  const profilePath = NodePath.join(root, "profile.json");
  NodeFS.writeFileSync(profilePath, JSON.stringify(PROFILE));
  const probe = await probeFor("agent", V3.embedder);
  const { path: _p, sha256: _s, ...profile } = V3.profile;
  const config: EngineConfig = {
    ...V3,
    sources: ["hn", "github", "wikipedia", "rss"],
    sources_cluster: ["hn", "github", "rss"],
    profile: { ...profile, include_min: 0.3 },
    relevance: { ...V3.relevance!, model: "relevance.test.json", sha256: probe.hash },
  };
  return { root, corpusDir, profilePath, probe, config, items };
}

function recording(seen: Array<string>): Embedder {
  const inner = fingerprintEmbedder();
  return { ...inner, embed: async (texts) => (seen.push(...texts), inner.embed(texts)) };
}

describe("engine.v3 run", () => {
  it("emits dossier/2 deterministically, never embeds Wikipedia and never reads past the cutoff", async () => {
    const { corpusDir, profilePath, probe, config, root } = await v3Setup();
    const seen: Array<string> = [];
    const run = (embedder: Embedder) =>
      runEngine({
        corpusDir,
        cutoff: CUTOFF,
        profilePath,
        outDir: NodePath.join(root, "runs"),
        config,
        relevanceModel: probe,
        embedder,
      });
    const first = await run(recording(seen));
    const second = await run(fingerprintEmbedder());
    expect(first.status, first.error ?? "").toBe("ok");
    expect(first.logical_hash).toBe(second.logical_hash);
    expect((first.stats as { topics_hash: string }).topics_hash).toBe(
      (second.stats as { topics_hash: string }).topics_hash,
    );
    expect(seen.some((t) => t.includes("wiki page") || t.includes("futuretoken"))).toBe(false);
    const runDir = NodePath.join(root, "runs", first.run_id);
    const record = JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, "run.json"), "utf8")) as {
      files: Array<string>;
      stats: { items: { not_clustered: Record<string, number> } };
    };
    expect(record.stats.items.not_clustered["wikipedia"]).toBeGreaterThan(0);
    const dossiers = record.files.map((f) =>
      decodeDossierV2(JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, f), "utf8"))),
    );
    const text = JSON.stringify(dossiers);
    expect(text).not.toContain("futuretoken");
    const zephyr = dossiers.find((d) => d.trend.top_terms.includes("zephyr"))!;
    expect(zephyr.movement.section).toBe("moving");
    expect(zephyr.movement.movement).toBe("nueva");
    expect(zephyr.movement.sources_w0).toEqual(["github", "hn"]);
    expect(zephyr.movement.by_source.map((r) => [r.source, r.status])).toEqual([
      ["hn", "comparable"],
      ["github", "comparable"],
      ["wikipedia", "no_usada"],
      ["rss", "parcial"],
    ]);
    expect(zephyr.movement.first_source?.source).toBe("hn");
    expect(zephyr.movement.fit.matched_terms).toContain("agent");
    const garden = dossiers.find((d) => d.trend.top_terms.includes("tomato"));
    if (garden) expect(garden.movement.section).toBe("background");
    expect(dossiers.some((d) => d.trend.top_terms.includes("football"))).toBe(false);
    for (const d of dossiers)
      for (const e of d.evidence)
        expect(Date.parse(e.published_at)).toBeLessThan(Date.parse(CUTOFF));
  });

  it("refuses a profile whose sha256 differs from the configuration's", async () => {
    const { corpusDir, profilePath, probe, config, root } = await v3Setup();
    const record = await runEngine({
      corpusDir,
      cutoff: CUTOFF,
      profilePath,
      outDir: NodePath.join(root, "runs"),
      config: { ...config, profile: { ...config.profile, sha256: "sha256:0" } },
      relevanceModel: probe,
      embedder: fingerprintEmbedder(),
    }).catch((error: Error) => error);
    expect(String(record instanceof Error ? record.message : record.error)).toMatch(
      /expects sha256:0/,
    );
  });

  it("puts no item at or after the cutoff in any series and computes the same cut from a replay", async () => {
    const { corpusDir, probe, config } = await v3Setup();
    const shared = await loadShared({
      config,
      profile: PROFILE,
      embedder: fingerprintEmbedder(),
      relevanceModel: probe,
      stack: createStackReplay(),
    });
    // A replay over two ascending cutoffs and a fresh stacking of the later one agree.
    await prepareV3Cut({ corpusDir, cutoff: "2026-10-08T00:00:00.000Z", config }, shared);
    const replayed = await prepareV3Cut({ corpusDir, cutoff: CUTOFF, config }, shared);
    const fresh = await prepareV3Cut(
      { corpusDir, cutoff: CUTOFF, config },
      { ...shared, stack: createStackReplay() },
    );
    const a = new CutAnalysis(replayed.input);
    const b = new CutAnalysis(fresh.input);
    expect(a.topics.map((t) => [t.id, t.movement, t.series.weeks])).toEqual(
      b.topics.map((t) => [t.id, t.movement, t.series.weeks]),
    );
    for (const t of a.topics) for (const u of t.units) expect(u.ms).toBeLessThan(dayStart(CUT_DAY));
    const future = {
      ...replayed.input,
      clustered: [
        ...replayed.input.clustered,
        { ...replayed.input.clustered[0]!, id: "x", publishedMs: dayStart(CUT_DAY) },
      ],
    };
    expect(() => new CutAnalysis(future)).toThrow(/not before the cutoff/);
    const selection = selectV3(a, selectParamsOf(config));
    expect(selection.moving.length).toBeGreaterThan(0);
    expect(selection.discarded.total).toBeGreaterThanOrEqual(0);
  });

  it("writes the same lists twice for every arm, each over the same cards", async () => {
    const { corpusDir, profilePath, probe, config, root } = await v3Setup();
    const lists = (out: string) =>
      runLists({
        corpusDir,
        cutoffs: ["2026-10-09", CUT_DAY],
        arms: ARMS.filter((a) => a !== "v1" && a !== "v2"),
        outDir: NodePath.join(root, out),
        bagsDir: NodePath.join(root, `${out}-bags`),
        config,
        profilePath,
        relevanceModel: probe,
        embedder: fingerprintEmbedder(),
      });
    const a = await lists("a");
    const b = await lists("b");
    expect(a.files.map((f) => f.logical_hash)).toEqual(b.files.map((f) => f.logical_hash));
    expect(a.files).toHaveLength(14);
    const read = (arm: string) =>
      JSON.parse(NodeFS.readFileSync(NodePath.join(root, "a", arm, `${CUT_DAY}.json`), "utf8")) as {
        moving: Array<{ topic_id: string; item_ids: Array<string>; card: unknown }>;
        background: Array<{ topic_id: string; card: unknown }>;
      };
    const cards = new Map<string, string>();
    for (const arm of ["V1", "V2", "V3", "V4", "R4", "R2", "R5"])
      for (const entry of [...read(arm).moving, ...read(arm).background]) {
        const card = JSON.stringify(entry.card);
        expect(cards.get(entry.topic_id) ?? card).toBe(card);
        cards.set(entry.topic_id, card);
        expect(card).not.toContain("futuretoken");
      }
    expect(read("V1").moving.length).toBeGreaterThan(0);
    expect(read("V1").moving.every((e) => e.item_ids.length > 0)).toBe(true);
    const list = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, "a", "V1", `${CUT_DAY}.json`), "utf8"),
    ) as {
      discards: { exclude: number; exclude_by_topic: Record<string, number>; candidates: number };
    };
    expect(list.discards.exclude).toBeGreaterThan(0);
    expect(Object.keys(list.discards.exclude_by_topic)).toEqual(["football league scores"]);
    const bag = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, "a-bags", `${CUT_DAY}.json`), "utf8"),
    ) as {
      topics: Array<{
        topic_id: string;
        item_ids: Array<string>;
        include_score: number;
        first_at: string;
      }>;
    };
    const ids = bag.topics.flatMap((t) => t.item_ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(bag.topics.every((t) => Date.parse(t.first_at) < dayStart(CUT_DAY))).toBe(true);
  });
});

describe("engine.v1 and engine.v2 untouched", () => {
  it("keeps both configuration hashes", () => {
    expect(loadConfig(DEFAULT_CONFIG_PATH).hash).toBe(
      "sha256:290b9ddeec9bf5bc4e0512972d047c106623a3d050789fe0a8c145504d2e9095",
    );
    expect(loadConfig(NodePath.join(CONFIG_DIR, "engine.v2.json")).hash).toBe(
      "sha256:2594118f12c262911fd9938afbe83fce8b38d7fede73d7990a42ff205da59a65",
    );
  });

  it("reproduces the logical hash of an engine.v2 run the base commit cd910d21ad produced", async () => {
    const root = tempDir("engine-v2-hash");
    const corpusDir = NodePath.join(root, "corpus");
    await writeSyntheticCorpus(corpusDir);
    const { config: b } = loadConfig(DEFAULT_CONFIG_PATH);
    const probe = await probeFor("compiler", b.embedder);
    const base = testConfig();
    const config: EngineConfig = {
      ...base,
      stage: { ...base.stage, coverage_rule: "equivalent" },
      relevance: {
        model: "relevance.test.json",
        sha256: probe.hash,
        item_min: 0.5,
        signal_min: 0.5,
        profile_gate: false,
        aggregate: "trimmed_mean",
        min_relevant_distinct: 1,
        novelty: { lookback_days: 7, top: 5, growth_ratio: 1.5 },
      },
      rank: {
        baseline: base.rank.baseline,
        weighted: {
          method: "weighted_sum.v0.02",
          weights: { growth: 0.25, relevance: 1, log_items_7d: 0.15 },
        },
      },
      emit: { ...base.emit, dedup_cosine: 0.8, min_dossiers: 2 },
    };
    const profilePath = NodePath.join(root, "profile.json");
    NodeFS.writeFileSync(profilePath, JSON.stringify(PROFILE));
    const record = await runEngine({
      corpusDir,
      cutoff: "2026-10-10T00:00:00.000Z",
      profilePath,
      outDir: NodePath.join(root, "runs"),
      config,
      relevanceModel: probe,
      embedder: fingerprintEmbedder(),
    });
    expect(record.logical_hash).toBe(
      "sha256:5a481268504076dd06f0342c581cad74f3193f6a62226d7df400fadaca0b20f1",
    );
    expect((record.stats as { signals_hash: string }).signals_hash).toBe(
      "sha256:dd14b24117e117ba4c53f55c454877671489f26023195ce8da369693c2421e7f",
    );
    expect(readRun(NodePath.join(root, "runs", record.run_id)).dossiers.length).toBe(1);
  });
});
