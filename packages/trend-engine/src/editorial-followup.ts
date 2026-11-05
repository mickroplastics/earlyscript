// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - plain library over files the pool writes.
// `engine eval-editorial hn-labels`: the secondary HN follow-up label of every topic of a frozen
// universe (P1.1 rule 9). Each topic takes the follow-up stories whose cosine with its own
// centroid is above the cluster threshold, without competing with other topics, so adding
// topics or arms never changes another topic's label. A negative needs the whole 14-day window
// captured as complete; until then the label is `pending`, never `no`.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { crossingLabel, type Story } from "./backtest-label.ts";
import { LABEL_RULE } from "./backtest-report.ts";
import { dot } from "./cluster.ts";
import { readCorpus } from "./corpus.ts";
import { DAY_MS, dayOf, dayStart } from "./days.ts";
import { LABELS_SCHEMA_VERSION } from "./editorial-cards-html.ts";
import { fromBase64, readUniverse, type Universe } from "./editorial-eval.ts";
import type { LabelValue } from "./editorial-stats.ts";
import { createLocalEmbedder } from "./embed/local.ts";
import { defaultModelDir } from "./embed/model.ts";
import { type Embedder, embeddingSpec } from "./embed/spec.ts";
import { sha256 } from "./hash.ts";
import { prepare } from "./prepare.ts";
import { DEFAULT_DATA_DIR } from "./run.ts";
import { fixtureSources } from "./sources/index.ts";

export const HN_LABELER = "hn-followup";

export interface FollowupLabel {
  readonly topic_id: string;
  readonly card_id: string;
  readonly cutoff: string;
  readonly label: LabelValue;
  readonly followup_stories: number;
  readonly followup_authors: number;
  readonly event_day: string | null;
  readonly complete_days: number;
}

/** Labels of every topic against stories already prepared and embedded (pure, for tests). */
export function followupLabels(
  universe: Universe,
  centroids: ReadonlyMap<string, Float32Array>,
  stories: ReadonlyArray<Story>,
  completeDays: ReadonlySet<string>,
): Array<FollowupLabel> {
  const threshold = universe.logical.inputs.followup_threshold;
  return universe.logical.topics.map((topic) => {
    const centroid = centroids.get(topic.topic_id);
    if (!centroid) throw new Error(`no centroid for ${topic.topic_id}`);
    // A prospective cutoff was decided at its capture's closing time (U1-S1): its follow-up
    // starts there, not at 00:00, so a story already published at the decision is not "later".
    const info = universe.logical.cutoffs?.find((c) => c.cutoff === topic.cutoff);
    const cutoffMs = info?.prospective
      ? Date.parse(info.operational_cutoff_at)
      : dayStart(topic.cutoff);
    const endMs = cutoffMs + LABEL_RULE.followup_days * DAY_MS;
    const tail = stories
      .filter(
        (s) =>
          s.publishedMs >= cutoffMs && s.publishedMs < endMs && dot(s.vector, centroid) > threshold,
      )
      .toSorted(
        (a, b) => a.publishedMs - b.publishedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const label = crossingLabel(tail, cutoffMs, LABEL_RULE.event_stories, LABEL_RULE.event_authors);
    const window = Array.from(
      { length: LABEL_RULE.followup_days + (info?.prospective ? 1 : 0) },
      (_, k) => dayOf(cutoffMs + k * DAY_MS),
    );
    const complete = window.filter((d) => completeDays.has(d)).length;
    return {
      topic_id: topic.topic_id,
      card_id: topic.card_id,
      cutoff: topic.cutoff,
      label: label.positive ? "yes" : complete >= window.length ? "no" : "pending",
      followup_stories: label.followup_stories,
      followup_authors: label.followup_authors,
      event_day: label.event_day,
      complete_days: complete,
    };
  });
}

/** When a cutoff's follow-up starts: its capture's closing time when prospective (U1-S1). */
const followupStart = (c: {
  cutoff: string;
  prospective: boolean;
  operational_cutoff_at: string;
}) => (c.prospective ? Date.parse(c.operational_cutoff_at) : dayStart(c.cutoff));

/**
 * The stories the labels need (Sol, motor-v2 S4): up to the latest follow-up end, taken from the
 * operational instants, and every day file that holds part of it, the last partial day included.
 */
export function followupSpan(universe: Universe): { endMs: number; untilDay: string } {
  const endMs = Math.max(
    ...universe.logical.cutoffs.map((c) => followupStart(c) + LABEL_RULE.followup_days * DAY_MS),
  );
  return { endMs, untilDay: dayOf(Math.ceil(endMs / DAY_MS) * DAY_MS) };
}

export async function writeFollowupLabels(options: {
  readonly universePath: string;
  readonly corpusDir: string;
  readonly out: string;
  readonly embedder?: Embedder;
  readonly cacheFile?: string;
  readonly cacheOnly?: boolean;
  readonly modelDir?: string;
  readonly workers?: number;
  readonly allowUnverifiedCorpus?: boolean;
  readonly log?: (line: string) => void;
}) {
  const universe = readUniverse(options.universePath);
  const centroidFile = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(NodePath.dirname(options.universePath), "centroids.json"),
      "utf8",
    ),
  ) as { embedding_key: string; topics: Record<string, string> };
  const centroids = new Map(
    Object.entries(centroidFile.topics).map(([id, b64]) => [id, fromBase64(b64)]),
  );
  const config = Object.values(universe.logical.inputs.configs)[0]!;
  const sources: Array<SourceId> = ["hn"];
  const { endMs, untilDay } = followupSpan(universe);
  const corpus = await readCorpus({
    dir: options.corpusDir,
    adapters: fixtureSources(options.corpusDir, sources),
    untilDay,
    ...(options.allowUnverifiedCorpus ? { allowUnverified: true } : {}),
  });
  const firstMs = dayStart(universe.logical.cutoffs.map((c) => c.cutoff).toSorted()[0]!);
  const prepared = prepare(
    corpus.items.filter((item) => Date.parse(item.published_at) < endMs),
    universe.logical.inputs.text,
  ).filter((item) => item.excluded === null && item.publishedMs >= firstMs);
  const embedder =
    options.embedder ??
    createLocalEmbedder(embeddingSpec(config.embedder), {
      cacheFile:
        options.cacheFile ?? NodePath.join(DEFAULT_DATA_DIR, "embeddings/embeddings.sqlite"),
      modelDir: options.modelDir ?? defaultModelDir(DEFAULT_DATA_DIR, config.embedder.revision),
      workers: options.workers ?? 2,
      allowDownload: true,
      cacheOnly: options.cacheOnly ?? false,
      ...(options.log ? { log: options.log } : {}),
    });
  let vectors: Array<Float32Array>;
  try {
    if (embedder.key !== centroidFile.embedding_key)
      throw new Error("embedder differs from the universe's");
    vectors = await embedder.embed(prepared.map((item) => item.text));
  } finally {
    await embedder.dispose();
  }
  const stories: Array<Story> = prepared.map((item, k) => ({
    id: item.id,
    publishedMs: item.publishedMs,
    author: item.author,
    vector: vectors[k]!,
  }));
  const completeDays = new Set(
    corpus.coverage.filter((r) => r.source === "hn" && r.status === "complete").map((r) => r.day),
  );
  const labels = followupLabels(universe, centroids, stories, completeDays);
  const out = {
    schema_version: LABELS_SCHEMA_VERSION,
    labeler: HN_LABELER,
    universe_hash: universe.universe_hash,
    rule: {
      ...LABEL_RULE,
      threshold: universe.logical.inputs.followup_threshold,
      assignment:
        "non-exclusive: every story above the threshold against the topic's own anchor centroid",
      negative: `only with all ${LABEL_RULE.followup_days} follow-up days captured complete; otherwise pending`,
    },
    corpus_manifest_hash: corpus.manifestHash,
    corpus_used_hash: corpus.usedHash,
    created_at: new Date().toISOString(),
    labels: labels.map((l) => ({ ...l, unit: "topic" as const })),
  };
  NodeFS.mkdirSync(NodePath.dirname(options.out), { recursive: true });
  NodeFS.writeFileSync(options.out, `${JSON.stringify(out, null, 2)}\n`);
  return { path: options.out, sha256: sha256(NodeFS.readFileSync(options.out)), labels };
}
