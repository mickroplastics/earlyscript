// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - tests write temporary corpora and read the files the pool writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Story } from "./backtest-label.ts";
import { readCorpus } from "./corpus.ts";
import { DAY_MS, dayStart } from "./days.ts";
import { captureDay } from "./editorial-capture.ts";
import {
  appendLedger,
  assertSealed,
  ENGINE_SOURCE_HASH,
  freezeEntry,
  lateOnly,
  type Rankings,
  readRegistry,
  groupMembers,
  keywordMatcher,
  parseArm,
  readLedger,
  readUniverse,
  runPool,
  type TopicMember,
  type Universe,
} from "./editorial-eval.ts";
import { followupLabels } from "./editorial-followup.ts";
import { runScore } from "./editorial-score.ts";
import {
  blockDraws,
  bootstrapDifference,
  bootstrapPrecision,
  cohenKappa,
  familyUnit,
  type LabelValue,
  topSlots,
  unitDraws,
  weightedPrecision,
} from "./editorial-stats.ts";
import { fingerprintEmbedder } from "./embed/fingerprint.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { fixtureSources } from "./sources/index.ts";
import {
  syntheticItems,
  tempDir,
  testConfig,
  writeProfile,
  writeSyntheticCorpus,
} from "./testkit/syntheticCorpus.ts";

const unit = (values: ReadonlyArray<number>) => {
  const v = new Float32Array(8);
  values.forEach((x, i) => (v[i] = x));
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

const member = (
  key: string,
  centroid: ReadonlyArray<number>,
  items: ReadonlyArray<string>,
  terms: ReadonlyArray<string> = [],
): TopicMember => ({
  key,
  trendId: key,
  centroid: unit(centroid),
  itemIds: new Set(items),
  terms,
});

describe("same-topic grouping", () => {
  const rare = (t: string) => t === "saudi" || t === "arrested" || t === "bugging";
  const members = [
    member("a", [1, 0, 0], ["i1", "i2", "i3", "i4"], ["openai", "saudi", "arrested"]),
    // Shares 2 of its 3 items with a: the same topic whatever the centroid.
    member("b", [0, 1, 0], ["i2", "i3", "i9"], ["model"]),
    // Close centroid and two shared rare terms: the same event clustered apart.
    member("c", [0.95, 0.05, 0.3], ["j1", "j2"], ["openai", "saudi", "bugging", "arrested"]),
    // Close centroid but only common terms: a different topic (the case 0.80 alone merged).
    member("d", [0.97, 0, 0.25], ["k1", "k2"], ["openai", "model", "models"]),
    member("e", [0, 0, 1], ["l1"], ["chess"]),
  ];

  it("merges by shared items or by cosine with rare terms, never by cosine alone", () => {
    const groups = groupMembers(members, rare).map((g) => g.map((m) => m.key));
    expect(groups).toEqual([["a", "b", "c"], ["d"], ["e"]]);
  });

  it("does not depend on the order of the positions", () => {
    const forward = groupMembers(members, rare).map((g) => g.map((m) => m.key));
    for (const seed of [1, 2, 3]) {
      const shuffled = members.toSorted(
        (x, y) => ((x.key.charCodeAt(0) * seed) % 7) - ((y.key.charCodeAt(0) * seed) % 7),
      );
      expect(groupMembers(shuffled, rare).map((g) => g.map((m) => m.key))).toEqual(forward);
    }
  });
});

describe("keyword rule R4", () => {
  const matches = keywordMatcher(["GPT", "fine-tuning", "local model", "eval", "ChatGPT"]);
  it("matches whole words and treats space and hyphen alike", () => {
    expect(matches("Fine tuning Qwen on a laptop")).toBe(true);
    expect(matches("Running a local-model stack")).toBe(true);
    expect(matches("GPT-6.1 Terra released")).toBe(true);
    expect(matches("ChatGPT for teens")).toBe(true);
    expect(matches("An evaluation of soil")).toBe(false);
    expect(matches("Cryptography")).toBe(false);
  });
});

describe("arm specs", () => {
  it("parses methods and keyword files", () => {
    expect(parseArm("R1=/c/v1.json:weighted")).toEqual({
      name: "R1",
      configPath: "/c/v1.json",
      method: "weighted",
    });
    expect(parseArm("R2=/c/v1.json:baseline").method).toBe("baseline");
    expect(parseArm("C=/c/v2.json")).toEqual({
      name: "C",
      configPath: "/c/v2.json",
      method: "weighted",
    });
    expect(parseArm("R4=/c/np.json:keywords=/c/k.json")).toEqual({
      name: "R4",
      configPath: "/c/np.json",
      method: "keywords",
      keywordsPath: "/c/k.json",
    });
  });
});

describe("slot credits (P1.1 rules 3 and 4)", () => {
  const entry = (
    topicId: string,
    family: string,
    label: LabelValue | null,
    unavailable = false,
  ) => ({
    topicId,
    family,
    label,
    unavailable,
  });
  const slots = topSlots(
    "A",
    "2026-10-20",
    [
      entry("t1", "f1", "yes"),
      entry("t1", "f1", "yes"),
      entry("t3", "f3", "unsure"),
      entry("t4", "f4", "yes", true),
    ],
    5,
  );

  it("counts empty, unsure, duplicate and unavailable positions as 0 over a denominator of 5", () => {
    expect(slots.map((s) => s.zero)).toEqual([
      null,
      "duplicate",
      null,
      "unavailable_at_cutoff",
      "empty",
    ]);
    expect(weightedPrecision(slots, () => 1)).toBeCloseTo(1 / 5);
    // The upper bound counts the unsure card as yes, never the duplicate or the empty position.
    expect(weightedPrecision(slots, () => 1, "upper")).toBeCloseTo(2 / 5);
    // Precision among resolved answers leaves the unsure card out.
    expect(
      weightedPrecision(
        slots.filter((s) => s.zero === null && (s.label === "yes" || s.label === "no")),
        () => 1,
      ),
    ).toBe(1);
  });
});

describe("bootstrap", () => {
  const slotsOf = (arm: string, labels: ReadonlyArray<LabelValue>) =>
    labels.flatMap((label, k) =>
      topSlots(
        arm,
        `2026-10-${String(10 + k).padStart(2, "0")}`,
        [{ topicId: `${arm}${k}`, family: `f${k % 4}`, label, unavailable: false }],
        1,
      ),
    );
  const a = slotsOf("A", ["yes", "yes", "no", "yes", "no", "yes", "yes", "no"]);
  const b = slotsOf("B", ["no", "yes", "no", "no", "no", "yes", "no", "no"]);
  const units = [...a, ...b].map(familyUnit);

  it("is reproducible with a seed and changes with another", () => {
    const one = bootstrapPrecision(a, unitDraws(units, 500, 7), familyUnit);
    const again = bootstrapPrecision(a, unitDraws(units, 500, 7), familyUnit);
    expect(again).toEqual(one);
    const draws = (seed: number) => unitDraws(units, 50, seed).map((w) => [...w].toSorted());
    expect(draws(7)).toEqual(draws(7));
    expect(draws(8)).not.toEqual(draws(7));
    expect(one.low!).toBeLessThanOrEqual(5 / 8);
    expect(one.high!).toBeGreaterThanOrEqual(5 / 8);
  });

  it("pairs the arms on the same draws", () => {
    const d = bootstrapDifference(a, b, unitDraws(units, 500, 7), familyUnit);
    expect(d).toEqual(bootstrapDifference(a, b, unitDraws(units, 500, 7), familyUnit));
    expect(d.high!).toBeGreaterThan(0);
  });
});

describe("agreement", () => {
  it("gives percent agreement and Cohen's kappa over yes/no, leaving doubts out", () => {
    const a = new Map<string, LabelValue>([
      ["1", "yes"],
      ["2", "yes"],
      ["3", "no"],
      ["4", "no"],
      ["5", "unsure"],
    ]);
    const b = new Map<string, LabelValue>([
      ["1", "yes"],
      ["2", "no"],
      ["3", "no"],
      ["4", "no"],
      ["5", "yes"],
    ]);
    const k = cohenKappa(a, b);
    expect(k.n).toBe(4);
    expect(k.excluded).toBe(1);
    expect(k.agreement).toBeCloseTo(0.75);
    // po = 0.75, pe = 0.5 * 0.25 + 0.5 * 0.75 = 0.5
    expect(k.kappa).toBeCloseTo(0.5);
  });
});

describe("HN follow-up on a frozen universe", () => {
  const universeWith = (topics: ReadonlyArray<string>): Universe =>
    ({
      logical: {
        inputs: { followup_threshold: 0.7 },
        topics: topics.map((id) => ({ topic_id: id, card_id: `card_${id}`, cutoff: "2026-10-01" })),
      },
    }) as unknown as Universe;
  const start = dayStart("2026-10-01");
  const stories: Array<Story> = Array.from({ length: 6 }, (_, k) => ({
    id: `s${k}`,
    publishedMs: start + k * DAY_MS + 3600_000,
    author: `u${k}`,
    vector: unit([1, 0.1 * k, 0]),
  }));
  const complete = new Set(
    Array.from({ length: 14 }, (_, k) => new Date(start + k * DAY_MS).toISOString().slice(0, 10)),
  );
  const centroids = new Map([
    ["A", unit([1, 0, 0])],
    ["B", unit([0, 0, 1])],
    // Closer to every story than A: with exclusive assignment it would take A's follow-up.
    ["C", unit([1, 0.25, 0])],
  ]);

  it("does not change a topic's label when another topic or arm is added", () => {
    const before = followupLabels(universeWith(["A", "B"]), centroids, stories, complete);
    const after = followupLabels(universeWith(["A", "B", "C"]), centroids, stories, complete);
    expect(after.filter((l) => l.topic_id !== "C")).toEqual(before);
    expect(before.find((l) => l.topic_id === "A")!.label).toBe("yes");
    expect(before.find((l) => l.topic_id === "B")!.label).toBe("no");
  });

  it("leaves a negative pending until the whole window is captured", () => {
    const partial = new Set([...complete].slice(0, 10));
    const labels = followupLabels(universeWith(["B"]), centroids, stories, partial);
    expect(labels[0]!.label).toBe("pending");
  });
});

async function poolSetup() {
  const root = tempDir("editorial-pool");
  const corpusDir = NodePath.join(root, "corpus");
  await writeSyntheticCorpus(corpusDir);
  const configPath = NodePath.join(root, "config.json");
  NodeFS.writeFileSync(configPath, JSON.stringify(testConfig()));
  const keywords = NodePath.join(root, "keywords.json");
  NodeFS.writeFileSync(keywords, JSON.stringify({ version: "t", terms: ["rust"] }));
  return { root, corpusDir, configPath, keywords, profilePath: writeProfile(root) };
}

describe("pool", () => {
  it("writes the same universe and rankings hashes twice, without labels or metrics", async () => {
    const s = await poolSetup();
    const pool = (out: string) =>
      runPool({
        corpusDir: s.corpusDir,
        profilePath: s.profilePath,
        outDir: NodePath.join(s.root, out),
        cutoffs: ["2026-10-08", "2026-10-10"],
        arms: [
          parseArm(`W=${s.configPath}:weighted`),
          parseArm(`V=${s.configPath}:baseline`),
          parseArm(`K=${s.configPath}:keywords=${s.keywords}`),
        ],
        embedder: fingerprintEmbedder(),
      });
    const first = await pool("a");
    const second = await pool("b");
    expect(first.universe.universe_hash).toBe(second.universe.universe_hash);
    expect(first.rankings.rankings_hash).toBe(second.rankings.rankings_hash);
    expect(readUniverse(first.universePath).universe_hash).toBe(first.universe.universe_hash);
    const topics = first.universe.logical.topics;
    expect(topics.length).toBeGreaterThan(0);
    for (const topic of topics) {
      expect(topic.headlines.length).toBeLessThanOrEqual(5);
      // Card evidence is published before the topic's cutoff.
      for (const h of topic.headlines)
        expect(h.published_at < `${topic.cutoff}T00:00:00`).toBe(true);
    }
    const cards = NodeFS.readFileSync(first.cardsPath!, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(cards).toHaveLength(topics.length);
    // Blind cards: no score, position, arm or family.
    for (const card of cards) {
      expect(Object.keys(card).toSorted()).toEqual([
        "card_id",
        "cutoff",
        "headlines",
        "terms",
        "topic_id",
        "unit",
      ]);
    }
    expect(NodeFS.existsSync(NodePath.join(s.root, "a", "metrics.json"))).toBe(false);
  });
});

describe("prospective capture", () => {
  it("captures a closed day, freezes a snapshot and chains the ledger", async () => {
    const root = tempDir("editorial-capture");
    const source = NodePath.join(root, "source");
    const seed = NodePath.join(root, "seed");
    await writeSyntheticCorpus(source, { toDay: "2026-10-12" });
    await writeSyntheticCorpus(seed, {
      toDay: "2026-10-10",
      items: syntheticItems().filter((i) => i.published_at < "2026-10-10"),
    });
    const corpusDir = NodePath.join(root, "corpus");
    const ledgerPath = NodePath.join(root, "ledger.jsonl");
    const capture = (day: string, now: string) =>
      captureDay({
        corpusDir,
        ledgerPath,
        snapshotsDir: NodePath.join(root, "snapshots"),
        sources: ["hn", "github"],
        adapters: (ids) => fixtureSources(source, ids),
        day,
        seedFrom: seed,
        firstDay: "2026-10-10",
        lastDay: "2026-10-11",
        now: () => new Date(now),
      });
    await expect(capture("2026-10-10", "2026-10-10T23:00:00Z")).rejects.toThrow(/not closed/);
    const first = await capture("2026-10-10", "2026-10-11T00:05:00Z");
    expect(first.skipped).toBe(false);
    expect((await capture("2026-10-10", "2026-10-11T00:09:00Z")).skipped).toBe(true);
    expect((await capture("2026-10-12", "2026-10-13T00:05:00Z")).skipped).toBe(true);
    const snapshot = NodePath.join(root, "snapshots", "2026-10-11", "corpus-manifest.json");
    const frozen = NodeFS.readFileSync(snapshot, "utf8");
    await capture("2026-10-11", "2026-10-12T00:05:00Z");
    // A later capture rewrites the corpus by rename: the earlier snapshot keeps its bytes.
    expect(NodeFS.readFileSync(snapshot, "utf8")).toBe(frozen);
    const ledger = readLedger(ledgerPath);
    expect(ledger.map((e) => e["cutoff_day"])).toEqual(["2026-10-11", "2026-10-12"]);
    expect(ledger[0]!.prev_sha256).toBeNull();
    expect(ledger[1]!.prev_sha256).toMatch(/^sha256:/);
    expect(ledger[0]!["closed_at"]).toBe("2026-10-11T00:05:00.000Z");
    expect(NodeFS.existsSync(NodePath.join(corpusDir, "hn", "2026-10-11.jsonl"))).toBe(true);
  });
});

/** A ledger line with an explicit time, chained like appendLedger (tests only). */
function appendAt(path: string, entry: Record<string, unknown>) {
  const lines = NodeFS.existsSync(path)
    ? NodeFS.readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
    : [];
  const last = lines.at(-1);
  NodeFS.appendFileSync(
    path,
    `${JSON.stringify({ ...entry, prev_sha256: last === undefined ? null : sha256(last) })}\n`,
  );
}

describe("prospective pool and score", () => {
  it("reads the capture snapshot, imports the dev registry, seals and counts only after the freeze", async () => {
    const root = tempDir("editorial-prospective");
    const source = NodePath.join(root, "source");
    const seed = NodePath.join(root, "seed");
    await writeSyntheticCorpus(source, { toDay: "2026-10-12" });
    await writeSyntheticCorpus(seed, {
      toDay: "2026-10-10",
      items: syntheticItems().filter((i) => i.published_at < "2026-10-10"),
    });
    const configPath = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(configPath, JSON.stringify(testConfig()));
    const profilePath = writeProfile(root);
    const arms = [parseArm(`W=${configPath}:weighted`), parseArm(`V=${configPath}:baseline`)];
    // Development first: its families.json is the frozen dev registry.
    const dev = await runPool({
      corpusDir: seed,
      profilePath,
      outDir: NodePath.join(root, "dev"),
      cutoffs: ["2026-10-07"],
      arms,
      embedder: fingerprintEmbedder(),
    });
    const registry = NodePath.join(root, "dev", "families.json");
    const corpusDir = NodePath.join(root, "corpus");
    const ledgerPath = NodePath.join(root, "ledger.jsonl");
    appendLedger(
      ledgerPath,
      freezeEntry({ arms, profilePath, files: [configPath], registries: { dev: registry } }),
    );
    await captureDay({
      corpusDir,
      ledgerPath,
      snapshotsDir: NodePath.join(root, "snapshots"),
      sources: ["hn", "github"],
      adapters: (ids) => fixtureSources(source, ids),
      day: "2026-10-10",
      seedFrom: seed,
      now: () => new Date("2099-01-01T00:05:00Z"),
    });
    const outDir = NodePath.join(root, "pool");
    const pool = await runPool({
      corpusDir: seed,
      profilePath,
      outDir,
      cutoffs: ["2026-10-09", "2026-10-11"],
      arms,
      ledgerPath,
      registries: { dev: registry },
      embedder: fingerprintEmbedder(),
    });
    const [retro, prospective] = pool.universe.logical.cutoffs;
    expect(retro!.prospective).toBe(false);
    expect(prospective!.prospective).toBe(true);
    expect(prospective!.operational_cutoff_at).toBe("2099-01-01T00:05:00.000Z");
    expect(pool.universe.logical.inputs.registries["dev"]).toBe(
      readRegistry(registry).registry_hash,
    );
    expect(pool.universe.logical.topics.every((t) => Array.isArray(t.seen_in["dev"]))).toBe(true);
    expect(dev.universe.logical.topics.length).toBeGreaterThan(0);
    expect(readLedger(ledgerPath).map((e) => e.kind)).toEqual(["freeze", "capture", "rankings"]);
    expect(() => assertSealed(pool.universe, pool.rankings, ledgerPath)).not.toThrow();

    const labelsPath = NodePath.join(root, "labels.json");
    NodeFS.writeFileSync(
      labelsPath,
      JSON.stringify({
        labeler: "miguel",
        universe_hash: pool.universe.universe_hash,
        labels: pool.universe.logical.topics.map((t, k) => ({
          topic_id: t.topic_id,
          label: k % 3 === 2 ? "unsure" : "yes",
        })),
      }),
    );
    const score = (out: string) =>
      runScore({
        universePath: pool.universePath,
        rankingsPath: pool.rankingsPath,
        labelPaths: [labelsPath],
        outDir: NodePath.join(root, out),
        retro: ["2026-10-09"],
        prospective: ["2026-10-11"],
        ledgerPath,
        candidates: ["W"],
        replicates: 50,
      });
    const scored = await score("score");
    const results = scored.metrics.logical.results["miguel"] as Record<string, { cutoffs: number }>;
    expect(results["prospective"]!.cutoffs).toBe(1);
    expect(results["test"]!.cutoffs).toBe(2);
    expect(NodeFS.readFileSync(scored.reportPath, "utf8")).toContain("Candidato W");

    // A freeze after the capture closed leaves the prospective cutoff out, and then the pair is
    // no longer sealed after the latest freeze.
    appendAt(ledgerPath, { ...readLedger(ledgerPath)[0]!, at: "2100-01-01T00:00:00.000Z" });
    await expect(score("score-late")).rejects.toThrow(/not sealed after the freeze/);
  });
});

/** A universe and rankings small enough to state each case by hand, with valid hashes. */
function miniEvaluation(
  root: string,
  topics: ReadonlyArray<{
    id: string;
    family: string;
    cutoff?: string;
    members: ReadonlyArray<{ config: string; trend: string; late?: boolean }>;
    terms?: ReadonlyArray<string>;
  }>,
  tops: Readonly<Record<string, Readonly<Record<string, ReadonlyArray<[string, string]>>>>>,
  options: { prospective?: { cutoff: string; closed: string; corpus: string } } = {},
) {
  const cutoffs = [...new Set(Object.keys(tops))].toSorted();
  const logical = {
    rule: {},
    card_rule: {},
    top: 5,
    inputs: {
      profile_hash: "sha256:p",
      embedding_key: "e",
      sources: ["hn"],
      configs: {},
      followup_threshold: 0.7,
      text: {},
      centroids_hash: "c",
      engine_source_hash: ENGINE_SOURCE_HASH,
      registries: {},
    },
    cutoffs: cutoffs.map((cutoff) => {
      const p = options.prospective?.cutoff === cutoff ? options.prospective : undefined;
      return {
        cutoff,
        cutoff_at: `${cutoff}T00:00:00.000Z`,
        operational_cutoff_at: p?.closed ?? `${cutoff}T00:00:00.000Z`,
        prospective: p !== undefined,
        corpus_manifest_hash: p?.corpus ?? "m",
        coverage: {},
      };
    }),
    topics: topics.map((t) => ({
      topic_id: t.id,
      card_id: `card_${t.id}`,
      cutoff: t.cutoff ?? cutoffs[0]!,
      family_id: t.family,
      anchor: { trend_id: t.members[0]!.trend, centroid_sha256: "x" },
      members: t.members.map((m) => ({
        config_hash: m.config,
        trend_id: m.trend,
        centroid_sha256: "x",
        items: 3,
        late_popularity_only: m.late ?? false,
      })),
      items_before_cutoff: 3,
      items_7d_by_source: {},
      terms: t.terms ?? [t.id],
      headlines: [],
      seen_in: {},
    })),
    families: [...new Set(topics.map((t) => t.family))].map((family_id) => ({
      family_id,
      first_cutoff: cutoffs[0]!,
      topics: topics.filter((t) => t.family === family_id).map((t) => t.id),
    })),
  };
  const universe = {
    schema_version: "earlyscript.editorial-universe/1",
    universe_hash: sha256(canonicalJson(logical)),
    created_at: "x",
    runs: [],
    logical,
  };
  const arms = [...new Set(Object.values(tops).flatMap((byArm) => Object.keys(byArm)))].toSorted();
  const rankingsLogical = {
    top: 5,
    arms: arms.map((name) => ({
      name,
      method: "weighted",
      config_hash: `cfg-${name}`,
      keywords_hash: null,
    })),
    cutoffs: Object.fromEntries(
      Object.entries(tops).map(([cutoff, byArm]) => [
        cutoff,
        Object.fromEntries(
          Object.entries(byArm).map(([arm, entries]) => [
            arm,
            {
              ranked: entries.length,
              top: entries.map(([trend, topic], k) => ({
                position: k + 1,
                trend_id: trend,
                topic_id: topic,
              })),
            },
          ]),
        ),
      ]),
    ),
  };
  const rankings = {
    schema_version: "earlyscript.editorial-rankings/1",
    rankings_hash: sha256(canonicalJson(rankingsLogical)),
    universe_hash: universe.universe_hash,
    logical: rankingsLogical,
  };
  NodeFS.mkdirSync(root, { recursive: true });
  const universePath = NodePath.join(root, "universe.json");
  const rankingsPath = NodePath.join(root, "rankings.json");
  NodeFS.writeFileSync(universePath, JSON.stringify(universe));
  NodeFS.writeFileSync(rankingsPath, JSON.stringify(rankings));
  const labels = (
    labeler: string,
    values: Record<string, LabelValue>,
    universeHash = universe.universe_hash,
  ) => {
    const path = NodePath.join(root, `labels-${labeler}-${Object.keys(values).length}.json`);
    NodeFS.writeFileSync(
      path,
      JSON.stringify({
        labeler,
        universe_hash: universeHash,
        cards_hash: "sha256:none",
        labels: Object.entries(values).map(([topic_id, label]) => ({ topic_id, label })),
      }),
    );
    return path;
  };
  return {
    universePath,
    rankingsPath,
    labels,
    universe: universe as unknown as Universe,
    rankings: rankings as unknown as Rankings,
  };
}

describe("Sol's U1 findings (regressions)", () => {
  it("B1: a later cutoff that links two topics does not make the earlier one a duplicate", async () => {
    const root = tempDir("u1-b1");
    // At D, A and B are distinct opportunities; D+1 links them into one family.
    const e = miniEvaluation(
      root,
      [
        { id: "A", family: "F", cutoff: "2026-10-20", members: [{ config: "cfg-R", trend: "a" }] },
        { id: "B", family: "F", cutoff: "2026-10-20", members: [{ config: "cfg-R", trend: "b" }] },
        { id: "X", family: "F", cutoff: "2026-10-21", members: [{ config: "cfg-R", trend: "x" }] },
      ],
      {
        "2026-10-20": {
          R: [
            ["a", "A"],
            ["b", "B"],
          ],
        },
        "2026-10-21": { R: [["x", "X"]] },
      },
    );
    const out = await runScore({
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      labelPaths: [e.labels("m", { A: "yes", B: "yes", X: "no" })],
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-20", "2026-10-21"],
      replicates: 10,
    });
    const arm = (out.metrics.logical.results["m"] as any).dev.arms.R;
    expect(arm.per_cutoff["2026-10-20"]).toBeCloseTo(0.4);
    expect(arm.duplicates_at_5).toBe(0);
  });

  it("B2: refuses an empty freeze, a broken chain, another rankings pair and a foreign capture", () => {
    const root = tempDir("u1-b2");
    const capture = {
      cutoff: "2026-11-06",
      closed: "2026-11-06T00:09:00.000Z",
      corpus: "sha256:snap",
    };
    const e = miniEvaluation(
      root,
      [{ id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }] }],
      { "2026-11-06": { R: [["a", "A"]] } },
      { prospective: capture },
    );
    const frozen = NodePath.join(root, "config.json");
    NodeFS.writeFileSync(frozen, "{}");
    const freeze = {
      kind: "freeze",
      at: "2026-11-05T12:00:00.000Z",
      arms: e.rankings.logical.arms,
      profile_hash: "sha256:p",
      engine_source_hash: ENGINE_SOURCE_HASH,
      registries: {},
      files: [{ path: frozen, sha256: sha256("{}") }],
    };
    const captureEntry = {
      kind: "capture",
      at: capture.closed,
      cutoff_day: capture.cutoff,
      closed_at: capture.closed,
      snapshot_dir: "/snap",
      corpus_hash: capture.corpus,
    };
    const sealEntry = {
      kind: "rankings",
      at: "2026-11-06T01:00:00.000Z",
      universe_hash: e.universe.universe_hash,
      rankings_hash: e.rankings.rankings_hash,
    };
    const ledger = (name: string, entries: ReadonlyArray<Record<string, unknown>>) => {
      const path = NodePath.join(root, `${name}.jsonl`);
      for (const entry of entries) appendAt(path, entry);
      return path;
    };
    expect(() =>
      assertSealed(e.universe, e.rankings, ledger("ok", [freeze, captureEntry, sealEntry])),
    ).not.toThrow();
    expect(() =>
      assertSealed(
        e.universe,
        e.rankings,
        ledger("empty", [{ ...freeze, files: [] }, captureEntry, sealEntry]),
      ),
    ).toThrow(/names no files/);
    expect(() =>
      assertSealed(e.universe, e.rankings, ledger("noseal", [freeze, captureEntry])),
    ).toThrow(/not sealed/);
    expect(() =>
      assertSealed(
        e.universe,
        e.rankings,
        ledger("other", [freeze, captureEntry, { ...sealEntry, rankings_hash: "sha256:other" }]),
      ),
    ).toThrow(/not sealed/);
    expect(() =>
      assertSealed(
        e.universe,
        e.rankings,
        ledger("arms", [
          { ...freeze, arms: [{ ...e.rankings.logical.arms[0]!, config_hash: "B" }] },
          captureEntry,
          sealEntry,
        ]),
      ),
    ).toThrow(/differ from the freeze/);
    expect(() =>
      assertSealed(
        e.universe,
        e.rankings,
        ledger("corpus", [freeze, { ...captureEntry, corpus_hash: "sha256:else" }, sealEntry]),
      ),
    ).toThrow(/captured corpus/);
    const broken = ledger("broken", [freeze, captureEntry, sealEntry]);
    const lines = NodeFS.readFileSync(broken, "utf8").split("\n");
    lines[0] = lines[0]!.replace("12:00:00", "12:00:01");
    NodeFS.writeFileSync(broken, lines.join("\n"));
    expect(() => assertSealed(e.universe, e.rankings, broken)).toThrow(/breaks the chain/);
    NodeFS.writeFileSync(frozen, '{"changed":true}');
    expect(() =>
      assertSealed(e.universe, e.rankings, ledger("changed", [freeze, captureEntry, sealEntry])),
    ).toThrow(/changed or is missing/);
  });

  it("B3: B6 follows each arm's own position, not the shared card", async () => {
    const root = tempDir("u1-b3");
    // One opportunity: C's member is held up only by late GitHub items, R's by HN.
    const e = miniEvaluation(
      root,
      [
        {
          id: "A",
          family: "F",
          members: [
            { config: "cfg-C", trend: "c", late: true },
            { config: "cfg-R", trend: "r" },
          ],
        },
      ],
      { "2026-10-30": { C: [["c", "A"]], R: [["r", "A"]] } },
    );
    const out = await runScore({
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      labelPaths: [e.labels("m", { A: "yes" })],
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-30"],
      retro: ["2026-10-30"],
      replicates: 10,
    });
    const arms = (out.metrics.logical.results["m"] as any).retro.arms;
    expect(arms.C.p_at_5).toBe(0);
    expect(arms.C.counts.unavailable_at_cutoff).toBe(1);
    expect(arms.R.p_at_5).toBeCloseTo(0.2);
    expect(
      lateOnly(
        [
          {
            id: "1",
            source: "github",
            published_at: "2026-10-29T01:00:00Z",
            retrieved_at: "2026-11-05T00:00:00Z",
          },
        ],
        Date.parse("2026-10-30T00:00:00Z"),
        Date.parse("2026-10-30T00:00:00Z"),
      ),
    ).toBe(true);
    expect(
      lateOnly(
        [
          {
            id: "1",
            source: "hn",
            published_at: "2026-10-29T01:00:00Z",
            retrieved_at: "2026-11-05T00:00:00Z",
          },
        ],
        Date.parse("2026-10-30T00:00:00Z"),
        Date.parse("2026-10-30T00:00:00Z"),
      ),
    ).toBe(false);
  });

  it("B4: refuses absent cutoffs and test partitions with no dev reference", async () => {
    const root = tempDir("u1-b4");
    const e = miniEvaluation(
      root,
      [{ id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }] }],
      { "2026-10-30": { R: [["a", "A"]] } },
    );
    const run = (opts: { dev?: Array<string>; retro?: Array<string> }) =>
      runScore({
        universePath: e.universePath,
        rankingsPath: e.rankingsPath,
        labelPaths: [e.labels("m", { A: "yes" })],
        outDir: NodePath.join(root, "s"),
        replicates: 10,
        ...opts,
      });
    await expect(run({ dev: ["2026-10-17"], retro: ["2026-10-30"] })).rejects.toThrow(
      /not in the universe/,
    );
    await expect(run({ retro: ["2026-10-30"] })).rejects.toThrow(/dev family registry/);
  });

  it("S2: refuses labels of another universe unless the very same card migrates", async () => {
    const root = tempDir("u1-s2");
    const e = miniEvaluation(
      root,
      [
        { id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }], terms: ["same"] },
        { id: "B", family: "G", members: [{ config: "cfg-R", trend: "b" }], terms: ["now"] },
      ],
      {
        "2026-10-20": {
          R: [
            ["a", "A"],
            ["b", "B"],
          ],
        },
      },
    );
    const foreign = e.labels("m", { A: "yes", B: "yes" }, "sha256:WRONG");
    const base = {
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-20"],
      replicates: 10,
    };
    await expect(runScore({ ...base, labelPaths: [foreign] })).rejects.toThrow(
      /pass its cards to migrate/,
    );
    // The old cards: A identical, B showed other terms then.
    const cards = NodePath.join(root, "old-cards.jsonl");
    NodeFS.writeFileSync(
      cards,
      [
        {
          card_id: "card_A",
          unit: "topic",
          topic_id: "A",
          cutoff: "2026-10-20",
          terms: ["same"],
          headlines: [],
        },
        {
          card_id: "card_B",
          unit: "topic",
          topic_id: "B",
          cutoff: "2026-10-20",
          terms: ["before"],
          headlines: [],
        },
      ]
        .map((c) => `${JSON.stringify(c)}\n`)
        .join(""),
    );
    const json = JSON.parse(NodeFS.readFileSync(foreign, "utf8"));
    NodeFS.writeFileSync(
      foreign,
      JSON.stringify({ ...json, cards_hash: sha256(NodeFS.readFileSync(cards)) }),
    );
    const out = await runScore({
      ...base,
      labelPaths: [],
      migrateLabels: [{ labels: foreign, cards }],
    });
    const arm = (out.metrics.logical.results["m"] as any).dev.arms.R;
    expect(arm.p_at_5).toBeCloseTo(0.2);
    expect(out.metrics.logical.labels[0]!.migration).toMatchObject({ accepted: 1, dropped: 1 });
  });

  it("S3: sensitivity blocks follow calendar days, not consecutive cutoffs", () => {
    // Blocks of consecutive cutoffs always drew these two together; 7-day blocks cannot hold
    // both (21 days apart), so their weights vary apart and each block adds at most one.
    const draws = blockDraws(["2026-09-13", "2026-10-04"], 7, 200, 3);
    expect(draws.some((w) => (w.get("2026-09-13") ?? 0) !== (w.get("2026-10-04") ?? 0))).toBe(true);
    expect(draws.every((w) => (w.get("2026-09-13") ?? 0) + (w.get("2026-10-04") ?? 0) <= 4)).toBe(
      true,
    );
  });
});

describe("cross-day duplicate ids in the prospective capture", () => {
  it("leaves out an item already stored on another day and records it", async () => {
    const root = tempDir("editorial-dup");
    const source = NodePath.join(root, "source");
    const seed = NodePath.join(root, "seed");
    await writeSyntheticCorpus(source, { toDay: "2026-10-12" });
    await writeSyntheticCorpus(seed, {
      toDay: "2026-10-10",
      items: syntheticItems().filter((i) => i.published_at < "2026-10-10"),
    });
    const stored = syntheticItems().find(
      (i) => i.source === "hn" && i.published_at.startsWith("2026-10-05"),
    )!;
    const corpusDir = NodePath.join(root, "corpus");
    const ledgerPath = NodePath.join(root, "ledger.jsonl");
    const result = await captureDay({
      corpusDir,
      ledgerPath,
      snapshotsDir: NodePath.join(root, "snapshots"),
      sources: ["hn", "github"],
      // The provider serves, on 10 Oct, an item the corpus already holds on 5 Oct.
      adapters: (ids) =>
        fixtureSources(source, ids).map((adapter) => ({
          descriptor: adapter.descriptor,
          collectDay: async (day: string) => {
            const r = await adapter.collectDay(day);
            if (adapter.descriptor.id !== "hn") return r;
            return {
              ...r,
              items: [...r.items, { ...stored, published_at: `${day}T05:00:00.000Z` }],
            };
          },
        })),
      day: "2026-10-10",
      seedFrom: seed,
      now: () => new Date("2026-10-11T00:05:00Z"),
    });
    expect(result.skipped).toBe(false);
    const entry = readLedger(ledgerPath)[0]!;
    expect(entry["skipped_duplicates"]).toEqual([
      { source: "hn", day: "2026-10-10", id: stored.id, existing_day: "2026-10-05" },
    ]);
    expect(entry["duplicate_ids_after"]).toEqual([]);
    // The corpus still reads: no id appears twice.
    await expect(
      readCorpus({
        dir: corpusDir,
        adapters: fixtureSources(corpusDir, ["hn", "github"]),
        untilDay: "2026-10-11",
      }),
    ).resolves.toBeDefined();
  });
});
