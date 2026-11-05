// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - plain library; the model file is decoded with Schema.
// Learned editorial relevance of an item: a logistic probe over the item's Qwen vector,
// trained offline on judge labels (src/tools/relevance-train.ts) and frozen in a file
// whose hash the configuration names. At run time it is one dot product per item: no
// network and no language model.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { sha256 } from "./hash.ts";

export const RELEVANCE_SCHEMA_VERSION = "earlyscript.relevance/1";

export const RelevanceModel = Schema.Struct({
  schema_version: Schema.Literal(RELEVANCE_SCHEMA_VERSION),
  model_id: Schema.String,
  method: Schema.String,
  /** The embedder whose vectors the probe reads; platform and runtime are informative only. */
  embedding: Schema.Struct({
    model: Schema.String,
    revision: Schema.String,
    dtype: Schema.String,
    pooling: Schema.String,
  }),
  weights: Schema.Array(Schema.Number),
  bias: Schema.Number,
  /** Probability at which an item counts as relevant, chosen in cross-validation. */
  threshold: Schema.Number,
  training: Schema.Record(Schema.String, Schema.Unknown),
  cv: Schema.Record(Schema.String, Schema.Unknown),
});
export type RelevanceModel = typeof RelevanceModel.Type;

const decodeModel = Schema.decodeUnknownSync(RelevanceModel);

export interface LoadedRelevance {
  readonly model: RelevanceModel;
  /** sha256 of the file bytes, as the configuration records it. */
  readonly hash: string;
  readonly weights: Float64Array;
}

export function parseRelevanceModel(bytes: Uint8Array): LoadedRelevance {
  const model = decodeModel(JSON.parse(new TextDecoder().decode(bytes)));
  if (!model.weights.every(Number.isFinite) || !Number.isFinite(model.bias))
    throw new Error(`relevance model ${model.model_id} has non-finite weights`);
  return { model, hash: sha256(bytes), weights: Float64Array.from(model.weights) };
}

/**
 * Loads the model a configuration names, from the directory beside the configuration
 * files, and refuses it unless its bytes match the recorded hash and its embedder is the
 * run's: a probe trained on other vectors would score noise.
 */
export function loadRelevance(
  ref: NonNullable<EngineConfig["relevance"]>,
  embedder: EngineConfig["embedder"],
  configDir: string,
): LoadedRelevance {
  if (NodePath.basename(ref.model) !== ref.model)
    throw new Error(`relevance model ${ref.model} must be a file name in ${configDir}`);
  const loaded = parseRelevanceModel(NodeFS.readFileSync(NodePath.join(configDir, ref.model)));
  if (loaded.hash !== ref.sha256)
    throw new Error(`${ref.model} does not match the sha256 the configuration records`);
  checkEmbedding(loaded, embedder);
  return loaded;
}

export function checkEmbedding(loaded: LoadedRelevance, embedder: EngineConfig["embedder"]) {
  const e = loaded.model.embedding;
  if (
    e.model !== embedder.model ||
    e.revision !== embedder.revision ||
    e.dtype !== embedder.dtype ||
    e.pooling !== embedder.pooling
  )
    throw new Error(`relevance model ${loaded.model.model_id} was trained on another embedder`);
}

export const sigmoid = (z: number): number =>
  z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));

export type RelevanceAggregate = "mean" | "share" | "trimmed_mean";

/** A trend's relevance from its items' relevance. */
export function aggregateRelevance(
  values: ReadonlyArray<number>,
  aggregate: RelevanceAggregate,
  itemMin: number,
): number {
  if (values.length === 0) return 0;
  if (aggregate === "share") return values.filter((v) => v >= itemMin).length / values.length;
  const sorted = aggregate === "trimmed_mean" ? values.toSorted((a, b) => a - b) : [...values];
  const cut = aggregate === "trimmed_mean" ? Math.floor(sorted.length / 5) : 0;
  const kept = sorted.slice(cut, sorted.length - cut);
  return kept.reduce((sum, v) => sum + v, 0) / kept.length;
}

/** Distinct titles, case and digits ignored: versions of one package or repost of one story count once. */
export const distinctTitles = (titles: ReadonlyArray<string>): number =>
  new Set(
    titles.map((t) =>
      t
        .toLowerCase()
        .replace(/[\d.]+/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ),
  ).size;

/** sigmoid(w·x + b), summed in float64 in index order so it is the same on every run. */
export function relevanceOf(loaded: LoadedRelevance, vector: Float32Array): number {
  const w = loaded.weights;
  if (vector.length !== w.length)
    throw new Error(`relevance model expects ${w.length} dimensions, got ${vector.length}`);
  let z = loaded.model.bias;
  for (let i = 0; i < w.length; i++) z += w[i]! * vector[i]!;
  return sigmoid(z);
}
