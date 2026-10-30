import * as Schema from "effect/Schema";

import { ProfileRef } from "./profile.ts";
import { DataGap, SourceCoverage, SourceId, UtcDay } from "./source.ts";

export const DOSSIER_SCHEMA_VERSION = "earlyscript.dossier/1";

export const SignalStage = Schema.Literals(["growing", "steady", "fading", "unclassified"]);
export type SignalStage = typeof SignalStage.Type;

/** The embedder that produced the vectors. platform and arch are null for Earlywindow runs. */
export const EmbeddingSpec = Schema.Struct({
  model: Schema.String,
  revision: Schema.String,
  dtype: Schema.String,
  pooling: Schema.Literals(["last_token", "mean"]),
  batch_size: Schema.Int,
  runtime: Schema.String,
  platform: Schema.NullOr(Schema.String),
  arch: Schema.NullOr(Schema.String),
});
export type EmbeddingSpec = typeof EmbeddingSpec.Type;

export const EngineRef = Schema.Struct({
  version: Schema.String,
  config_hash: Schema.String,
  /** Earlyscript: the hash of the corpus read before the cutoff. Earlywindow: its whole corpus_hash. */
  corpus_hash: Schema.String,
  embedding: EmbeddingSpec,
});
export type EngineRef = typeof EngineRef.Type;

/** Tendencia: a group of semantically close items with recent activity. */
export const Trend = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  label_source: Schema.Literals(["terms", "assistant", "operator"]),
  top_terms: Schema.Array(Schema.String),
  stage: SignalStage,
  corroboration: Schema.Literals(["multi_source", "single_source"]),
  first_seen_at: Schema.String,
  last_seen_at: Schema.NullOr(Schema.String),
  sources: Schema.Array(SourceId),
  /** Items in the group before the cutoff; null when read from a dossier/1 that does not keep it. */
  items_total: Schema.NullOr(Schema.Int),
  items_7d: Schema.Int,
  items_prev_7d: Schema.Int,
  authors_7d: Schema.Int,
  /** ln((items_7d + 1) / (items_prev_7d + 1)). */
  growth: Schema.Number,
});
export type Trend = typeof Trend.Type;

export const ProfileFit = Schema.Struct({
  include_score: Schema.Number,
  exclude_score: Schema.Number,
  passes: Schema.Boolean,
  /** The include topic with the highest cosine; null when read from a dossier/1. */
  nearest_include: Schema.NullOr(Schema.String),
});
export type ProfileFit = typeof ProfileFit.Type;

export const RankComponent = Schema.Struct({
  name: Schema.String,
  value: Schema.NullOr(Schema.Number),
  weight: Schema.Number,
  contribution: Schema.Number,
});
export type RankComponent = typeof RankComponent.Type;

/** One ordering of the run's eligible trends; position 1 is first. */
export const Ranking = Schema.Struct({
  method: Schema.String,
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  score: Schema.Number,
  components: Schema.Array(RankComponent),
});
export type Ranking = typeof Ranking.Type;

export const Rankings = Schema.Struct({
  /** Trends both rankings order: growing and passing the profile. */
  eligible: Schema.Int,
  baseline: Ranking,
  weighted: Ranking,
});
export type Rankings = typeof Rankings.Type;

export const CurvePoint = Schema.Struct({
  day: UtcDay,
  items: Schema.Int,
  sources: Schema.Int,
  authors: Schema.Int,
  /** Every source of the run collected the day, so the count is an observation. */
  known: Schema.Boolean,
});
export type CurvePoint = typeof CurvePoint.Type;

export const Evidence = Schema.Struct({
  item_id: Schema.String,
  source: SourceId,
  permalink: Schema.String,
  external_url: Schema.NullOr(Schema.String),
  published_at: Schema.String,
  author: Schema.NullOr(Schema.String),
  title: Schema.String,
  excerpt: Schema.String,
  retrieved_at: Schema.String,
  /** Cosine to the trend centroid; null when read from a dossier/1. */
  similarity: Schema.NullOr(Schema.Number),
});
export type Evidence = typeof Evidence.Type;

/** Expediente: a trend with its selected evidence and both ranking positions. */
export const Dossier = Schema.Struct({
  schema_version: Schema.Literal(DOSSIER_SCHEMA_VERSION),
  origin: Schema.Literals(["earlyscript", "earlywindow"]),
  dossier_id: Schema.String,
  run_id: Schema.String,
  created_at: Schema.String,
  cutoff_at: Schema.String,
  engine: EngineRef,
  profile: ProfileRef,
  trend: Trend,
  profile_fit: ProfileFit,
  rankings: Rankings,
  curve: Schema.Array(CurvePoint),
  coverage: Schema.Struct({
    window_days: Schema.Int,
    by_source: Schema.Array(SourceCoverage),
    /** Some source of the run missed a day of the curve window: counts are lower bounds. */
    uncertain: Schema.Boolean,
  }),
  data_gaps: Schema.Array(DataGap),
  evidence: Schema.Array(Evidence).check(Schema.isMinLength(1)),
  evidence_status: Schema.Literals(["sufficient", "thin"]),
});
export type Dossier = typeof Dossier.Type;
