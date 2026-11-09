// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - tests write temporary corpora and read the files the pool writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Story } from "./backtest-label.ts";
import { readCorpus } from "./corpus.ts";
import { DAY_MS, dayStart } from "./days.ts";
import { captureDay } from "./editorial-capture.ts";
import { readRun } from "./check.ts";
import { dot } from "./cluster.ts";
import { dedupe } from "./rank.ts";
import { parseRelevanceModel, RELEVANCE_SCHEMA_VERSION } from "./relevance.ts";
import { DEFAULT_CONFIG_PATH, loadConfig, runEngine } from "./run.ts";
import {
  appendLedger,
  assertCheckout,
  assertSealed,
  engineSourceHash,
  evalSourceHash,
  freezeEntry,
  lateOnly,
  type Rankings,
  readRegistry,
  repeatCardId,
  sameTopic,
  withRepeats,
  anchorGroups,
  fromBase64,
  keywordMatcher,
  parseArm,
  readLedger,
  readUniverse,
  runPool,
  type TopicMember,
  type Universe,
} from "./editorial-eval.ts";
import { followupLabels, followupSpan, writeFollowupLabels } from "./editorial-followup.ts";
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

describe("topic identity (one rule for F's emission and the evaluation)", () => {
  const rare = (t: string) => t === "saudi" || t === "arrested" || t === "bugging";
  const a = member("a", [1, 0, 0], ["i1", "i2", "i3", "i4"], ["openai", "saudi", "arrested"]);

  it("needs cosine above 0.80 and two shared rare terms or half the smaller's members", () => {
    // Close centroid and two shared rare terms: the same event clustered apart.
    const c = member("c", [0.95, 0.05, 0.3], ["j1"], ["openai", "saudi", "bugging", "arrested"]);
    // Close centroid, half of its members shared, no rare term.
    const h = member("h", [0.97, 0.1, 0.1], ["i2", "i3", "z"], ["model"]);
    // Close centroid but only common terms: a different topic (the case cosine alone merged).
    const d = member("d", [0.97, 0, 0.25], ["k1", "k2"], ["openai", "model", "models"]);
    // Every member shared but a distant centroid: not the same topic any more.
    const far = member("far", [0, 1, 0], ["i1", "i2", "i3", "i4"], ["openai", "saudi", "arrested"]);
    expect(sameTopic(a, c, rare)).toBe(true);
    expect(sameTopic(a, h, rare)).toBe(true);
    expect(sameTopic(a, d, rare)).toBe(false);
    expect(sameTopic(a, far, rare)).toBe(false);
  });

  it("keeps apart the real 17 Oct pair F used to fold by cosine alone", () => {
    // sig_bee4abaebcd0 (openai lawsuit anthropic google) and sig_a218e7749283 (nvidia chips
    // platform agents): cosine 0.8318, no shared top term, disjoint members.
    const pair = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(import.meta.dirname, "testkit/dev-2026-10-17-pair.json"),
        "utf8",
      ),
    ) as Record<string, { centroid: string; terms: Array<string> }>;
    const [lawsuit, chips] = ["sig_bee4abaebcd0", "sig_a218e7749283"].map((id) => ({
      id,
      key: id,
      trendId: id,
      centroid: fromBase64(pair[id]!.centroid),
      itemIds: new Set([`${id}-item`]),
      terms: pair[id]!.terms,
    }));
    expect(dot(lawsuit!.centroid, chips!.centroid)).toBeGreaterThan(0.8);
    const everyTermRare = () => true;
    expect(sameTopic(lawsuit!, chips!, everyTermRare)).toBe(false);
    // F's emission folds with this same function: both stay.
    const same = (x: TopicMember, y: TopicMember) => sameTopic(x, y, everyTermRare);
    expect(dedupe([chips!, lawsuit!], [], (m) => m.centroid, same).kept).toHaveLength(2);
  });

  it("forms opportunities by direct match with an anchor, never through a bridge (Sol's A/B/C)", () => {
    // A, B, C at 0, 0.6 and 1.2 radians: A~B and B~C (0.8253), A and C far (0.3624).
    const at = (key: string, angle: number) =>
      member(key, [Math.cos(angle), Math.sin(angle)], [`${key}1`], ["alpha", "beta"]);
    const all = () => true;
    const [A, B, C] = [at("A", 0), at("B", 0.6), at("C", 1.2)];
    expect(sameTopic(A, C, all)).toBe(false);
    // Whichever position anchors, A and C never land in one group through B.
    for (const order of [
      ["A", "B", "C"],
      ["B", "A", "C"],
      ["C", "B", "A"],
    ]) {
      const groups = anchorGroups([A, B, C], all, (m) => String(order.indexOf(m.key)));
      // Every pair inside a group is directly the same topic, so A and C never share a card,
      // not even when B anchors.
      expect(groups.some((g) => g.includes(A) && g.includes(C))).toBe(false);
      for (const g of groups)
        for (const x of g) for (const y of g) if (x !== y) expect(sameTopic(x, y, all)).toBe(true);
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
  tops: Readonly<
    Record<
      string,
      Readonly<Record<string, ReadonlyArray<[string, string] | [string, string, number | null]>>>
    >
  >,
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
      text: testConfig().text,
      centroids_hash: "c",
      engine_source_hash: engineSourceHash(),
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
              top: entries.map(([trend, topic, duplicateOf], k) => ({
                position: k + 1,
                trend_id: trend,
                topic_id: topic,
                ...(duplicateOf !== undefined ? { duplicate_of: duplicateOf } : {}),
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
      engine_source_hash: engineSourceHash(),
      eval_source_hash: evalSourceHash(),
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
    expect(() =>
      assertSealed(
        e.universe,
        e.rankings,
        ledger("evalcode", [
          { ...freeze, eval_source_hash: "sha256:other-scorer" },
          captureEntry,
          sealEntry,
        ]),
      ),
    ).toThrow(/evaluation code/);
    expect(() => assertCheckout({ ...freeze, prev_sha256: null })).toThrow(/no git tree/);
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

  it("B4: reads the training registry of tools/training-families.ts", () => {
    const root = tempDir("u1-b4-train");
    const path = NodePath.join(root, "training-families.jsonl");
    const centroid = Buffer.from(new Float32Array([1, 0]).buffer).toString("base64");
    NodeFS.writeFileSync(
      path,
      `${JSON.stringify({ signal_id: "sig_a", first_seen_at: "x", items_total: 3, training_items: ["i1"], terms: ["rust"], centroid })}\n${JSON.stringify({ summary: true })}\n`,
    );
    const registry = readRegistry(path);
    expect(registry.members).toHaveLength(1);
    expect(registry.members[0]!.trendId).toBe("sig_a");
    expect(registry.registry_hash).toBe(sha256(NodeFS.readFileSync(path, "utf8")));
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

  it("graded labels: G@5 gives core 1 and adjacent 0.5; ungraded yes leaves G@5 empty", async () => {
    const root = tempDir("u1-graded");
    const e = miniEvaluation(
      root,
      [
        { id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }] },
        { id: "B", family: "G", members: [{ config: "cfg-R", trend: "b" }] },
        { id: "C", family: "H", members: [{ config: "cfg-R", trend: "c" }] },
      ],
      {
        "2026-10-20": {
          R: [
            ["a", "A"],
            ["b", "B"],
            ["c", "C"],
          ],
        },
      },
    );
    const graded = NodePath.join(root, "graded.json");
    NodeFS.writeFileSync(
      graded,
      JSON.stringify({
        labeler: "m",
        universe_hash: e.universe.universe_hash,
        labels: [
          { topic_id: "A", label: "yes", grade: "core" },
          { topic_id: "B", label: "adjacent" },
          { topic_id: "C", label: "no", grade: null },
        ],
      }),
    );
    const base = {
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-20"],
      replicates: 10,
    };
    const arm = (out: Awaited<ReturnType<typeof runScore>>) =>
      (out.metrics.logical.results["m"] as any).dev.arms.R;
    const g = arm(await runScore({ ...base, labelPaths: [graded] }));
    expect(g.p_at_5).toBeCloseTo(0.4);
    expect(g.g_at_5).toBeCloseTo(0.3);
    expect(g.core_share).toBeCloseTo(0.2);
    const old = arm(
      await runScore({ ...base, labelPaths: [e.labels("m", { A: "yes", B: "yes", C: "no" })] }),
    );
    expect(old.p_at_5).toBeCloseTo(0.4);
    expect(old.g_at_5).toBeNull();
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

/** A probe that scores texts with `word` high (as relevance.test.ts does). */
async function wordProbe(word: string) {
  const { config } = loadConfig(DEFAULT_CONFIG_PATH);
  const [direction] = await fingerprintEmbedder().embed([word]);
  return parseRelevanceModel(
    new TextEncoder().encode(
      JSON.stringify({
        schema_version: RELEVANCE_SCHEMA_VERSION,
        model_id: "relevance.test",
        method: "test",
        embedding: {
          model: config.embedder.model,
          revision: config.embedder.revision,
          dtype: config.embedder.dtype,
          pooling: config.embedder.pooling,
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

describe("council round 2a (regressions)", () => {
  it("repeats ten cards blind, at least 20 apart, and keeps them out of the metrics", async () => {
    const cards = Array.from({ length: 40 }, (_, k) => ({
      card_id: `card_${k}`,
      unit: "topic" as const,
      topic_id: `t${k}`,
      cutoff: "2026-10-20",
      terms: [`term${k}`],
      headlines: [],
    }));
    const deck = withRepeats(cards, { count: 10, seed: 7 });
    expect(deck).toHaveLength(50);
    expect(withRepeats(cards, { count: 10, seed: 7 })).toEqual(deck);
    const repeats = deck.filter((c) => !cards.some((o) => o.card_id === c.card_id));
    expect(repeats).toHaveLength(10);
    for (const r of repeats) {
      const original = deck.findIndex((c) => c.topic_id === r.topic_id);
      const copy = deck.findIndex((c) => c.card_id === r.card_id);
      expect(copy - original).toBeGreaterThan(20);
      expect({ ...r, card_id: "" }).toEqual({ ...deck[original]!, card_id: "" });
    }

    const root = tempDir("u1-repeats");
    const e = miniEvaluation(
      root,
      [{ id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }] }],
      { "2026-10-20": { R: [["a", "A"]] } },
    );
    const labels = NodePath.join(root, "labels.json");
    NodeFS.writeFileSync(
      labels,
      JSON.stringify({
        labeler: "m",
        universe_hash: e.universe.universe_hash,
        labels: [
          { card_id: "card_A", topic_id: "A", label: "yes", grade: "core", labeled_at: "1" },
          // The blind repeat, answered later and differently: never a metric.
          {
            card_id: repeatCardId("card_A"),
            topic_id: "A",
            label: "yes",
            grade: "adjacent",
            labeled_at: "2",
          },
        ],
      }),
    );
    const out = await runScore({
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      labelPaths: [labels],
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-20"],
      replicates: 10,
    });
    const dev = (out.metrics.logical.results["m"] as any).dev;
    expect(dev.arms.R.g_at_5).toBeCloseTo(0.2);
    expect(dev.consistency).toEqual({
      pairs: 1,
      met: false,
      binary: 1,
      graded: 0,
      core_vs_rest: 0,
    });
    expect(dev.consistency_met).toBe(false);
  });

  it("reports the sensitivity of G@5, G@5 without the top family and new families honestly", async () => {
    const root = tempDir("u1-sensitivity");
    const e = miniEvaluation(
      root,
      [
        { id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }] },
        { id: "B", family: "G", members: [{ config: "cfg-R", trend: "b" }] },
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
    const labels = NodePath.join(root, "labels.json");
    NodeFS.writeFileSync(
      labels,
      JSON.stringify({
        labeler: "m",
        universe_hash: e.universe.universe_hash,
        labels: [
          { topic_id: "A", label: "yes", grade: "core" },
          { topic_id: "B", label: "yes", grade: "adjacent" },
        ],
      }),
    );
    const out = await runScore({
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      labelPaths: [labels],
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-20"],
      replicates: 10,
    });
    const arm = (out.metrics.logical.results["m"] as any).dev.arms.R;
    expect(arm.g_at_5).toBeCloseTo(0.3);
    expect(arm.g_at_5_adjacent_0_3).toBeCloseTo(0.26);
    expect(arm.g_at_5_adjacent_0_7).toBeCloseTo(0.34);
    expect(arm.g_at_5_without_top_family).toEqual({ family: "F", value: 0.1 });
    // Without a training registry, "new to dev and training" cannot be evaluated.
    expect(arm.unseen_in_dev_and_train.status).toBe(
      "no evaluable: falta el registro de entrenamiento",
    );
  });

  it("computes F's novelty memory inside each run: the same cut alone, joined, reused or reordered", async () => {
    const s = await poolSetup();
    const probe = await wordProbe("compiler");
    const base = testConfig();
    const fConfig = {
      ...base,
      stage: { ...base.stage, coverage_rule: "equivalent" as const },
      relevance: {
        model: "relevance.test.json",
        sha256: probe.hash,
        item_min: 0.5,
        signal_min: 0.5,
        profile_gate: false,
        aggregate: "share" as const,
        min_relevant_distinct: 1,
        novelty: { lookback_days: 7, top: 5, growth_ratio: 0 },
      },
      rank: {
        baseline: base.rank.baseline,
        weighted: {
          method: "weighted_sum.v0.02",
          weights: { growth: 0.25, relevance: 1, log_items_7d: 0.15 },
        },
      },
      emit: { ...base.emit, dedup_cosine: 0.8 },
    };
    const configPath = NodePath.join(s.root, "f.json");
    NodeFS.writeFileSync(configPath, JSON.stringify(fConfig));
    const pool = (out: string, cutoffs: Array<string>) =>
      runPool({
        corpusDir: s.corpusDir,
        profilePath: s.profilePath,
        outDir: NodePath.join(s.root, out),
        cutoffs,
        arms: [parseArm(`F=${configPath}:weighted`)],
        relevanceModel: probe,
        embedder: fingerprintEmbedder(),
      });
    const cut = "2026-10-10";
    const runOf = (r: Awaited<ReturnType<typeof pool>>) =>
      r.universe.runs.find((x) => x.cutoff === cut)!;
    const logical = (r: Awaited<ReturnType<typeof pool>>) =>
      readRun(runOf(r).run_dir).record.logical_hash;
    const alone = await pool("alone", [cut]);
    const joined = await pool("joined", ["2026-10-02", cut, "2026-10-06"]);
    const reused = await pool("joined", [cut, "2026-10-02", "2026-10-06"]);
    expect(runOf(reused).reused).toBe(true);
    const direct = await runEngine({
      corpusDir: s.corpusDir,
      cutoff: `${cut}T00:00:00Z`,
      profilePath: s.profilePath,
      outDir: NodePath.join(s.root, "direct"),
      config: fConfig,
      relevanceModel: probe,
      embedder: fingerprintEmbedder(),
    });
    expect(direct.status).toBe("ok");
    const novelty = readRun(runOf(alone).run_dir).dossiers.flatMap((d) =>
      d.relevance?.novelty ? [d.relevance.novelty] : [],
    );
    expect(novelty.length).toBeGreaterThan(0);
    for (const r of [joined, reused]) {
      expect(logical(r)).toBe(logical(alone));
      expect(r.rankings.logical.cutoffs[cut]).toEqual(alone.rankings.logical.cutoffs[cut]);
    }
    expect(direct.logical_hash).toBe(logical(alone));
  });

  it("never leaves in an F top 5 two positions this evaluation calls the same topic", async () => {
    // Random low-dimensional centroids, so many pairs pass cosine 0.8; every term is rare.
    const random = (() => {
      let x = 7;
      return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    })();
    const all = () => true;
    for (let trial = 0; trial < 50; trial++) {
      const members = Array.from({ length: 12 }, (_, k) => {
        const v = Float32Array.from({ length: 3 }, () => random() + 0.2);
        const norm = Math.hypot(...v);
        return {
          id: `s${k}`,
          key: `s${k}`,
          trendId: `s${k}`,
          centroid: v.map((x) => x / norm),
          itemIds: new Set([`i${k}`]),
          terms: ["alpha", "beta"],
        };
      });
      const same = (x: TopicMember, y: TopicMember) => sameTopic(x, y, all);
      const kept = dedupe(members, [], (m) => m.centroid, same).kept.slice(0, 5);
      for (let i = 0; i < kept.length; i++) {
        for (let j = i + 1; j < kept.length; j++) {
          expect(sameTopic(kept[i]!, kept[j]!, all)).toBe(false);
        }
      }
    }
  });
});

describe("Sol's motor-v2 findings (regressions)", () => {
  it("B1: a bridge from another arm never makes two positions of C duplicates", async () => {
    const root = tempDir("u1-v2-b1");
    // B anchors one opportunity holding C's A and C positions and R's B (Sol's worst case): the
    // pool marks C's second position as not a duplicate, since A and C do not match directly.
    const e = miniEvaluation(
      root,
      [
        {
          id: "O",
          family: "F",
          members: [
            { config: "cfg-C", trend: "a" },
            { config: "cfg-C", trend: "c" },
            { config: "cfg-R", trend: "b" },
          ],
        },
      ],
      {
        "2026-10-20": {
          C: [
            ["a", "O", null],
            ["c", "O", null],
          ],
          R: [["b", "O", null]],
        },
      },
    );
    const out = await runScore({
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      labelPaths: [e.labels("m", { O: "yes" })],
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-20"],
      replicates: 10,
    });
    const arm = (out.metrics.logical.results["m"] as any).dev.arms.C;
    expect(arm.p_at_5).toBeCloseTo(0.4);
    expect(arm.duplicates_at_5).toBe(0);
  });
});

describe("Sol's motor-v2 third verification B1 (regression)", () => {
  it("with B first, A and C keep separate cards and can get different answers", async () => {
    const root = tempDir("u1-v2-b1-3");
    // What anchorGroups now forms for Sol's A/B/C with B first: [B, A] and [C].
    const e = miniEvaluation(
      root,
      [
        {
          id: "OB",
          family: "F1",
          members: [
            { config: "cfg-R", trend: "b" },
            { config: "cfg-C", trend: "a" },
          ],
        },
        { id: "OC", family: "F2", members: [{ config: "cfg-C", trend: "c" }] },
      ],
      {
        "2026-10-20": {
          C: [
            ["a", "OB", null],
            ["c", "OC", null],
          ],
          R: [["b", "OB", null]],
        },
      },
    );
    const out = await runScore({
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      labelPaths: [e.labels("m", { OB: "yes", OC: "no" })],
      outDir: NodePath.join(root, "s"),
      dev: ["2026-10-20"],
      replicates: 10,
    });
    const arm = (out.metrics.logical.results["m"] as any).dev.arms.C;
    expect(arm.p_at_5).toBeCloseTo(0.2);
    expect(arm.duplicates_at_5).toBe(0);
  });
});

describe("Sol's motor-v2 S3 (regression)", () => {
  it("does not call valid a partition with unanswered cards", async () => {
    const root = tempDir("u1-v2-s3");
    const e = miniEvaluation(
      root,
      [{ id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }] }],
      { "2026-10-20": { R: [["a", "A", null]] } },
    );
    const out = await runScore({
      universePath: e.universePath,
      rankingsPath: e.rankingsPath,
      labelPaths: [e.labels("m", {})],
      outDir: NodePath.join(root, "s"),
      partitions: { test: ["2026-10-20"] },
      dev: ["2026-10-20"],
      replicates: 10,
    });
    const test = (out.metrics.logical.results["m"] as any).test;
    expect(test.unsure_limit_met).toBe(true);
    expect(test.all_answered).toBe(false);
    expect(test.valid).toBe(false);
    expect(test.consistency_met).toBe(false);
  });
});

describe("Sol's motor-v2 S4 (regression)", () => {
  it("loads the last partial day of a prospective follow-up and can close a negative", async () => {
    const root = tempDir("u1-v2-s4");
    const corpusDir = NodePath.join(root, "corpus");
    await writeSyntheticCorpus(corpusDir, { fromDay: "2026-09-20", toDay: "2026-10-12" });
    // A prospective cutoff decided at 00:05: its window runs to 9 Oct 00:05 and spans 15 days.
    const e = miniEvaluation(
      root,
      [{ id: "A", family: "F", members: [{ config: "cfg-R", trend: "a" }] }],
      { "2026-09-25": { R: [["a", "A", null]] } },
      { prospective: { cutoff: "2026-09-25", closed: "2026-09-25T00:05:00.000Z", corpus: "m" } },
    );
    expect(followupSpan(e.universe)).toEqual({
      endMs: Date.parse("2026-10-09T00:05:00.000Z"),
      untilDay: "2026-10-10",
    });
    const embedder = fingerprintEmbedder();
    const [far] = await embedder.embed(["zzz unrelated qqq"]);
    NodeFS.writeFileSync(
      NodePath.join(root, "centroids.json"),
      JSON.stringify({
        embedding_key: embedder.key,
        topics: {
          A: Buffer.from(far!.buffer, far!.byteOffset, far!.byteLength).toString("base64"),
        },
      }),
    );
    const result = await writeFollowupLabels({
      universePath: e.universePath,
      corpusDir,
      out: NodePath.join(root, "labels-hn.json"),
      embedder,
    });
    // No story is close; all 15 days are captured complete: a final no, not pending.
    expect(result.labels[0]!.label).toBe("no");
    expect(result.labels[0]!.complete_days).toBe(15);
  });
});
