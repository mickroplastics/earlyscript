import * as Schema from "effect/Schema";

// Sources with an adapter. A new source adds its id here and an adapter in trend-engine.
export const SourceId = Schema.Literals(["hn", "github", "arxiv", "wikipedia", "npm", "stackexchange", "bluesky"]);
export type SourceId = typeof SourceId.Type;

export const UtcDay = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export type UtcDay = typeof UtcDay.Type;

export const CoverageStatus = Schema.Literals([
  "complete",
  "partial",
  "unavailable",
  "rate_limited",
]);
export type CoverageStatus = typeof CoverageStatus.Type;

/** One line of coverage.jsonl (corpus/1): a zero count only means something on a full day. */
export const CoverageRecord = Schema.Struct({
  source: SourceId,
  day: UtcDay,
  status: CoverageStatus,
  items: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  retrieved_at: Schema.String,
  note: Schema.NullOr(Schema.String),
});
export type CoverageRecord = typeof CoverageRecord.Type;

/** Fuente: an origin with an adapter and a coverage policy. */
export const SourceDescriptor = Schema.Struct({
  id: SourceId,
  label: Schema.String,
  /** What one day of the source contains; part of the corpus hash. */
  selection: Schema.Record(Schema.String, Schema.String),
  /** `sample`: a ranked sample, so `partial` is its full collection; `census`: only `complete` is full. */
  coverage_policy: Schema.Literals(["census", "sample"]),
});
export type SourceDescriptor = typeof SourceDescriptor.Type;

export const DataGapReason = Schema.Literals([
  "fetch_failed",
  "rate_limited",
  "partial",
  "not_collected",
]);
export type DataGapReason = typeof DataGapReason.Type;

export const DataGap = Schema.Struct({
  source: SourceId,
  day: UtcDay,
  reason: DataGapReason,
});
export type DataGap = typeof DataGap.Type;

export const SourceCoverage = Schema.Struct({
  source: SourceId,
  days_complete: Schema.Int,
  days_partial: Schema.Int,
  days_unavailable: Schema.Int,
});
export type SourceCoverage = typeof SourceCoverage.Type;

/** Public provider responses validated at the adapter boundary. */
export const HnSearch = Schema.Struct({
  hits: Schema.Array(
    Schema.Struct({
      objectID: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
      created_at_i: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      title: Schema.NullOr(Schema.String),
      author: Schema.NullOr(Schema.String),
      url: Schema.optionalKey(Schema.NullOr(Schema.String)),
      story_text: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
  nbHits: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  exhaustiveNbHits: Schema.optionalKey(Schema.Boolean),
  exhaustive: Schema.optionalKey(Schema.Struct({ nbHits: Schema.optionalKey(Schema.Boolean) })),
});
export const GithubSearch = Schema.Struct({
  total_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  incomplete_results: Schema.Boolean,
  items: Schema.Array(
    Schema.Struct({
      id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      full_name: Schema.String,
      html_url: Schema.String,
      created_at: Schema.String,
      description: Schema.NullOr(Schema.String),
      owner: Schema.Struct({ login: Schema.String }),
    }),
  ),
});
