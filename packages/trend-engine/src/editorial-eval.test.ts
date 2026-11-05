// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - tests write temporary corpora and read the files the pool writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Story } from "./backtest-label.ts";
import { DAY_MS, dayStart } from "./days.ts";
import { captureDay } from "./editorial-capture.ts";
import {
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
import {
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
      entry("t2", "f1", "yes"),
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
  }, 60_000);
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
  }, 60_000);
});
