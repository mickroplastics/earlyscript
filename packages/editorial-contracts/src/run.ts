import * as Schema from "effect/Schema";

import { EmbeddingSpec } from "./dossier.ts";
import { DataGap, SourceCoverage, SourceId } from "./source.ts";

export const RUN_SCHEMA_VERSION = "earlyscript.run/1";

const Weights = Schema.Record(Schema.String, Schema.Number);

/** Everything that changes a run's result except the corpus, the cutoff and the profile. */
export const EngineConfig = Schema.Struct({
  config_version: Schema.String,
  sources: Schema.Array(SourceId).check(Schema.isMinLength(1)),
  embedder: Schema.Struct({
    model: Schema.String,
    revision: Schema.String,
    dtype: Schema.String,
    pooling: Schema.Literals(["last_token", "mean"]),
    batch_size: Schema.Literal(1),
    intra_op_threads: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  profile: Schema.Struct({
    include_min: Schema.Number,
    exclude_max: Schema.Number,
    /** Qwen3 query instruction: topics are embedded as `Instruct: <this>\nQuery:<topic>`. Absent, as documents. */
    query_instruction: Schema.optionalKey(Schema.String),
  }),
  text: Schema.Struct({
    max_body_chars: Schema.Int,
    min_ascii_letter_ratio: Schema.Number,
    excerpt_chars: Schema.Int,
  }),
  cluster: Schema.Struct({ threshold: Schema.Number, active_days: Schema.Int }),
  stage: Schema.Struct({
    context_days: Schema.Int,
    growth_min: Schema.Number,
    growing_min_items_7d: Schema.Int,
    fading_max: Schema.Number,
    /**
     * all_sources: a gap in any source leaves every trend unclassified (Earlywindow v0.02).
     * per_source and equivalent (growth from per-day rates of sources fully collected in
     * both windows): see series.ts.
     */
    coverage_rule: Schema.Literals(["all_sources", "per_source", "equivalent"]),
  }),
  /**
   * Learned item relevance (relevance.ts). Present, a signal's stage counts only relevant
   * items and a trend is eligible when growing with relevance >= signal_min.
   */
  relevance: Schema.optionalKey(
    Schema.Struct({
      /** File name beside the configuration files. */
      model: Schema.String,
      /** sha256 of the model file: the configuration hash covers the weights. */
      sha256: Schema.String,
      /** An item with relevance >= item_min counts in the series. */
      item_min: Schema.Number,
      /** A growing trend whose mean recent relevance is >= signal_min is eligible. */
      signal_min: Schema.Number,
      /** Keep the profile affinity gate as well (profile.include_min, profile.exclude_max). */
      profile_gate: Schema.Boolean,
    }),
  ),
  rank: Schema.Struct({
    baseline: Schema.Struct({ method: Schema.String, weights: Weights }),
    weighted: Schema.Struct({ method: Schema.String, weights: Weights }),
  }),
  emit: Schema.Struct({
    max_dossiers: Schema.Int,
    max_evidence: Schema.Int,
    thin_below: Schema.Int,
    label_terms: Schema.Int,
    top_terms: Schema.Int,
    curve_days: Schema.Int,
    /** A trend whose centroid has a cosine above this with a better-ranked one is emitted as related, without a position. */
    dedup_cosine: Schema.optionalKey(Schema.Number),
    /**
     * Fewer eligible trends than this are filled with the most relevant growing ones below
     * signal_min, then steady ones, so a cut never abstains below it. Needs `relevance`.
     */
    min_dossiers: Schema.optionalKey(Schema.Int),
  }),
});
export type EngineConfig = typeof EngineConfig.Type;

/** Corrida: run.json. `logical_hash` covers the dossiers and signals without run ids or timestamps. */
export const RunRecord = Schema.Struct({
  schema_version: Schema.Literal(RUN_SCHEMA_VERSION),
  run_id: Schema.String,
  status: Schema.Literals(["ok", "failed"]),
  error: Schema.NullOr(Schema.String),
  cutoff_at: Schema.String,
  started_at: Schema.String,
  finished_at: Schema.String,
  engine_version: Schema.String,
  config: Schema.NullOr(EngineConfig),
  config_hash: Schema.NullOr(Schema.String),
  corpus: Schema.NullOr(
    Schema.Struct({
      dir: Schema.String,
      /** Day files and coverage rows before the cutoff: what the run read. */
      corpus_used_hash: Schema.String,
      /** The frozen corpus's corpus_hash, from its manifest; no later day file is opened for it. */
      corpus_manifest_hash: Schema.String,
      /** The manifest is self-consistent and every file read matches its entry. */
      verified: Schema.Boolean,
      from_day: Schema.String,
      to_day: Schema.String,
    }),
  ),
  profile: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      name: Schema.String,
      version: Schema.NullOr(Schema.Int),
      hash: Schema.String,
    }),
  ),
  embedding: Schema.NullOr(Schema.Struct({ ...EmbeddingSpec.fields, config_hash: Schema.String })),
  platform: Schema.Struct({
    os: Schema.String,
    arch: Schema.String,
    node: Schema.String,
    cpus: Schema.Int,
  }),
  coverage: Schema.NullOr(
    Schema.Struct({
      window_days: Schema.Int,
      by_source: Schema.Array(SourceCoverage),
      data_gaps: Schema.Array(DataGap),
    }),
  ),
  stats: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  dossiers: Schema.Int,
  files: Schema.Array(Schema.String),
  logical_hash: Schema.NullOr(Schema.String),
  timings_ms: Schema.Record(Schema.String, Schema.Number),
  duration_ms: Schema.Number,
  peak_rss_bytes: Schema.Number,
});
export type RunRecord = typeof RunRecord.Type;
