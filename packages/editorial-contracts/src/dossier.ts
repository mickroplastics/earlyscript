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
  /** The item's learned relevance, when the run has a relevance model. */
  relevance: Schema.optionalKey(Schema.Number),
});
export type Evidence = typeof Evidence.Type;

/** One source's share of a coverage-equivalent growth (stage.coverage_rule equivalent). */
export const GrowthSource = Schema.Struct({
  source: SourceId,
  /** Days of each window the source collected fully. */
  days_7d: Schema.Int,
  days_prev_7d: Schema.Int,
  /** Counted items on those days. */
  items_7d: Schema.Int,
  items_prev_7d: Schema.Int,
  /** Both windows have a fully collected day, so the source enters the growth. */
  comparable: Schema.Boolean,
});
export type GrowthSource = typeof GrowthSource.Type;

/** Learned relevance of a trend and the series computed over its relevant items. */
export const RelevanceFit = Schema.Struct({
  /** Mean item relevance over the trend's items of the last 7 days (all items if none). */
  score: Schema.Number,
  model_id: Schema.String,
  model_hash: Schema.String,
  item_min: Schema.Number,
  signal_min: Schema.Number,
  items_scored: Schema.Int,
  relevant_items_7d: Schema.Int,
  relevant_items_prev_7d: Schema.Int,
  /** ln((e7 + 1) / (eprev + 1)) over relevant items, e = per-day rate x 7 of comparable sources. */
  growth: Schema.Number,
  growth_sources: Schema.Array(GrowthSource),
  /** relevant: passed signal_min. backfill: added so the cut reaches emit.min_dossiers. */
  eligibility: Schema.Literals(["relevant", "backfill"]),
  /** How `score` aggregates item relevance; absent means mean. */
  aggregate: Schema.optionalKey(Schema.Literals(["mean", "share", "trimmed_mean"])),
  /** Relevant items of the last 7 days with distinct titles. */
  relevant_distinct_7d: Schema.optionalKey(Schema.Int),
  /** Previous cuts (relevance.novelty) where the trend was in the top, and whether it grew since. */
  novelty: Schema.optionalKey(
    Schema.Struct({ prior_top_days: Schema.Array(UtcDay), grew: Schema.Boolean }),
  ),
});
export type RelevanceFit = typeof RelevanceFit.Type;

/** A trend folded into a better-ranked one at emission (emit.dedup_cosine). */
export const RelatedTrend = Schema.Struct({
  trend_id: Schema.String,
  label: Schema.String,
  cosine: Schema.Number,
  items_7d: Schema.Int,
  relevance: Schema.NullOr(Schema.Number),
});
export type RelatedTrend = typeof RelatedTrend.Type;

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
  /** Present when the run has a relevance model. */
  relevance: Schema.optionalKey(RelevanceFit),
  /** Trends folded into this one at emission; present when emit.dedup_cosine is set. */
  related: Schema.optionalKey(Schema.Array(RelatedTrend)),
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

// engine.v3 (contract v4.2 §1 and §2): the dossier of a topic with its movement. dossier/1 is
// unchanged; dossier/2 keeps every field of it that v3 computes and adds `movement`.

export const DOSSIER_V2_SCHEMA_VERSION = "earlyscript.dossier/2";

/** §2.7, first rule that holds: en caída, rebote, nueva, señal fuerte, señal débil, estable. */
export const Movement = Schema.Literals([
  "nueva",
  "senal_debil",
  "senal_fuerte",
  "rebote",
  "en_caida",
  "estable",
]);
export type Movement = typeof Movement.Type;

/**
 * comparable: counts in n(W). parcial: clustered, but without the comparable window yet (rss
 * before its 35 days). no_comparable: clustered, outside the cohort at this cutoff. no_usada:
 * captured but never embedded nor clustered (Wikipedia).
 */
export const SourceRowStatus = Schema.Literals([
  "comparable",
  "parcial",
  "no_comparable",
  "no_usada",
]);
export type SourceRowStatus = typeof SourceRowStatus.Type;

/** One source's row of the four-week curve: index k is W_k (W0 = the 7 days before the cutoff). */
export const SourceWeekRow = Schema.Struct({
  source: SourceId,
  status: SourceRowStatus,
  /** URL-unique items of the source per week, W0..W4; null is "?" (2+ unavailable days). Empty when no_usada. */
  weeks: Schema.Array(Schema.NullOr(Schema.Int)),
  /** Sum of the known weeks; null when no_usada. */
  total: Schema.NullOr(Schema.Int),
  /** Distinct authors of the source in W0; null when no_usada or W0 is "?". */
  authors_w0: Schema.NullOr(Schema.Int),
});
export type SourceWeekRow = typeof SourceWeekRow.Type;

/** First item of a source among the comparable ones. Not a claim about the real origin. */
export const SourceFirst = Schema.Struct({
  source: SourceId,
  at: Schema.String,
  item_id: Schema.String,
});
export type SourceFirst = typeof SourceFirst.Type;

/** Another item, of any clustered source, with the same canonical URL: one observation, its sources noted. */
export const AlsoIn = Schema.Struct({
  source: SourceId,
  item_id: Schema.String,
  permalink: Schema.String,
  published_at: Schema.String,
});
export type AlsoIn = typeof AlsoIn.Type;

export const EvidenceV2 = Schema.Struct({
  ...Evidence.fields,
  /** k of the week W_k the item falls in (0 = the last 7 days); null before W4. */
  week: Schema.NullOr(Schema.Int),
  also_in: Schema.Array(AlsoIn),
});
export type EvidenceV2 = typeof EvidenceV2.Type;

export const TopicMovement = Schema.Struct({
  section: Schema.Literals(["moving", "background"]),
  /** rank: by the weighted order; trajectory: one of the reserved slots; pending_decision: en caída with a pending decision. */
  slot: Schema.Literals(["rank", "trajectory", "background", "pending_decision"]),
  /** 1-based, within the section. */
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  movement: Movement,
  /** First cutoff of the run of cutoffs ending at this one with the same movement ("fecha de entrada"). */
  movement_since: UtcDay,
  /** The run reaches the start of the history window; the movement may be older. */
  movement_since_capped: Schema.Boolean,
  /** First item of the topic among the comparable sources, over its whole life. */
  first_at: Schema.NullOr(Schema.String),
  perennial: Schema.Boolean,
  perennial_rule: Schema.NullOr(Schema.Literals(["heavy_weeks", "life"])),
  /** ≥ incomplete_share of its W0..W2 items fall in "?" rows: shown, not in percentiles. */
  incomplete: Schema.Boolean,
  /** More than generic_share of the window's items: marked and ordered last. */
  generic: Schema.Boolean,
  /** n(W0)..n(W4): URL-unique items of the comparable sources, "?" rows left out. */
  weeks: Schema.Array(Schema.Int),
  /** First day of the history window, max(t − window_days, corpus start). */
  history_from: UtcDay,
  items_life: Schema.Int,
  pop: Schema.Number,
  tau_days: Schema.Number,
  authors_w0: Schema.Int,
  sources_w0: Schema.Array(SourceId),
  by_source: Schema.Array(SourceWeekRow),
  first_source: Schema.NullOr(SourceFirst),
  second_source: Schema.NullOr(SourceFirst),
  fit: Schema.Struct({
    nearest_include: Schema.NullOr(Schema.String),
    nearest_exclude: Schema.NullOr(Schema.String),
    /** Terms of the keyword list found in the titles of W0. */
    matched_terms: Schema.Array(Schema.String),
    keywords_version: Schema.String,
    headlines: Schema.Array(
      Schema.Struct({
        item_id: Schema.String,
        source: SourceId,
        title: Schema.String,
        permalink: Schema.String,
      }),
    ),
  }),
  saturation: Schema.Struct({
    items_life: Schema.Int,
    /** Every member before the cutoff, all clustered sources, whole life. */
    items_total: Schema.Int,
    /** Weeks among W0..W4 with n ≥ perennial_week_min. */
    heavy_weeks: Schema.Int,
    perennial: Schema.Boolean,
    /** "ya decidido el <fecha>": an earlier decision on the same topic; null until decisions are stored. */
    decided_at: Schema.NullOr(Schema.String),
  }),
  relevance: Schema.Struct({
    score: Schema.Number,
    model_id: Schema.String,
    model_hash: Schema.String,
    aggregate: Schema.String,
    items_scored: Schema.Int,
  }),
  /** The cutoff's percentiles and counts, written in every dossier of the run. */
  cut: Schema.Struct({
    p50: Schema.NullOr(Schema.Number),
    p90: Schema.NullOr(Schema.Number),
    percentile_topics: Schema.Int,
    comparable_sources: Schema.Array(SourceId),
    candidates: Schema.Int,
    discarded_by_exclude: Schema.Int,
  }),
});
export type TopicMovement = typeof TopicMovement.Type;

export const DossierV2 = Schema.Struct({
  schema_version: Schema.Literal(DOSSIER_V2_SCHEMA_VERSION),
  origin: Schema.Literal("earlyscript"),
  dossier_id: Schema.String,
  run_id: Schema.String,
  created_at: Schema.String,
  cutoff_at: Schema.String,
  engine: EngineRef,
  profile: ProfileRef,
  trend: Trend,
  profile_fit: ProfileFit,
  /** baseline: n(W0); weighted: weighted_sum.v3. Positions are within the dossier's section. */
  rankings: Rankings,
  related: Schema.Array(RelatedTrend),
  /** Daily points of the comparable sources over the curve window. */
  curve: Schema.Array(CurvePoint),
  coverage: Schema.Struct({
    window_days: Schema.Int,
    by_source: Schema.Array(SourceCoverage),
    uncertain: Schema.Boolean,
  }),
  data_gaps: Schema.Array(DataGap),
  evidence: Schema.Array(EvidenceV2).check(Schema.isMinLength(1)),
  evidence_status: Schema.Literals(["sufficient", "thin"]),
  movement: TopicMovement,
});
export type DossierV2 = typeof DossierV2.Type;
