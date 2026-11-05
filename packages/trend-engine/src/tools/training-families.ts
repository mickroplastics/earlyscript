// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off globalDate:off - offline tool.
//   node src/tools/training-families.ts --corpus <dir> --sample sample.jsonl --cutoff 2026-10-13 \
//     --cache <sqlite> --out training-families.jsonl [--config <engine config>]
// Registry of the topic families the relevance probe saw in training (Sol U2-S2). Rule: stack
// every item before the cutoff exactly as a run does (same preparation, vectors, threshold
// and window); a family is a signal with at least one training item. Each line keeps the
// signal id, its training items and its centroid, so a later cut can tell a family seen in
// training by the same signal id (stacking is incremental, so a family keeps its id) or by a
// centroid cosine above the dedup threshold. The summary line has the registry's hash.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";

import { type StackedSignal, stackItems } from "../cluster.ts";
import { readCorpus } from "../corpus.ts";
import { topTerms } from "../dossier.ts";
import { createLocalEmbedder } from "../embed/local.ts";
import { embeddingSpec } from "../embed/spec.ts";
import { sha256 } from "../hash.ts";
import { prepare, type PreparedItem } from "../prepare.ts";
import { DEFAULT_CONFIG_PATH, DEFAULT_DATA_DIR, loadConfig, parseCutoff } from "../run.ts";
import { fixtureSources } from "../sources/index.ts";

export interface TrainingFamily {
  readonly signal_id: string;
  readonly first_seen_at: string;
  readonly items_total: number;
  readonly training_items: Array<string>;
  readonly terms: Array<string>;
  /** Little-endian float32 centroid at the cutoff, base64. */
  readonly centroid: string;
}

export function trainingFamilies(
  signals: ReadonlyArray<StackedSignal>,
  items: ReadonlyMap<string, PreparedItem>,
  trainIds: ReadonlySet<string>,
): Array<TrainingFamily> {
  return signals
    .filter((s) => s.itemIds.some((id) => trainIds.has(id)))
    .map((s) => ({
      signal_id: s.id,
      first_seen_at: new Date(s.firstMs).toISOString(),
      items_total: s.itemIds.length,
      training_items: s.itemIds.filter((id) => trainIds.has(id)).toSorted(),
      terms: topTerms(
        s.itemIds.map((id) => `${items.get(id)!.title} ${items.get(id)!.cleanBody}`),
        6,
      ),
      centroid: Buffer.from(
        s.centroid.buffer,
        s.centroid.byteOffset,
        s.centroid.byteLength,
      ).toString("base64"),
    }))
    .toSorted((a, b) => (a.signal_id < b.signal_id ? -1 : 1));
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      corpus: { type: "string" },
      sample: { type: "string" },
      cutoff: { type: "string" },
      cache: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
    },
  });
  if (!values.corpus || !values.sample || !values.cutoff || !values.out) {
    console.error(
      "usage: training-families --corpus <dir> --sample <jsonl> --cutoff <day> --cache <sqlite> --out <jsonl>",
    );
    return 64;
  }
  const { config, hash: configHash } = loadConfig(values.config ?? DEFAULT_CONFIG_PATH);
  const { cutoffMs, cutoffDay } = parseCutoff(`${values.cutoff}T00:00:00Z`);
  const corpus = await readCorpus({
    dir: values.corpus,
    adapters: fixtureSources(values.corpus, config.sources),
    untilDay: cutoffDay,
  });
  const kept = prepare(
    corpus.items.filter((i) => Date.parse(i.published_at) < cutoffMs),
    config.text,
  ).filter((i) => i.excluded === null);
  const embedder = createLocalEmbedder(embeddingSpec(config.embedder), {
    cacheFile: values.cache ?? `${DEFAULT_DATA_DIR}/embeddings/embeddings.sqlite`,
    modelDir: "",
    workers: 1,
    cacheOnly: true,
  });
  let vectors: Array<Float32Array>;
  try {
    vectors = await embedder.embed(kept.map((i) => i.text));
  } finally {
    await embedder.dispose();
  }
  const stacked = stackItems(
    kept.map((item, k) => ({ id: item.id, publishedMs: item.publishedMs, vector: vectors[k]! })),
    config.cluster.threshold,
    config.cluster.active_days,
  );
  const trainIds = new Set(
    NodeFS.readFileSync(values.sample, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => (JSON.parse(l) as { id: string }).id),
  );
  const families = trainingFamilies(stacked.signals, new Map(kept.map((i) => [i.id, i])), trainIds);
  const text = families.map((f) => `${JSON.stringify(f)}\n`).join("");
  NodeFS.writeFileSync(values.out, text);
  console.log(
    JSON.stringify({
      rule: "signals stacked from every item before the cutoff with the run's preparation, vectors, cluster threshold and window; a family has at least one training item",
      cutoff: cutoffDay,
      config_hash: configHash,
      corpus_used_hash: corpus.usedHash,
      sample_sha256: sha256(NodeFS.readFileSync(values.sample)),
      families: families.length,
      training_items_covered: families.reduce((n, f) => n + f.training_items.length, 0),
      registry_sha256: sha256(text),
    }),
  );
  return 0;
}

if (import.meta.main) process.exitCode = await main();
