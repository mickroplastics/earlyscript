// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over files this module writes.
// `engine eval-editorial pool`: the frozen universe of protocol P1.1. Runs the engine once per
// cutoff and distinct configuration, takes each arm's top 5, merges the positions that are the
// same topic at the same cutoff into one opportunity (the labelled unit: topic and cutoff), links
// opportunities of different cutoffs into families, and writes universe.json and rankings.json
// with their hashes before any label or metric exists. Blind cards come from the universe only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Dossier } from "@earlyscript/editorial-contracts/dossier";
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";
import type { CoverageRecord, SourceId } from "@earlyscript/editorial-contracts/source";

import { parseCutoffList } from "./backtest.ts";
import { readRun } from "./check.ts";
import { dot } from "./cluster.ts";
import { readCorpus } from "./corpus.ts";
import { DAY_MS, dayStart, daysBefore } from "./days.ts";
import { renderCardsHtml } from "./editorial-cards-html.ts";
import { seededShuffle } from "./editorial-stats.ts";
import { createLocalEmbedder } from "./embed/local.ts";
import { defaultModelDir } from "./embed/model.ts";
import { type Embedder, embeddingSpec } from "./embed/spec.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import {
  DEFAULT_DATA_DIR,
  type EmittedTrend,
  loadConfig,
  parseCutoff,
  runDir,
  runEngine,
} from "./run.ts";
import { fixtureSources } from "./sources/index.ts";
import { createStackReplay } from "./stack-replay.ts";

export const UNIVERSE_SCHEMA_VERSION = "earlyscript.editorial-universe/1";
export const RANKINGS_SCHEMA_VERSION = "earlyscript.editorial-rankings/1";
export const CARDS_SCHEMA_VERSION = "earlyscript.editorial-cards/1";

/** Sources of every arm in protocol P1 (the app's active mix). */
export const EVAL_SOURCES: ReadonlyArray<SourceId> = [
  "hn",
  "github",
  "huggingface",
  "npm",
  "wikipedia",
  "rss",
];

/**
 * Same topic: at least half the smaller one's members shared, or centroid cosine >= 0.80 plus two
 * shared rare top terms (in <= 1 % of the items of the 30 days before the later cutoff). Cosine
 * alone merged unrelated 30-day clusters in development (README). Closed transitively.
 */
export const SAME_TOPIC_RULE = {
  shared_items_min_fraction: 0.5,
  centroid_cosine_min: 0.8,
  rare_terms_min_shared: 2,
  rare_term_max_item_share: 0.01,
  rare_term_window_days: 30,
  terms: "top_terms of each position's dossier (10)",
  closure: "connected components (transitive)",
  within_cutoff: "opportunity: the labelled unit (topic, cutoff)",
  across_cutoffs: "family: dependence and new versus recurrent topics; labels never travel",
} as const;

/** P1.1 rule 5: card evidence is fixed and independent of the arm. */
export const CARD_RULE = {
  headlines: 5,
  headline_order:
    "the 5 most recent member items published before the cutoff, published_at desc then id asc",
  members: "union of the members of every top-5 position merged into the opportunity",
  terms: "top_terms of the anchor position's dossier, first 8",
  anchor: "the merged position with the smallest `trend_id|centroid_sha256`",
} as const;

/** B6 (P1.1 rule 6): sources selected by present-day popularity. */
export const LATE_POPULARITY_SOURCES: ReadonlyArray<SourceId> = ["github", "huggingface"];

export const DEFAULT_TOP = 5;
export const DEFAULT_CARD_SEED = 20_261_105;
export const REFERENCE_CONFIG_DIR = NodePath.join(import.meta.dirname, "../config");

export type ArmMethod = "baseline" | "weighted" | "keywords";

export interface ArmSpec {
  readonly name: string;
  readonly configPath: string;
  readonly method: ArmMethod;
  readonly keywordsPath?: string;
}

/** `<name>=<config.json>[:baseline|:weighted|:keywords=<terms.json>]`; weighted by default. */
export function parseArm(text: string): ArmSpec {
  const eq = text.indexOf("=");
  if (eq <= 0) throw new Error(`arm ${text}: expected <name>=<config.json>[:method]`);
  const name = text.slice(0, eq);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error(`arm name ${name} is not a plain name`);
  const rest = text.slice(eq + 1);
  const keywords = /^(.*):keywords=(.+)$/.exec(rest);
  if (keywords) {
    return { name, configPath: keywords[1]!, method: "keywords", keywordsPath: keywords[2]! };
  }
  const method = /^(.*):(baseline|weighted)$/.exec(rest);
  if (method) return { name, configPath: method[1]!, method: method[2] as ArmMethod };
  return { name, configPath: rest, method: "weighted" };
}

/** R1 to R4 of protocol P1, from the configurations shipped with the package. */
export function referenceArms(dir = REFERENCE_CONFIG_DIR): Array<ArmSpec> {
  const v1 = NodePath.join(dir, "engine.v1.json");
  const noProfile = NodePath.join(dir, "editorial-eval/engine.v1-noprofile.json");
  return [
    { name: "R1", configPath: v1, method: "weighted" },
    { name: "R2", configPath: v1, method: "baseline" },
    { name: "R3", configPath: noProfile, method: "baseline" },
    {
      name: "R4",
      configPath: noProfile,
      method: "keywords",
      keywordsPath: NodePath.join(dir, "editorial-eval/keywords.v1.json"),
    },
  ];
}

/** C of protocol P1: the v2 candidate with its weighted ranking. */
export const candidateArm = (dir = REFERENCE_CONFIG_DIR): ArmSpec => ({
  name: "C",
  configPath: NodePath.join(dir, "engine.v2.json"),
  method: "weighted",
});

export interface KeywordList {
  readonly version: string;
  readonly terms: ReadonlyArray<string>;
}

/** Case-insensitive whole-word match; a space or hyphen inside a term matches either. */
export function keywordMatcher(terms: ReadonlyArray<string>): (text: string) => boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = terms
    .map((term) => escape(term.trim().toLowerCase()).replace(/[\s-]+/g, "[\\s-]+"))
    .join("|");
  const re = new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, "i");
  return (text) => re.test(text);
}

/** A ledger line: append-only JSON lines, each chained to the SHA-256 of the line before it. */
export interface LedgerEntry {
  readonly kind: string;
  readonly at: string;
  readonly prev_sha256: string | null;
  readonly [key: string]: unknown;
}

export function readLedger(path: string): Array<LedgerEntry> {
  if (!NodeFS.existsSync(path)) return [];
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

export function appendLedger(
  path: string,
  entry: { readonly kind: string } & Record<string, unknown>,
): LedgerEntry {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = NodeFS.openSync(lockPath, "wx");
  try {
    const lines = NodeFS.existsSync(path)
      ? NodeFS.readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
      : [];
    const last = lines.at(-1);
    const full: LedgerEntry = {
      ...entry,
      at: new Date().toISOString(),
      prev_sha256: last === undefined ? null : sha256(last),
    };
    NodeFS.appendFileSync(path, `${JSON.stringify(full)}\n`);
    NodeFS.fsyncSync(lock);
    return full;
  } finally {
    NodeFS.closeSync(lock);
    NodeFS.rmSync(lockPath, { force: true });
  }
}

export const fileSha256 = (path: string) => sha256(NodeFS.readFileSync(path));

/** A capture entry (see capture.ts): the corpus of a prospective cutoff and its operational instant. */
export interface CaptureEntry extends LedgerEntry {
  readonly kind: "capture";
  readonly cutoff_day: string;
  readonly closed_at: string;
  readonly snapshot_dir: string;
  readonly corpus_hash: string;
}

export const captureEntries = (ledger: ReadonlyArray<LedgerEntry>) =>
  ledger.filter(
    (e): e is CaptureEntry => e.kind === "capture" && typeof e["snapshot_dir"] === "string",
  );

export interface PoolOptions {
  readonly corpusDir: string;
  readonly profilePath: string;
  readonly outDir: string;
  /** UTC days or 00:00Z instants. */
  readonly cutoffs: ReadonlyArray<string>;
  readonly arms: ReadonlyArray<ArmSpec>;
  /** Replaces every arm configuration's `sources`; protocol P1 uses EVAL_SOURCES. */
  readonly sources?: ReadonlyArray<SourceId>;
  readonly top?: number;
  /** Prospective cutoffs read the snapshot of their capture entry; the pool seals its files in it. */
  readonly ledgerPath?: string;
  /** Write cards.jsonl and cards.html of the whole universe (default true). */
  readonly cards?: boolean;
  readonly cardSeed?: number;
  /** Replaces the local Qwen embedder, for tests. The pool disposes it. */
  readonly embedder?: Embedder;
  readonly cacheFile?: string;
  readonly cacheOnly?: boolean;
  readonly modelDir?: string;
  readonly workers?: number;
  readonly allowUnverifiedCorpus?: boolean;
  readonly log?: (line: string) => void;
}

interface RunTrend {
  readonly centroid: Float32Array;
  readonly itemIds: ReadonlyArray<string>;
}

interface PoolRun {
  readonly runId: string;
  readonly runDir: string;
  readonly logicalHash: string;
  readonly corpusUsedHash: string;
  readonly reused: boolean;
  readonly dossiers: ReadonlyArray<Dossier>;
  readonly trends: ReadonlyMap<string, RunTrend>;
}

const toBase64 = (v: Float32Array) =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

export function fromBase64(text: string): Float32Array {
  const bytes = Buffer.from(text, "base64");
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

const vectorSha = (v: Float32Array) => sha256(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));

const toInstant = (cutoff: string) =>
  parseCutoff(/^\d{4}-\d{2}-\d{2}$/.test(cutoff) ? `${cutoff}T00:00:00Z` : cutoff);

/** Union-find over string keys; components are read with their smallest key as root. */
class Components {
  private readonly parent = new Map<string, string>();
  add(key: string) {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }
  find(key: string): string {
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let node = key;
    while (node !== root) {
      const next = this.parent.get(node)!;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
  groups(): Array<Array<string>> {
    const out = new Map<string, Array<string>>();
    for (const key of [...this.parent.keys()].toSorted()) {
      const root = this.find(key);
      if (!out.has(root)) out.set(root, []);
      out.get(root)!.push(key);
    }
    return [...out.values()];
  }
}

export interface TopicMember {
  readonly key: string;
  readonly trendId: string;
  readonly centroid: Float32Array;
  readonly itemIds: ReadonlySet<string>;
  readonly terms: ReadonlyArray<string>;
}

/** SAME_TOPIC_RULE for two members, given the rare terms of the (later) cutoff. */
export function sameTopic(
  a: TopicMember,
  b: TopicMember,
  rare: (term: string) => boolean,
): boolean {
  const [small, large] = a.itemIds.size <= b.itemIds.size ? [a, b] : [b, a];
  if (small.itemIds.size > 0) {
    let shared = 0;
    for (const id of small.itemIds) if (large.itemIds.has(id)) shared++;
    if (shared >= SAME_TOPIC_RULE.shared_items_min_fraction * small.itemIds.size) return true;
  }
  if (dot(a.centroid, b.centroid) < SAME_TOPIC_RULE.centroid_cosine_min) return false;
  const bTerms = new Set(b.terms);
  const sharedRare = new Set(a.terms.filter((t) => bTerms.has(t) && rare(t)));
  return sharedRare.size >= SAME_TOPIC_RULE.rare_terms_min_shared;
}

const termTokens = (text: string): Array<string> =>
  text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];

/**
 * Item document frequency of the candidate terms in the window before each cutoff; a term is
 * rare at a cutoff when its share is at most SAME_TOPIC_RULE.rare_term_max_item_share.
 */
export function rareTermsByCutoff(
  items: ReadonlyArray<Pick<Item, "published_at" | "title" | "body">>,
  terms: ReadonlySet<string>,
  cutoffDays: ReadonlyArray<string>,
): Map<string, Set<string>> {
  const tokens = items.map((item) => ({
    ms: Date.parse(item.published_at),
    terms: new Set(termTokens(`${item.title} ${item.body}`).filter((t) => terms.has(t))),
  }));
  return new Map(
    cutoffDays.map((day) => {
      const end = dayStart(day);
      const start = end - SAME_TOPIC_RULE.rare_term_window_days * DAY_MS;
      const df = new Map<string, number>();
      let n = 0;
      for (const t of tokens) {
        if (t.ms < start || t.ms >= end) continue;
        n++;
        for (const term of t.terms) df.set(term, (df.get(term) ?? 0) + 1);
      }
      const rare = new Set(
        [...terms].filter(
          (term) => (df.get(term) ?? 0) <= SAME_TOPIC_RULE.rare_term_max_item_share * n,
        ),
      );
      return [day, rare] as const;
    }),
  );
}

/** Connected components of SAME_TOPIC_RULE; members are listed by key, groups by first key. */
export function groupMembers<T extends TopicMember>(
  members: ReadonlyArray<T>,
  rare: (term: string) => boolean,
): Array<Array<T>> {
  const byKey = new Map(members.map((m) => [m.key, m]));
  const sorted = [...byKey.values()].toSorted((a, b) => (a.key < b.key ? -1 : 1));
  const components = new Components();
  for (const m of sorted) components.add(m.key);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sameTopic(sorted[i]!, sorted[j]!, rare)) components.union(sorted[i]!.key, sorted[j]!.key);
    }
  }
  return components.groups().map((keys) => keys.map((key) => byKey.get(key)!));
}

export interface Headline {
  readonly title: string;
  readonly source: string;
  readonly published_at: string;
}

export interface UniverseTopic {
  /** The labelled unit: one topic at one cutoff. */
  readonly topic_id: string;
  readonly card_id: string;
  readonly cutoff: string;
  readonly family_id: string;
  readonly anchor: { readonly trend_id: string; readonly centroid_sha256: string };
  readonly members: ReadonlyArray<{
    readonly config_hash: string;
    readonly trend_id: string;
    readonly centroid_sha256: string;
    readonly items: number;
  }>;
  readonly items_before_cutoff: number;
  /** Member items of the 7 days before the cutoff, per source. */
  readonly items_7d_by_source: Readonly<Record<string, number>>;
  readonly terms: ReadonlyArray<string>;
  readonly headlines: ReadonlyArray<Headline>;
  /** B6: every headline is a GitHub or Hugging Face item retrieved after the (operational) cutoff. */
  readonly late_popularity_only: boolean;
}

export interface UniverseCutoff {
  readonly cutoff: string;
  readonly cutoff_at: string;
  /** Prospective: the capture's closing time in the ledger; otherwise the nominal cutoff. */
  readonly operational_cutoff_at: string;
  readonly prospective: boolean;
  readonly corpus_manifest_hash: string;
  readonly coverage: Readonly<Record<string, CoverageWindows>>;
}

export interface CoverageWindow {
  readonly complete: number;
  readonly partial: number;
  readonly unavailable: number;
  readonly rate_limited: number;
  /** Days with no capture at all: absence of observation, not zero publications. */
  readonly missing: number;
  readonly items: number;
}

export interface CoverageWindows {
  readonly last_7d: CoverageWindow;
  readonly prev_7d: CoverageWindow;
}

export interface Universe {
  readonly schema_version: typeof UNIVERSE_SCHEMA_VERSION;
  readonly universe_hash: string;
  readonly created_at: string;
  readonly runs: ReadonlyArray<{
    readonly cutoff: string;
    readonly config_hash: string;
    readonly run_id: string;
    readonly run_dir: string;
    readonly reused: boolean;
  }>;
  readonly logical: {
    readonly rule: typeof SAME_TOPIC_RULE;
    readonly card_rule: typeof CARD_RULE;
    readonly top: number;
    readonly inputs: {
      readonly profile_hash: string;
      readonly embedding_key: string;
      readonly sources: ReadonlyArray<string>;
      readonly configs: Readonly<Record<string, EngineConfig>>;
      readonly followup_threshold: number;
      readonly text: EngineConfig["text"];
      readonly centroids_hash: string;
    };
    readonly cutoffs: ReadonlyArray<UniverseCutoff>;
    readonly topics: ReadonlyArray<UniverseTopic>;
    readonly families: ReadonlyArray<{
      readonly family_id: string;
      readonly first_cutoff: string;
      readonly topics: ReadonlyArray<string>;
    }>;
  };
}

export interface RankingEntry {
  readonly position: number;
  readonly trend_id: string;
  readonly topic_id: string;
}

export interface Rankings {
  readonly schema_version: typeof RANKINGS_SCHEMA_VERSION;
  readonly rankings_hash: string;
  readonly universe_hash: string;
  readonly logical: {
    readonly top: number;
    readonly arms: ReadonlyArray<{
      readonly name: string;
      readonly method: ArmMethod;
      readonly config_hash: string;
      readonly keywords_hash: string | null;
    }>;
    /** cutoff -> arm -> its top positions (fewer than `top` when it ranks fewer). */
    readonly cutoffs: Readonly<
      Record<
        string,
        Readonly<Record<string, { readonly ranked: number; readonly top: Array<RankingEntry> }>>
      >
    >;
  };
}

const sevenDaysBefore = (cutoffMs: number) => cutoffMs - 7 * DAY_MS;

function coverageWindows(
  rows: ReadonlyArray<CoverageRecord>,
  sources: ReadonlyArray<SourceId>,
  cutoffDay: string,
): Record<string, CoverageWindows> {
  const status = new Map(rows.map((r) => [`${r.source}/${r.day}`, r]));
  const days = daysBefore(cutoffDay, 14);
  const window = (source: SourceId, ds: ReadonlyArray<string>): CoverageWindow => {
    const w = { complete: 0, partial: 0, unavailable: 0, rate_limited: 0, missing: 0, items: 0 };
    for (const day of ds) {
      const row = status.get(`${source}/${day}`);
      if (!row) w.missing++;
      else {
        w[row.status]++;
        w.items += row.items;
      }
    }
    return w;
  };
  return Object.fromEntries(
    sources.map((s) => [
      s,
      { prev_7d: window(s, days.slice(0, 7)), last_7d: window(s, days.slice(7)) },
    ]),
  );
}

export interface PoolResult {
  readonly universePath: string;
  readonly rankingsPath: string;
  readonly universe: Universe;
  readonly rankings: Rankings;
  readonly cardsPath: string | null;
}

export async function runPool(options: PoolOptions): Promise<PoolResult> {
  const log = options.log ?? (() => undefined);
  const top = options.top ?? DEFAULT_TOP;
  if (options.arms.length === 0) throw new Error("pool needs at least one arm");
  if (new Set(options.arms.map((a) => a.name)).size !== options.arms.length) {
    throw new Error("arm names must be distinct");
  }
  const profileHash = sha256(NodeFS.readFileSync(options.profilePath));

  // Arms -> effective configurations; arms that share a configuration share its runs.
  const configs = new Map<string, EngineConfig>();
  const arms = options.arms.map((arm) => {
    const { config: loaded } = loadConfig(arm.configPath);
    const config = options.sources ? { ...loaded, sources: [...options.sources] } : loaded;
    const configHash = sha256(canonicalJson(config));
    configs.set(configHash, config);
    const keywords = arm.keywordsPath
      ? (JSON.parse(NodeFS.readFileSync(arm.keywordsPath, "utf8")) as KeywordList)
      : null;
    return {
      ...arm,
      configHash,
      keywordsHash: arm.keywordsPath ? fileSha256(arm.keywordsPath) : null,
      matches: keywords ? keywordMatcher(keywords.terms) : null,
    };
  });
  const embedderConfigs = new Set([...configs.values()].map((c) => canonicalJson(c.embedder)));
  if (embedderConfigs.size !== 1) throw new Error("every arm must use the same embedder");
  const thresholds = new Set([...configs.values()].map((c) => c.cluster.threshold));
  const first = [...configs.values()][0]!;
  const sources = [...new Set([...configs.values()].flatMap((c) => c.sources))].toSorted();

  const cutoffs = [...new Set(options.cutoffs.map((c) => toInstant(c).cutoffAt))].toSorted();
  if (cutoffs.length === 0) throw new Error("pool needs at least one cutoff");
  const ledger = options.ledgerPath ? readLedger(options.ledgerPath) : [];
  const captureOf = new Map(captureEntries(ledger).map((e) => [e.cutoff_day, e]));
  const corpusOf = (cutoffDay: string) =>
    captureOf.get(cutoffDay)?.snapshot_dir ?? options.corpusDir;

  const inner =
    options.embedder ??
    createLocalEmbedder(embeddingSpec(first.embedder), {
      cacheFile:
        options.cacheFile ?? NodePath.join(DEFAULT_DATA_DIR, "embeddings/embeddings.sqlite"),
      modelDir: options.modelDir ?? defaultModelDir(DEFAULT_DATA_DIR, first.embedder.revision),
      workers: options.workers ?? 2,
      allowDownload: true,
      cacheOnly: options.cacheOnly ?? false,
      log,
    });
  const shared: Embedder = {
    spec: inner.spec,
    key: inner.key,
    embed: (texts) => inner.embed(texts),
    dispose: async () => undefined,
  };

  NodeFS.mkdirSync(options.outDir, { recursive: true });
  const stackers = new Map([...configs.keys()].map((hash) => [hash, createStackReplay()]));
  const runsOf = new Map<string, Map<string, PoolRun>>();
  // Items and coverage, read once per corpus directory up to the last cutoff that uses it.
  const corpora = new Map<
    string,
    { items: Map<string, Item>; coverage: ReadonlyArray<CoverageRecord>; manifestHash: string }
  >();
  try {
    for (const cutoffAt of cutoffs) {
      const cutoffDay = cutoffAt.slice(0, 10);
      const corpusDir = corpusOf(cutoffDay);
      const perConfig = new Map<string, PoolRun>();
      for (const [configHash, config] of configs) {
        perConfig.set(
          configHash,
          await poolRun({
            options,
            log,
            corpusDir,
            cutoffAt,
            config,
            configHash,
            profileHash,
            embedder: shared,
            stack: stackers.get(configHash)!,
          }),
        );
      }
      runsOf.set(cutoffAt, perConfig);
    }
  } finally {
    await inner.dispose();
  }
  for (const dir of new Set(cutoffs.map((c) => corpusOf(c.slice(0, 10))))) {
    const untilDay = cutoffs
      .filter((c) => corpusOf(c.slice(0, 10)) === dir)
      .at(-1)!
      .slice(0, 10);
    const corpus = await readCorpus({
      dir,
      adapters: fixtureSources(dir, sources as Array<SourceId>),
      untilDay,
      ...(options.allowUnverifiedCorpus ? { allowUnverified: true } : {}),
    });
    corpora.set(dir, {
      items: new Map(corpus.items.map((item) => [item.id, item])),
      coverage: corpus.coverage,
      manifestHash: corpus.manifestHash,
    });
  }

  // Rankings per cutoff and arm, then the positions as members of the cutoff's topics.
  interface Position extends TopicMember {
    readonly configHash: string;
    readonly dossier: Dossier;
  }
  const universeCutoffs: Array<UniverseCutoff> = [];
  const rankingsByCutoff: Record<
    string,
    Record<
      string,
      { ranked: number; top: Array<{ position: number; trend_id: string; key: string }> }
    >
  > = {};
  const positionsByCutoff = new Map<string, Map<string, Position>>();
  for (const cutoffAt of cutoffs) {
    const cutoffDay = cutoffAt.slice(0, 10);
    const cutoffMs = Date.parse(cutoffAt);
    const corpus = corpora.get(corpusOf(cutoffDay))!;
    const capture = captureOf.get(cutoffDay);
    universeCutoffs.push({
      cutoff: cutoffDay,
      cutoff_at: cutoffAt,
      operational_cutoff_at: capture?.closed_at ?? cutoffAt,
      prospective: capture !== undefined,
      corpus_manifest_hash: corpus.manifestHash,
      coverage: coverageWindows(
        corpus.coverage.filter((r) => r.day < cutoffDay),
        sources as Array<SourceId>,
        cutoffDay,
      ),
    });
    const positions = new Map<string, Position>();
    rankingsByCutoff[cutoffDay] = {};
    for (const arm of arms) {
      const run = runsOf.get(cutoffAt)!.get(arm.configHash)!;
      let ordered: Array<Dossier>;
      if (arm.method === "keywords") {
        ordered = run.dossiers
          .filter((d) => {
            const trend = run.trends.get(d.trend.id)!;
            const titles = trend.itemIds
              .map((id) => corpus.items.get(id))
              .filter(
                (item): item is Item =>
                  item !== undefined && Date.parse(item.published_at) >= sevenDaysBefore(cutoffMs),
              )
              .map((item) => item.title);
            return arm.matches!([...d.trend.top_terms, ...titles].join("\n"));
          })
          .toSorted(
            (a, b) =>
              b.trend.items_7d - a.trend.items_7d ||
              (a.trend.id < b.trend.id ? -1 : a.trend.id > b.trend.id ? 1 : 0),
          );
      } else {
        const method = arm.method;
        ordered = run.dossiers.toSorted(
          (a, b) => a.rankings[method].position - b.rankings[method].position,
        );
      }
      const chosen = ordered.slice(0, top);
      rankingsByCutoff[cutoffDay][arm.name] = {
        ranked: ordered.length,
        top: chosen.map((d, k) => ({
          position: k + 1,
          trend_id: d.trend.id,
          key: `${arm.configHash}|${d.trend.id}`,
        })),
      };
      for (const d of chosen) {
        const key = `${arm.configHash}|${d.trend.id}`;
        if (positions.has(key)) continue;
        const trend = run.trends.get(d.trend.id)!;
        positions.set(key, {
          key,
          configHash: arm.configHash,
          trendId: d.trend.id,
          centroid: trend.centroid,
          itemIds: new Set(trend.itemIds),
          terms: d.trend.top_terms,
          dossier: d,
        });
      }
    }
    positionsByCutoff.set(cutoffDay, positions);
  }

  // Opportunities: merged positions of one cutoff. Their ids hang on the anchor, not on arm names.
  interface Opportunity {
    readonly topic: Omit<UniverseTopic, "family_id">;
    readonly members: ReadonlyArray<Position>;
    readonly anchorCentroid: Float32Array;
  }
  const opportunities: Array<Opportunity> = [];
  const topicOfKey = new Map<string, string>();
  const candidateTerms = new Set(
    [...positionsByCutoff.values()].flatMap((ps) => [...ps.values()].flatMap((p) => p.terms)),
  );
  const rareOf = new Map<string, Set<string>>();
  for (const [dir, corpus] of corpora) {
    const days = universeCutoffs.map((c) => c.cutoff).filter((day) => corpusOf(day) === dir);
    for (const [day, rare] of rareTermsByCutoff([...corpus.items.values()], candidateTerms, days)) {
      rareOf.set(day, rare);
    }
  }
  for (const { cutoff: cutoffDay, operational_cutoff_at } of universeCutoffs) {
    const cutoffMs = dayStart(cutoffDay);
    const corpus = corpora.get(corpusOf(cutoffDay))!;
    const rare = rareOf.get(cutoffDay)!;
    for (const group of groupMembers([...positionsByCutoff.get(cutoffDay)!.values()], (t) =>
      rare.has(t),
    )) {
      const anchorKey = (p: Position) => `${p.trendId}|${vectorSha(p.centroid)}`;
      const anchor = group.toSorted((a, b) => (anchorKey(a) < anchorKey(b) ? -1 : 1))[0]!;
      const topicId = `top_${sha256(`${cutoffDay}\n${anchorKey(anchor)}`).slice(7, 23)}`;
      const ids = [...new Set(group.flatMap((p) => [...p.itemIds]))];
      const items = ids
        .map((id) => corpus.items.get(id))
        .filter(
          (item): item is Item => item !== undefined && Date.parse(item.published_at) < cutoffMs,
        );
      if (items.length !== ids.length) {
        throw new Error(
          `topic ${topicId}: ${ids.length - items.length} members missing from the corpus or not before the cutoff`,
        );
      }
      const recent = items.toSorted(
        (a, b) =>
          b.published_at.localeCompare(a.published_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const evidence = recent.slice(0, CARD_RULE.headlines);
      const operationalMs = Date.parse(operational_cutoff_at);
      const by7d: Record<string, number> = {};
      for (const item of items) {
        if (Date.parse(item.published_at) >= sevenDaysBefore(cutoffMs)) {
          by7d[item.source] = (by7d[item.source] ?? 0) + 1;
        }
      }
      for (const p of group) topicOfKey.set(`${cutoffDay}|${p.key}`, topicId);
      opportunities.push({
        members: group,
        anchorCentroid: anchor.centroid,
        topic: {
          topic_id: topicId,
          card_id: `card_${sha256(`card\n${topicId}`).slice(7, 19)}`,
          cutoff: cutoffDay,
          anchor: { trend_id: anchor.trendId, centroid_sha256: vectorSha(anchor.centroid) },
          members: group.map((p) => ({
            config_hash: p.configHash,
            trend_id: p.trendId,
            centroid_sha256: vectorSha(p.centroid),
            items: p.itemIds.size,
          })),
          items_before_cutoff: items.length,
          items_7d_by_source: Object.fromEntries(
            Object.entries(by7d).toSorted(([a], [b]) => (a < b ? -1 : 1)),
          ),
          terms: anchor.dossier.trend.top_terms.slice(0, 8),
          headlines: evidence.map((item) => ({
            title: item.title,
            source: item.source,
            published_at: item.published_at,
          })),
          late_popularity_only:
            evidence.length > 0 &&
            evidence.every(
              (item) =>
                LATE_POPULARITY_SOURCES.includes(item.source) &&
                Date.parse(item.retrieved_at) > operationalMs,
            ),
        },
      });
    }
  }

  // Families: opportunities of any cutoffs linked by the same rule over their members.
  const familyComponents = new Components();
  for (const o of opportunities) familyComponents.add(o.topic.topic_id);
  for (let i = 0; i < opportunities.length; i++) {
    for (let j = i + 1; j < opportunities.length; j++) {
      const a = opportunities[i]!;
      const b = opportunities[j]!;
      if (a.topic.cutoff === b.topic.cutoff) continue;
      const rare = rareOf.get(a.topic.cutoff > b.topic.cutoff ? a.topic.cutoff : b.topic.cutoff)!;
      const isRare = (t: string) => rare.has(t);
      if (a.members.some((ma) => b.members.some((mb) => sameTopic(ma, mb, isRare)))) {
        familyComponents.union(a.topic.topic_id, b.topic.topic_id);
      }
    }
  }
  const topicById = new Map(opportunities.map((o) => [o.topic.topic_id, o]));
  const families = familyComponents.groups().map((ids) => {
    const ordered = ids.toSorted((a, b) => {
      const ca = topicById.get(a)!.topic.cutoff;
      const cb = topicById.get(b)!.topic.cutoff;
      return ca < cb ? -1 : ca > cb ? 1 : a < b ? -1 : 1;
    });
    return {
      family_id: `fam_${sha256(`family\n${ordered[0]!}`).slice(7, 23)}`,
      first_cutoff: topicById.get(ordered[0]!)!.topic.cutoff,
      topics: ordered,
    };
  });
  const familyOf = new Map(families.flatMap((f) => f.topics.map((t) => [t, f.family_id])));
  const topics: Array<UniverseTopic> = opportunities
    .map((o) => ({ ...o.topic, family_id: familyOf.get(o.topic.topic_id)! }))
    .toSorted((a, b) =>
      a.cutoff < b.cutoff ? -1 : a.cutoff > b.cutoff ? 1 : a.topic_id < b.topic_id ? -1 : 1,
    );

  const centroids = {
    embedding_key: shared.key,
    topics: Object.fromEntries(
      opportunities
        .map((o) => [o.topic.topic_id, toBase64(o.anchorCentroid)] as const)
        .toSorted(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
  const centroidsPath = NodePath.join(options.outDir, "centroids.json");
  NodeFS.writeFileSync(centroidsPath, `${JSON.stringify(centroids)}\n`);

  const logical: Universe["logical"] = {
    rule: SAME_TOPIC_RULE,
    card_rule: CARD_RULE,
    top,
    inputs: {
      profile_hash: profileHash,
      embedding_key: shared.key,
      sources,
      configs: Object.fromEntries([...configs].toSorted(([a], [b]) => (a < b ? -1 : 1))),
      followup_threshold: Math.min(...thresholds),
      text: first.text,
      centroids_hash: sha256(canonicalJson(centroids)),
    },
    cutoffs: universeCutoffs,
    topics,
    families,
  };
  const universe: Universe = {
    schema_version: UNIVERSE_SCHEMA_VERSION,
    universe_hash: sha256(canonicalJson(logical)),
    created_at: new Date().toISOString(),
    runs: cutoffs.flatMap((cutoffAt) =>
      [...runsOf.get(cutoffAt)!].map(([configHash, run]) => ({
        cutoff: cutoffAt.slice(0, 10),
        config_hash: configHash,
        run_id: run.runId,
        run_dir: run.runDir,
        reused: run.reused,
      })),
    ),
    logical,
  };
  const rankingsLogical: Rankings["logical"] = {
    top,
    arms: arms.map((a) => ({
      name: a.name,
      method: a.method,
      config_hash: a.configHash,
      keywords_hash: a.keywordsHash,
    })),
    cutoffs: Object.fromEntries(
      Object.entries(rankingsByCutoff).map(([day, byArm]) => [
        day,
        Object.fromEntries(
          Object.entries(byArm).map(([arm, { ranked, top: entries }]) => [
            arm,
            {
              ranked,
              top: entries.map(({ position, trend_id, key }) => ({
                position,
                trend_id,
                topic_id: topicOfKey.get(`${day}|${key}`)!,
              })),
            },
          ]),
        ),
      ]),
    ),
  };
  const rankings: Rankings = {
    schema_version: RANKINGS_SCHEMA_VERSION,
    rankings_hash: sha256(canonicalJson(rankingsLogical)),
    universe_hash: universe.universe_hash,
    logical: rankingsLogical,
  };
  const universePath = NodePath.join(options.outDir, "universe.json");
  const rankingsPath = NodePath.join(options.outDir, "rankings.json");
  NodeFS.writeFileSync(universePath, `${JSON.stringify(universe, null, 2)}\n`);
  NodeFS.writeFileSync(rankingsPath, `${JSON.stringify(rankings, null, 2)}\n`);
  log(
    `pool: ${topics.length} topics in ${families.length} families, universe ${universe.universe_hash}`,
  );
  if (options.ledgerPath) {
    appendLedger(options.ledgerPath, {
      kind: "rankings",
      universe_hash: universe.universe_hash,
      rankings_hash: rankings.rankings_hash,
      files: [universePath, rankingsPath, centroidsPath].map((path) => ({
        path: NodePath.resolve(path),
        sha256: fileSha256(path),
      })),
      arms: rankingsLogical.arms,
      profile_hash: profileHash,
      cutoffs: cutoffs.map((c) => c.slice(0, 10)),
    });
  }
  let cardsPath: string | null = null;
  if (options.cards ?? true) {
    cardsPath = writeCardSet(
      buildTopicCards(universe, { seed: options.cardSeed ?? DEFAULT_CARD_SEED }),
      options.outDir,
      "cards",
      { universeHash: universe.universe_hash, title: "Tarjetas de temas" },
    ).jsonl;
  }
  return { universePath, rankingsPath, universe, rankings, cardsPath };
}

async function poolRun(args: {
  readonly options: PoolOptions;
  readonly log: (line: string) => void;
  readonly corpusDir: string;
  readonly cutoffAt: string;
  readonly config: EngineConfig;
  readonly configHash: string;
  readonly profileHash: string;
  readonly embedder: Embedder;
  readonly stack: ReturnType<typeof createStackReplay>;
}): Promise<PoolRun> {
  const { options, cutoffAt, config, configHash, corpusDir } = args;
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(corpusDir, "corpus-manifest.json"), "utf8"),
  ) as { corpus_hash: string };
  const key = canonicalJson({
    cutoffAt,
    configHash,
    profileHash: args.profileHash,
    embedding: args.embedder.key,
    corpus: manifest.corpus_hash,
  });
  const dir = NodePath.join(options.outDir, "runs", cutoffAt.slice(0, 10), configHash.slice(7, 19));
  const sidecar = NodePath.join(dir, "emitted.json");
  if (NodeFS.existsSync(sidecar) && !options.allowUnverifiedCorpus) {
    const saved = JSON.parse(NodeFS.readFileSync(sidecar, "utf8")) as {
      key: string;
      run_id: string;
      trends: Array<{ id: string; centroid: string; item_ids: Array<string> }>;
    };
    const savedDir = NodePath.join(dir, saved.run_id);
    if (saved.key === key && NodeFS.existsSync(savedDir)) {
      const { record, dossiers } = readRun(savedDir);
      args.log(`pool: ${cutoffAt.slice(0, 10)} ${configHash.slice(7, 19)} reused ${record.run_id}`);
      return {
        runId: record.run_id,
        runDir: savedDir,
        logicalHash: record.logical_hash!,
        corpusUsedHash: record.corpus!.corpus_used_hash,
        reused: true,
        dossiers,
        trends: new Map(
          saved.trends.map((t) => [
            t.id,
            { centroid: fromBase64(t.centroid), itemIds: t.item_ids },
          ]),
        ),
      };
    }
  }
  NodeFS.mkdirSync(dir, { recursive: true });
  let emitted: ReadonlyArray<EmittedTrend> = [];
  const record = await runEngine({
    corpusDir,
    cutoff: cutoffAt,
    profilePath: options.profilePath,
    outDir: dir,
    config,
    embedder: args.embedder,
    stack: args.stack,
    log: args.log,
    ...(options.allowUnverifiedCorpus ? { allowUnverifiedCorpus: true } : {}),
    // The stack replay keeps mutating its signals at later cutoffs: copy them now.
    onEmitted: (trends) => {
      emitted = trends.map((t) => ({
        id: t.id,
        centroid: Float32Array.from(t.centroid),
        itemIds: [...t.itemIds],
      }));
    },
  });
  if (record.status !== "ok") {
    throw new Error(`run ${record.run_id} at ${cutoffAt} failed: ${record.error}`);
  }
  const runPath = runDir(dir, record);
  NodeFS.writeFileSync(
    sidecar,
    `${JSON.stringify({
      key,
      run_id: record.run_id,
      trends: emitted.map((t) => ({
        id: t.id,
        centroid: toBase64(t.centroid),
        item_ids: t.itemIds,
      })),
    })}\n`,
  );
  args.log(
    `pool: ${cutoffAt.slice(0, 10)} ${configHash.slice(7, 19)} ${record.dossiers} dossiers (${record.duration_ms} ms)`,
  );
  return {
    runId: record.run_id,
    runDir: runPath,
    logicalHash: record.logical_hash!,
    corpusUsedHash: record.corpus!.corpus_used_hash,
    reused: false,
    dossiers: readRun(runPath).dossiers,
    trends: new Map(emitted.map((t) => [t.id, { centroid: t.centroid, itemIds: t.itemIds }])),
  };
}

export interface TopicCard {
  readonly card_id: string;
  readonly unit: "topic";
  readonly topic_id: string;
  readonly cutoff: string;
  readonly terms: ReadonlyArray<string>;
  readonly headlines: ReadonlyArray<Headline>;
}

/** An item card (P1.1 rule 11): one headline and its excerpt, for the judge's item calibration. */
export interface ItemCard {
  readonly card_id: string;
  readonly unit: "item";
  readonly item_id: string;
  readonly source: string;
  readonly published_at: string;
  readonly title: string;
  readonly excerpt: string;
  readonly cutoff?: string;
  readonly question?: string;
}

export type Card = TopicCard | ItemCard;

export function readUniverse(path: string): Universe {
  const universe = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Universe;
  if (universe.schema_version !== UNIVERSE_SCHEMA_VERSION) {
    throw new Error(`${path} is not ${UNIVERSE_SCHEMA_VERSION}`);
  }
  if (sha256(canonicalJson(universe.logical)) !== universe.universe_hash) {
    throw new Error(`${path}: universe_hash does not match its content`);
  }
  return universe;
}

export function readRankings(path: string): Rankings {
  const rankings = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Rankings;
  if (rankings.schema_version !== RANKINGS_SCHEMA_VERSION) {
    throw new Error(`${path} is not ${RANKINGS_SCHEMA_VERSION}`);
  }
  if (sha256(canonicalJson(rankings.logical)) !== rankings.rankings_hash) {
    throw new Error(`${path}: rankings_hash does not match its content`);
  }
  return rankings;
}

/**
 * Blind topic cards: terms, headlines and cutoff only. Shuffled with a fixed seed. With `sample`,
 * N cards are taken round-robin over the families (families and their topics shuffled with the
 * seed), so a recurrent family does not fill the sample, and the chosen cards are shuffled again.
 */
export function buildTopicCards(
  universe: Universe,
  options: {
    readonly seed: number;
    readonly cutoffs?: ReadonlyArray<string>;
    readonly sample?: number;
  },
): Array<TopicCard> {
  const allowed = options.cutoffs ? new Set(options.cutoffs.map((c) => c.slice(0, 10))) : null;
  const cards = universe.logical.topics
    .filter((t) => allowed === null || allowed.has(t.cutoff))
    .map((t): TopicCard => ({
      card_id: t.card_id,
      unit: "topic",
      topic_id: t.topic_id,
      cutoff: t.cutoff,
      terms: t.terms,
      headlines: t.headlines,
    }));
  const shuffled = seededShuffle(cards, options.seed);
  if (options.sample === undefined) return shuffled;
  const familyOf = new Map(universe.logical.topics.map((t) => [t.topic_id, t.family_id]));
  const byFamily = new Map<string, Array<TopicCard>>();
  for (const card of shuffled) {
    const family = familyOf.get(card.topic_id)!;
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family)!.push(card);
  }
  const queues = seededShuffle([...byFamily.keys()].toSorted(), options.seed + 1).map((family) =>
    byFamily.get(family)!,
  );
  const chosen: Array<TopicCard> = [];
  for (
    let round = 0;
    chosen.length < options.sample && queues.some((q) => q.length > round);
    round++
  ) {
    for (const queue of queues) {
      if (chosen.length >= options.sample) break;
      if (queue[round]) chosen.push(queue[round]!);
    }
  }
  return seededShuffle(chosen, options.seed + 2);
}

/** Refuses prospective topics whose universe and rankings were not sealed in the ledger. */
export function assertSealed(
  universe: Universe,
  cards: ReadonlyArray<TopicCard>,
  ledgerPath?: string,
) {
  const prospective = new Set(
    universe.logical.cutoffs.filter((c) => c.prospective).map((c) => c.cutoff),
  );
  if (!cards.some((card) => prospective.has(card.cutoff))) return;
  if (!ledgerPath) throw new Error("prospective cards need --ledger with a rankings seal");
  const sealed = readLedger(ledgerPath).some(
    (e) => e.kind === "rankings" && e["universe_hash"] === universe.universe_hash,
  );
  if (!sealed) throw new Error(`universe ${universe.universe_hash} is not sealed in ${ledgerPath}`);
}

export function writeCardSet(
  cards: ReadonlyArray<Card>,
  outDir: string,
  name: string,
  meta: { readonly universeHash?: string; readonly title: string },
): { jsonl: string; html: string; cardsHash: string } {
  NodeFS.mkdirSync(outDir, { recursive: true });
  const text = cards.map((card) => `${JSON.stringify(card)}\n`).join("");
  const cardsHash = sha256(text);
  const jsonl = NodePath.join(outDir, `${name}.jsonl`);
  const html = NodePath.join(outDir, `${name}.html`);
  NodeFS.writeFileSync(jsonl, text);
  NodeFS.writeFileSync(
    html,
    renderCardsHtml(cards, {
      setName: name,
      title: meta.title,
      cardsHash,
      universeHash: meta.universeHash ?? null,
    }),
  );
  return { jsonl, html, cardsHash };
}

export function readCardsJsonl(path: string): Array<Card> {
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Card);
}

export { parseCutoffList };
