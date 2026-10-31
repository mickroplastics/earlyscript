import * as Schema from "effect/Schema";

// Sources with an adapter. A new source adds its id here and an adapter in trend-engine.
export const SourceId = Schema.Literals([
  "hn",
  "github",
  "lobsters",
  "rss",
  "huggingface",
]);
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
/** One page of lobste.rs `/newest/page/N.json`, newest first. */
export const LobstersPage = Schema.Array(
  Schema.Struct({
    short_id: Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/)),
    created_at: Schema.String,
    title: Schema.String,
    url: Schema.String,
    description_plain: Schema.optionalKey(Schema.String),
    submitter_user: Schema.NullOr(Schema.String),
    tags: Schema.Array(Schema.String),
    short_id_url: Schema.String,
    comments_url: Schema.String,
  }),
);

const HttpUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }),
);

/** One RSS 2.0 or Atom feed of the `rss` source; the built-in list and user lists share it. */
export const RssFeed = Schema.Struct({
  /** Stable slug, part of every item id: `itm_rss_<id>_<hash>`. */
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,39}$/)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  feedUrl: HttpUrl,
  siteUrl: HttpUrl,
  /** License or usage note; "" when unknown. */
  license: Schema.String.check(Schema.isMaxLength(500)),
  /** Why the feed is in the list. */
  why: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type RssFeed = typeof RssFeed.Type;

/** A feed list file (`engine collect --rss-feeds <file.json>`): unique ids and feed URLs. */
export const RssFeedList = Schema.Array(RssFeed).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.makeFilter(
    (feeds) =>
      new Set(feeds.map((feed) => feed.id)).size === feeds.length &&
      new Set(feeds.map((feed) => feed.feedUrl)).size === feeds.length,
  ),
);
export type RssFeedList = typeof RssFeedList.Type;
