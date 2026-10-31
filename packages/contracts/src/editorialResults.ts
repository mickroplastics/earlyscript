import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

// Earlyscript Results space: read-only aggregates over editorial.sqlite. Descriptive only:
// medians, quartiles and counts per mode, never a computed "saving" or a causal claim. The
// thesis comparison is paired, on the same topic, with external reviewers; this is the log.

export const EDITORIAL_RESULTS_WS_METHODS = {
  summary: "editorial.results.summary",
  decisions: "editorial.results.decisions",
  export: "editorial.results.export",
} as const;

export const EditorialResultsMode = Schema.Literals(["assisted", "manual"]);
export type EditorialResultsMode = typeof EditorialResultsMode.Type;

export const EditorialResultsStage = Schema.Literals(["explore", "read", "write", "decide"]);
export type EditorialResultsStage = typeof EditorialResultsStage.Type;

export const EditorialResultsAction = Schema.Literals(["accept", "edit", "reject"]);
export type EditorialResultsAction = typeof EditorialResultsAction.Type;

/**
 * Active milliseconds over the threads where the stage ran. Quartiles use linear
 * interpolation between order statistics (R type 7); all null when `n` is 0.
 */
export const EditorialDurationStats = Schema.Struct({
  n: NonNegativeInt,
  medianMs: Schema.NullOr(Schema.Finite),
  q1Ms: Schema.NullOr(Schema.Finite),
  q3Ms: Schema.NullOr(Schema.Finite),
  minMs: Schema.NullOr(Schema.Finite),
  maxMs: Schema.NullOr(Schema.Finite),
});
export type EditorialDurationStats = typeof EditorialDurationStats.Type;

export const EditorialStageStats = Schema.Struct({
  stage: EditorialResultsStage,
  stats: EditorialDurationStats,
});
export type EditorialStageStats = typeof EditorialStageStats.Type;

/**
 * Which stages a thread recorded. `complete` is the whole process of its mode: assisted with
 * `read`, `write` and `decide` (assisted `explore` is optional, the engine explored), manual
 * with `explore`, `write` and `decide`. Anything less is `partial`. A stage is recorded when
 * its duration is not null; zero milliseconds still count as recorded.
 */
export const EditorialResultsCoverage = Schema.Literals(["complete", "partial"]);
export type EditorialResultsCoverage = typeof EditorialResultsCoverage.Type;

/**
 * The comparisons of the manual mode design: exploring (manual `explore` against assisted
 * `explore` plus `read`), writing (`write` in both) and the whole process (`total`, only
 * threads with `complete` coverage). `recorded` sums the recorded stages of every timed
 * thread, partial ones included, and is never read as the whole process.
 */
export const EditorialResultsComparisonKey = Schema.Literals([
  "explore",
  "write",
  "total",
  "recorded",
]);
export type EditorialResultsComparisonKey = typeof EditorialResultsComparisonKey.Type;

export const EditorialResultsComparison = Schema.Struct({
  key: EditorialResultsComparisonKey,
  assisted: EditorialDurationStats,
  manual: EditorialDurationStats,
  /** Timed threads with `partial` coverage inside these statistics, per mode. */
  partial: Schema.Struct({ assisted: NonNegativeInt, manual: NonNegativeInt }),
});
export type EditorialResultsComparison = typeof EditorialResultsComparison.Type;

/** Utility the operator recorded with the decision (1 to 5). External reviewers are not here. */
export const EditorialUtilityStats = Schema.Struct({
  n: NonNegativeInt,
  mean: Schema.NullOr(Schema.Finite),
  /** Count per score, index 0 is utility 1. */
  distribution: Schema.Array(NonNegativeInt),
});
export type EditorialUtilityStats = typeof EditorialUtilityStats.Type;

/**
 * Mechanical count of `@earlyscript/editorial-script` over the decided version: a claim with
 * a citation marker, not a claim the source supports. `ratio` pools claims over threads.
 */
export const EditorialCitationStats = Schema.Struct({
  threads: NonNegativeInt,
  claims: NonNegativeInt,
  cited: NonNegativeInt,
  ratio: Schema.NullOr(Schema.Finite),
});
export type EditorialCitationStats = typeof EditorialCitationStats.Type;

export const EditorialResultsModeSummary = Schema.Struct({
  mode: EditorialResultsMode,
  /** Threads with a current decision. */
  threads: NonNegativeInt,
  /** Of those, threads left out of time statistics because a segment awaits resolution. */
  provisionalClock: NonNegativeInt,
  actions: Schema.Struct({
    accept: NonNegativeInt,
    edit: NonNegativeInt,
    reject: NonNegativeInt,
  }),
  stages: Schema.Array(EditorialStageStats),
  /** Sum of the recorded stages over timed threads, partial coverage included. */
  total: EditorialDurationStats,
  /** Of the threads, those with `partial` coverage. */
  partialCoverage: NonNegativeInt,
  utility: EditorialUtilityStats,
  citations: EditorialCitationStats,
  /** Threads with at least one video result recorded. */
  withVideoResults: NonNegativeInt,
});
export type EditorialResultsModeSummary = typeof EditorialResultsModeSummary.Type;

/** Counts are independent: a trend can be read and in production at once. */
export const EditorialResultsInbox = Schema.Struct({
  read: NonNegativeInt,
  observing: NonNegativeInt,
  dismissed: NonNegativeInt,
  production: NonNegativeInt,
});
export type EditorialResultsInbox = typeof EditorialResultsInbox.Type;

export const EditorialResultsSummary = Schema.Struct({
  modes: Schema.Array(EditorialResultsModeSummary),
  comparisons: Schema.Array(EditorialResultsComparison),
  inbox: EditorialResultsInbox,
  /**
   * Current decisions left out of every statistic because a stored value is out of its domain
   * (utility outside 1 to 5, a negative or absurd time, a negative count).
   */
  excludedByDomain: NonNegativeInt,
  /** Every decision recorded, superseded ones included. */
  decisionCount: NonNegativeInt,
  firstDecidedAt: Schema.NullOr(IsoDateTime),
  lastDecidedAt: Schema.NullOr(IsoDateTime),
  asOf: IsoDateTime,
});
export type EditorialResultsSummary = typeof EditorialResultsSummary.Type;

export const EditorialResultsVideoMetrics = Schema.Struct({
  views: Schema.NullOr(NonNegativeInt),
  subscribers: Schema.NullOr(NonNegativeInt),
  clicks: Schema.NullOr(NonNegativeInt),
  comments: Schema.NullOr(NonNegativeInt),
  observedAt: IsoDateTime,
});
export type EditorialResultsVideoMetrics = typeof EditorialResultsVideoMetrics.Type;

export const EditorialResultsDecision = Schema.Struct({
  decisionId: Schema.String,
  threadId: Schema.String,
  environmentId: Schema.String,
  mode: EditorialResultsMode,
  trendKey: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  dossierId: Schema.NullOr(Schema.String),
  action: EditorialResultsAction,
  utility: PositiveInt,
  reason: Schema.NullOr(Schema.String),
  decidedAt: IsoDateTime,
  /** False when a later decision on the same thread replaced this one. */
  current: Schema.Boolean,
  /** False when a segment awaited resolution: the durations are a floor. */
  clockDefinitive: Schema.Boolean,
  /** Stages with a duration, in work order. */
  stages: Schema.Array(EditorialResultsStage),
  coverage: EditorialResultsCoverage,
  /** Null when the stage never ran, never zero by omission. */
  durations: Schema.Struct({
    exploreMs: Schema.NullOr(NonNegativeInt),
    readMs: Schema.NullOr(NonNegativeInt),
    writeMs: Schema.NullOr(NonNegativeInt),
    decideMs: Schema.NullOr(NonNegativeInt),
    totalMs: Schema.NullOr(NonNegativeInt),
  }),
  /** Mechanical claim count of the decided script version; null without a version. */
  script: Schema.NullOr(
    Schema.Struct({
      versionHash: Schema.String,
      claims: NonNegativeInt,
      cited: NonNegativeInt,
    }),
  ),
  /** Most recent observation, by `observedAt`. */
  video: Schema.NullOr(EditorialResultsVideoMetrics),
});
export type EditorialResultsDecision = typeof EditorialResultsDecision.Type;

const EDITORIAL_RESULTS_DECISIONS_PAGE_LIMIT = 100;

export const EditorialResultsSummaryInput = Schema.Struct({});

export const EditorialResultsDecisionsInput = Schema.Struct({
  mode: Schema.optionalKey(EditorialResultsMode),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(EDITORIAL_RESULTS_DECISIONS_PAGE_LIMIT)),
  ),
});
export type EditorialResultsDecisionsInput = typeof EditorialResultsDecisionsInput.Type;

export const EditorialResultsDecisionPage = Schema.Struct({
  /** Most recent first. */
  decisions: Schema.Array(EditorialResultsDecision),
  total: NonNegativeInt,
  offset: NonNegativeInt,
});
export type EditorialResultsDecisionPage = typeof EditorialResultsDecisionPage.Type;

export class EditorialResultsError extends Schema.TaggedError<EditorialResultsError>()(
  "EditorialResultsError",
  {
    reason: Schema.Literals(["unavailable", "unreadable"]),
    message: Schema.String,
  },
) {}

/**
 * Evidence package for the thesis. `full` stays on the operator's machine and keeps free text
 * (reasons, capture notes, URLs); `share` keeps only the columns its manifest lists, with
 * thread and trend ids replaced by stable indices and dates rounded to the day.
 */
export const EditorialEvidenceMode = Schema.Literals(["full", "share"]);
export type EditorialEvidenceMode = typeof EditorialEvidenceMode.Type;

/** `YYYY-MM-DD` (UTC day, inclusive) or an ISO date-time. */
const EvidenceDateFilter = Schema.String.check(Schema.isMaxLength(40));

export const EditorialEvidenceExportInput = Schema.Struct({
  mode: EditorialEvidenceMode,
  since: Schema.optionalKey(EvidenceDateFilter),
  until: Schema.optionalKey(EvidenceDateFilter),
  /**
   * Absolute folder on the server's machine. The package goes into a subfolder named after the
   * mode and day; without it, the files come back in the response (the web zips them).
   */
  directory: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});
export type EditorialEvidenceExportInput = typeof EditorialEvidenceExportInput.Type;

export const EditorialEvidenceFile = Schema.Struct({
  name: Schema.String,
  sha256: Schema.String,
  bytes: NonNegativeInt,
});
export type EditorialEvidenceFile = typeof EditorialEvidenceFile.Type;

export const EditorialEvidenceExportResult = Schema.Struct({
  mode: EditorialEvidenceMode,
  /** Hash over the data files' names and hashes; equal state gives an equal hash. */
  packageHash: Schema.String,
  files: Schema.Array(EditorialEvidenceFile),
  /** Folder written on the server, or null when `contents` carries the files. */
  directory: Schema.NullOr(Schema.String),
  /** Name of the package folder (and of the zip the web builds). */
  packageName: Schema.String,
  /** File contents by name, manifest included; empty when written to `directory`. */
  contents: Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String })),
});
export type EditorialEvidenceExportResult = typeof EditorialEvidenceExportResult.Type;

export class EditorialEvidenceExportError extends Schema.TaggedError<EditorialEvidenceExportError>()(
  "EditorialEvidenceExportError",
  {
    reason: Schema.Literals(["unavailable", "unreadable", "invalid-filter", "target"]),
    message: Schema.String,
  },
) {}

const EditorialResultsSummaryRpc = Rpc.make(EDITORIAL_RESULTS_WS_METHODS.summary, {
  payload: EditorialResultsSummaryInput,
  success: EditorialResultsSummary,
  error: Schema.Union([EditorialResultsError, EnvironmentAuthorizationError]),
});

const EditorialResultsDecisionsRpc = Rpc.make(EDITORIAL_RESULTS_WS_METHODS.decisions, {
  payload: EditorialResultsDecisionsInput,
  success: EditorialResultsDecisionPage,
  error: Schema.Union([EditorialResultsError, EnvironmentAuthorizationError]),
});

const EditorialResultsExportRpc = Rpc.make(EDITORIAL_RESULTS_WS_METHODS.export, {
  payload: EditorialEvidenceExportInput,
  success: EditorialEvidenceExportResult,
  error: Schema.Union([EditorialEvidenceExportError, EnvironmentAuthorizationError]),
});

/** Merged into `WsRpcGroup` next to `EditorialRpcGroup`. */
export const EditorialResultsRpcGroup = RpcGroup.make(
  EditorialResultsSummaryRpc,
  EditorialResultsDecisionsRpc,
  EditorialResultsExportRpc,
);

export const EDITORIAL_RESULTS_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_RESULTS_WS_METHODS.summary]: AuthOrchestrationReadScope,
  [EDITORIAL_RESULTS_WS_METHODS.decisions]: AuthOrchestrationReadScope,
  // Writes files on the server's machine (or returns the private record), so it needs the
  // same scope as the other editorial writes.
  [EDITORIAL_RESULTS_WS_METHODS.export]: AuthOrchestrationOperateScope,
} as const;
