// @effect-diagnostics nodeBuiltinImport:off - fixture writer for the lab's end-to-end command and tests.
// A small corpus/1 with six topics whose growth, authors and fit pull the weighted score apart,
// a profile and a configuration the fingerprint embedder can reach, and synthetic labels in the
// format of Miguel's cards. Synthetic: it proves the mechanism, never editorial quality.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { hashCorpus } from "@earlyscript/trend-engine/corpus";
import { DEFAULT_CONFIG_PATH, loadConfig } from "@earlyscript/trend-engine/run";

import { sha256 } from "./hash.ts";

const DAY_MS = 86_400_000;
const dayAt = (from: string, k: number) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + k * DAY_MS).toISOString().slice(0, 10);

interface Topic {
  readonly key: string;
  readonly title: string;
  /** Items on day k of the corpus. */
  readonly count: (k: number) => number;
  /** Distinct authors cycled through. */
  readonly authors: number;
  readonly label: "yes" | "no";
  readonly grade: "core" | "adjacent" | null;
}

const TOPICS: ReadonlyArray<Topic> = [
  // Steep growth from two authors: favoured by the growth weight.
  {
    key: "rust",
    title: "Rust compiler agents ship incremental builds",
    count: (k) => Math.round(0.25 * 1.22 ** k),
    authors: 2,
    label: "yes",
    grade: "adjacent",
  },
  // Slower growth from many authors: favoured by the authors weight. What the channel wants.
  {
    key: "founders",
    title: "Solo founders build startups with coding agents",
    count: (k) => Math.round(0.6 * 1.15 ** k),
    authors: 12,
    label: "yes",
    grade: "core",
  },
  {
    key: "agents",
    title: "Autonomous agent frameworks for small teams",
    count: (k) => Math.round(0.4 * 1.17 ** k),
    authors: 9,
    label: "yes",
    grade: "core",
  },
  {
    key: "gpu",
    title: "GPU inference kernels cut model serving latency",
    count: (k) => 2 + (k % 2),
    authors: 6,
    label: "yes",
    grade: "adjacent",
  },
  {
    key: "garden",
    title: "Tomato garden soil watering tips",
    count: (k) => Math.round(0.3 * 1.2 ** k),
    authors: 3,
    label: "no",
    grade: null,
  },
  {
    key: "football",
    title: "Football league scores weekend results",
    count: (k) => 1 + (k % 2),
    authors: 4,
    label: "no",
    grade: null,
  },
  // On-profile words, steep growth from one or two accounts, not what the channel wants.
  {
    key: "airdrop",
    title: "Agent token airdrop for coding agents traders",
    count: (k) => Math.round(0.2 * 1.26 ** k),
    authors: 1,
    label: "no",
    grade: null,
  },
  {
    key: "drama",
    title: "Rust compiler benchmark drama on social media",
    count: (k) => Math.round(0.2 * 1.25 ** k),
    authors: 2,
    label: "no",
    grade: null,
  },
  {
    key: "revenue",
    title: "Founders share revenue numbers of agent startups",
    count: (k) => Math.round(0.7 * 1.13 ** k),
    authors: 15,
    label: "yes",
    grade: "core",
  },
];

export const SYNTHETIC_PROFILE = {
  schema_version: "profile/1",
  name: "Synthetic channel",
  version: 1,
  audience: "founders building with agents",
  include: [
    "solo founders build startups with coding agents",
    "autonomous agent frameworks",
    "rust compiler agents",
    "gpu inference kernels",
  ],
  exclude: ["football league scores", "tomato garden"],
} as const;

export interface SyntheticCorpus {
  readonly corpus_dir: string;
  readonly profile_path: string;
  readonly profile_hash: string;
  readonly config_path: string;
  readonly cards_path: string;
  readonly labels_path: string;
  /** Daily cutoffs with a week of history behind them. */
  readonly cutoffs: ReadonlyArray<string>;
}

interface WrittenItem {
  readonly id: string;
  readonly source: "hn";
  readonly published_at: string;
  readonly title: string;
  readonly topic: string;
}

export function writeSyntheticCorpus(input: {
  readonly dir: string;
  readonly fromDay: string;
  readonly days: number;
}): SyntheticCorpus {
  const corpusDir = NodePath.join(input.dir, "corpus");
  const retrieved = `${dayAt(input.fromDay, input.days)}T01:00:00.000Z`;
  NodeFS.mkdirSync(NodePath.join(corpusDir, "hn"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(corpusDir, "github"), { recursive: true });
  const items: Array<WrittenItem> = [];
  const coverage: Array<string> = [];
  for (let k = 0; k < input.days; k++) {
    const day = dayAt(input.fromDay, k);
    const dayItems: Array<{ published_at: string; id: string; line: string }> = [];
    let n = 0;
    for (const topic of TOPICS) {
      const count = topic.count(k);
      for (let c = 0; c < count; c++) {
        n++;
        const id = `itm_hn_${day.replaceAll("-", "")}${String(n).padStart(3, "0")}`;
        const published = `${day}T${String((n * 2) % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00.000Z`;
        const author = `${topic.key}${(k + c) % topic.authors}`;
        const item = {
          id,
          source: "hn",
          permalink: `https://example.test/${id}`,
          external_url: `https://example.test/out/${id}`,
          published_at: published,
          author,
          title: topic.title,
          body: "",
          body_length: 0,
          truncated: false,
          retrieved_at: retrieved,
          entities: [],
        };
        dayItems.push({ published_at: published, id, line: JSON.stringify(item) });
        items.push({
          id,
          source: "hn",
          published_at: published,
          title: topic.title,
          topic: topic.key,
        });
      }
    }
    // corpus/1 days are sorted by publication time.
    const lines = dayItems
      .toSorted((a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id))
      .map((entry) => entry.line);
    NodeFS.writeFileSync(
      NodePath.join(corpusDir, "hn", `${day}.jsonl`),
      lines.map((l) => `${l}\n`).join(""),
    );
    NodeFS.writeFileSync(NodePath.join(corpusDir, "github", `${day}.jsonl`), "");
    coverage.push(
      JSON.stringify({
        source: "hn",
        day,
        status: "complete",
        items: lines.length,
        retrieved_at: retrieved,
        note: null,
      }),
    );
    coverage.push(
      JSON.stringify({
        source: "github",
        day,
        status: "complete",
        items: 0,
        retrieved_at: retrieved,
        note: null,
      }),
    );
  }
  NodeFS.writeFileSync(
    NodePath.join(corpusDir, "coverage.jsonl"),
    coverage.map((l) => `${l}\n`).join(""),
  );
  const fields = {
    schema_version: "corpus/1" as const,
    from_day: input.fromDay,
    to_day: dayAt(input.fromDay, input.days),
    selection_bias: "present_stars" as const,
    selection: { hn: "synthetic", github: "synthetic", to_day: "exclusive" },
  };
  const files = listFiles(corpusDir).map((path) => {
    const bytes = NodeFS.readFileSync(NodePath.join(corpusDir, path));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
  NodeFS.writeFileSync(
    NodePath.join(corpusDir, "corpus-manifest.json"),
    `${JSON.stringify({ ...fields, files, corpus_hash: hashCorpus({ ...fields, files }), written_at: retrieved }, null, 2)}\n`,
  );

  const profileBytes = `${JSON.stringify(SYNTHETIC_PROFILE, null, 2)}\n`;
  const profilePath = NodePath.join(input.dir, "profile.json");
  NodeFS.writeFileSync(profilePath, profileBytes);
  const { config } = loadConfig(DEFAULT_CONFIG_PATH);
  const synthetic = {
    ...config,
    sources: ["hn", "github"],
    profile: { include_min: 0.3, exclude_max: 0.6 },
  };
  const configPath = NodePath.join(input.dir, "engine.synthetic.json");
  NodeFS.writeFileSync(configPath, `${JSON.stringify(synthetic, null, 2)}\n`);

  // Cards and labels in the format of Miguel's (calibracion-100.jsonl, labels-miguel.json).
  const cutoffs: Array<string> = [];
  for (let k = 14; k < input.days; k++) cutoffs.push(`${dayAt(input.fromDay, k)}T00:00:00.000Z`);
  const cards: Array<string> = [];
  const labels: Array<Record<string, unknown>> = [];
  for (const cutoff of cutoffs) {
    const day = cutoff.slice(0, 10);
    for (const topic of TOPICS) {
      const recent = items
        .filter((item) => item.topic === topic.key && item.published_at.slice(0, 10) < day)
        .toSorted((a, b) => (a.published_at < b.published_at ? 1 : -1))
        .slice(0, 5);
      if (recent.length === 0) continue;
      const topicId = `top_${sha256(`${day}\n${topic.key}`).slice(7, 23)}`;
      const cardId = `card_${sha256(`card\n${topicId}`).slice(7, 19)}`;
      cards.push(
        JSON.stringify({
          card_id: cardId,
          unit: "topic",
          topic_id: topicId,
          cutoff: day,
          terms: topic.title.toLowerCase().split(" "),
          headlines: recent.map((item) => ({
            title: item.title,
            source: item.source,
            published_at: item.published_at,
          })),
        }),
      );
      labels.push({
        card_id: cardId,
        unit: "topic",
        topic_id: topicId,
        cutoff: day,
        label: topic.label,
        grade: topic.grade,
      });
    }
  }
  const cardsPath = NodePath.join(input.dir, "cards.jsonl");
  NodeFS.writeFileSync(cardsPath, cards.map((l) => `${l}\n`).join(""));
  const labelsPath = NodePath.join(input.dir, "labels.json");
  NodeFS.writeFileSync(
    labelsPath,
    `${JSON.stringify({ schema_version: "earlyscript.editorial-labels/1", labeler: "synthetic", set_name: "synthetic", labels }, null, 2)}\n`,
  );
  return {
    corpus_dir: corpusDir,
    profile_path: profilePath,
    profile_hash: sha256(profileBytes),
    config_path: configPath,
    cards_path: cardsPath,
    labels_path: labelsPath,
    cutoffs,
  };
}

function listFiles(root: string, prefix = ""): Array<string> {
  return NodeFS.readdirSync(NodePath.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(root, relative) : [relative];
    })
    .toSorted();
}
