import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

// Earlyscript sources: per source, whether captures collect it and whether the engine ranks
// with it, plus the last capture read from the corpus on disk. The governance record of each
// source is static and lives in `@earlyscript/editorial-contracts/sourceCatalog`; ids are plain
// strings here and the server refuses one the catalog does not list.

export const EDITORIAL_SOURCES_WS_METHODS = {
  list: "editorial.sources.list",
  update: "editorial.sources.update",
  validateFeed: "editorial.sources.validateFeed",
  addFeed: "editorial.sources.addFeed",
  removeFeed: "editorial.sources.removeFeed",
  setDefaultFeedExcluded: "editorial.sources.setDefaultFeedExcluded",
} as const;

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

/** `not-ready`: terms not read or the source is blocked; `no-backtest`: no backtest recorded. */
export const EditorialSourceRankBlock = Schema.Literals(["not-ready", "no-backtest"]);
export type EditorialSourceRankBlock = typeof EditorialSourceRankBlock.Type;

export const EditorialSourceCaptureStatus = Schema.Literals([
  "complete",
  "partial",
  "unavailable",
  "rate_limited",
]);
export type EditorialSourceCaptureStatus = typeof EditorialSourceCaptureStatus.Type;

/** The coverage row of the last day the corpus holds for the source. */
export const EditorialSourceCapture = Schema.Struct({
  day: Day,
  status: EditorialSourceCaptureStatus,
  items: NonNegativeInt,
  retrievedAt: Schema.String,
  note: Schema.NullOr(Schema.String),
});
export type EditorialSourceCapture = typeof EditorialSourceCapture.Type;

/** `partial` only for a census source: a sample source's partial day is its full collection. */
export const EditorialSourceGapReason = Schema.Literals([
  "fetch_failed",
  "rate_limited",
  "partial",
  "not_collected",
]);
export type EditorialSourceGapReason = typeof EditorialSourceGapReason.Type;

export const EditorialSourceGap = Schema.Struct({ day: Day, reason: EditorialSourceGapReason });
export type EditorialSourceGap = typeof EditorialSourceGap.Type;

export const EditorialSourceEntry = Schema.Struct({
  source: Schema.String,
  /** Effective values: a stored `true` the source no longer allows reads as `false`. */
  collect: Schema.Boolean,
  rank: Schema.Boolean,
  backtestRunId: Schema.NullOr(Schema.String),
  /** Null when `rank` may be turned on. */
  rankBlocked: Schema.NullOr(EditorialSourceRankBlock),
  /** Null when captures may collect the source: only a source whose terms were read can. */
  collectBlocked: Schema.NullOr(Schema.Literals(["pending-review", "blocked"])),
  /** Null while the source keeps its default. */
  updatedAt: Schema.NullOr(IsoDateTime),
  /** Null when the corpus holds no day of the source. */
  lastCapture: Schema.NullOr(EditorialSourceCapture),
  /** Days of the corpus's last week without a full collection, oldest first. */
  recentGaps: Schema.Array(EditorialSourceGap),
});
export type EditorialSourceEntry = typeof EditorialSourceEntry.Type;

export const EditorialSourcesCorpus = Schema.Struct({
  status: Schema.Literals(["ready", "missing", "unreadable"]),
  directory: Schema.String,
  fromDay: Schema.NullOr(Day),
  /** Exclusive, as in corpus/1. */
  toDay: Schema.NullOr(Day),
  message: Schema.NullOr(Schema.String),
});
export type EditorialSourcesCorpus = typeof EditorialSourcesCorpus.Type;

const FEED_URL_MAX_CHARS = 2048;
const FeedUrl = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(FEED_URL_MAX_CHARS));

/** A feed of the `rss` source: the engine's curated list, or one the operator added. */
export const EditorialRssFeed = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  feedUrl: Schema.String,
  siteUrl: Schema.NullOr(Schema.String),
  /** License note of a default feed; the operator's note of an added one. */
  note: Schema.NullOr(Schema.String),
  origin: Schema.Literals(["default", "user"]),
  /** When the operator accepted private analysis without republication; null for defaults. */
  acknowledgedAt: Schema.NullOr(IsoDateTime),
  /** Only a default feed can be excluded; the operator removes an added one instead. */
  excluded: Schema.Boolean,
  addedAt: Schema.NullOr(IsoDateTime),
});
export type EditorialRssFeed = typeof EditorialRssFeed.Type;

export const EditorialSourcesView = Schema.Struct({
  corpus: EditorialSourcesCorpus,
  /** Catalog order. */
  sources: Schema.Array(EditorialSourceEntry),
  /** Default feeds first, in the engine's order, then the operator's by date added. */
  rssFeeds: Schema.Array(EditorialRssFeed),
  asOf: IsoDateTime,
});
export type EditorialSourcesView = typeof EditorialSourcesView.Type;

export const EditorialSourcesListInput = Schema.Struct({});

export const EditorialSourcesUpdateInput = Schema.Struct({
  source: Schema.String,
  collect: Schema.optionalKey(Schema.Boolean),
  rank: Schema.optionalKey(Schema.Boolean),
});
export type EditorialSourcesUpdateInput = typeof EditorialSourcesUpdateInput.Type;

export const EditorialFeedInput = Schema.Struct({ feedUrl: FeedUrl });
export type EditorialFeedInput = typeof EditorialFeedInput.Type;

export const EditorialAddFeedInput = Schema.Struct({
  feedUrl: FeedUrl,
  /** Empty or absent: the feed's own title. */
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  /** Empty or absent: the site the feed declares. */
  siteUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(FEED_URL_MAX_CHARS))),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  /** The operator's acceptance: private analysis, no republication, the site's terms respected. */
  acknowledged: Schema.optionalKey(Schema.Boolean),
});
export type EditorialAddFeedInput = typeof EditorialAddFeedInput.Type;

export const EditorialDefaultFeedInput = Schema.Struct({
  id: Schema.String,
  excluded: Schema.Boolean,
});
export type EditorialDefaultFeedInput = typeof EditorialDefaultFeedInput.Type;

/** One download of a feed, after robots.txt allowed every hop to it. */
export const EditorialFeedCheck = Schema.Struct({
  /** The URL as normalized and stored. */
  feedUrl: Schema.String,
  title: Schema.NullOr(Schema.String),
  siteUrl: Schema.NullOr(Schema.String),
  entries: NonNegativeInt,
  /** Most recent entry date the feed gives; null when no entry has a readable date. */
  latestAt: Schema.NullOr(IsoDateTime),
  checkedAt: IsoDateTime,
});
export type EditorialFeedCheck = typeof EditorialFeedCheck.Type;

export class EditorialSourcesError extends Schema.TaggedError<EditorialSourcesError>()(
  "EditorialSourcesError",
  {
    reason: Schema.Literals([
      "unavailable",
      "unknown-source",
      "rank-blocked",
      "collect-blocked",
      "storage",
      "invalid-url",
      "not-a-feed",
      "robots-disallowed",
      "robots-unavailable",
      "unreachable",
      "too-large",
      "duplicate-feed",
      "unknown-feed",
      "not-acknowledged",
    ]),
    message: Schema.String,
  },
) {}

const sourcesError = Schema.Union([EditorialSourcesError, EnvironmentAuthorizationError]);

const EditorialSourcesListRpc = Rpc.make(EDITORIAL_SOURCES_WS_METHODS.list, {
  payload: EditorialSourcesListInput,
  success: EditorialSourcesView,
  error: sourcesError,
});

/** Answers with the whole view, read again after the write. */
const EditorialSourcesUpdateRpc = Rpc.make(EDITORIAL_SOURCES_WS_METHODS.update, {
  payload: EditorialSourcesUpdateInput,
  success: EditorialSourcesView,
  error: sourcesError,
});

/**
 * Checks robots.txt for the feed path, then downloads the feed once with the engine's
 * User-Agent. Operate, not read: it makes this server fetch a URL the client chose.
 */
const EditorialSourcesValidateFeedRpc = Rpc.make(EDITORIAL_SOURCES_WS_METHODS.validateFeed, {
  payload: EditorialFeedInput,
  success: EditorialFeedCheck,
  error: sourcesError,
});

/** Validates as `validateFeed` does, then stores the feed for the `rss` source. */
const EditorialSourcesAddFeedRpc = Rpc.make(EDITORIAL_SOURCES_WS_METHODS.addFeed, {
  payload: EditorialAddFeedInput,
  success: EditorialSourcesView,
  error: sourcesError,
});

const EditorialSourcesRemoveFeedRpc = Rpc.make(EDITORIAL_SOURCES_WS_METHODS.removeFeed, {
  payload: EditorialFeedInput,
  success: EditorialSourcesView,
  error: sourcesError,
});

const EditorialSourcesSetDefaultFeedExcludedRpc = Rpc.make(
  EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded,
  { payload: EditorialDefaultFeedInput, success: EditorialSourcesView, error: sourcesError },
);

/** Merged into `WsRpcGroup` next to the other editorial groups. */
export const EditorialSourcesRpcGroup = RpcGroup.make(
  EditorialSourcesListRpc,
  EditorialSourcesUpdateRpc,
  EditorialSourcesValidateFeedRpc,
  EditorialSourcesAddFeedRpc,
  EditorialSourcesRemoveFeedRpc,
  EditorialSourcesSetDefaultFeedExcludedRpc,
);

export const EDITORIAL_SOURCES_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_SOURCES_WS_METHODS.list]: AuthOrchestrationReadScope,
  [EDITORIAL_SOURCES_WS_METHODS.update]: AuthOrchestrationOperateScope,
  [EDITORIAL_SOURCES_WS_METHODS.validateFeed]: AuthOrchestrationOperateScope,
  [EDITORIAL_SOURCES_WS_METHODS.addFeed]: AuthOrchestrationOperateScope,
  [EDITORIAL_SOURCES_WS_METHODS.removeFeed]: AuthOrchestrationOperateScope,
  [EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded]: AuthOrchestrationOperateScope,
} as const;
