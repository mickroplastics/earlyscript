import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

// Earlyscript editorial space. Reads are views over the trend engine's runs, indexed in
// editorial.sqlite by the server's importer. Writes change the human inbox state of a trend
// (read, snoozed, dismissed) or create its video thread; the server takes the actor from the
// authenticated session. None of these methods is an MCP tool or an orchestration command.

export const EDITORIAL_WS_METHODS = {
  listRuns: "editorial.listRuns",
  getInbox: "editorial.getInbox",
  getDossier: "editorial.getDossier",
  subscribe: "editorial.subscribe",
  markRead: "editorial.markRead",
  snooze: "editorial.snooze",
  unsnooze: "editorial.unsnooze",
  dismiss: "editorial.dismiss",
  reopen: "editorial.reopen",
  createVideo: "editorial.createVideo",
} as const;

export const EditorialRunId = TrimmedNonEmptyString.pipe(Schema.brand("EditorialRunId"));
export type EditorialRunId = typeof EditorialRunId.Type;

export const EditorialDossierId = TrimmedNonEmptyString.pipe(Schema.brand("EditorialDossierId"));
export type EditorialDossierId = typeof EditorialDossierId.Type;

/** Stable identity of a trend across runs; the server derives it from the dossier. */
export const EditorialTrendKey = TrimmedNonEmptyString.pipe(Schema.brand("EditorialTrendKey"));
export type EditorialTrendKey = typeof EditorialTrendKey.Type;

/** Dossier metrics a "keep watching" snooze can wait on. */
export const EditorialSnoozeMetric = Schema.Literals(["items7d", "authors7d", "items28d", "score"]);
export type EditorialSnoozeMetric = typeof EditorialSnoozeMetric.Type;

/** The trend comes back when `metric` reaches `atLeast` in an imported run. */
export const EditorialSnoozeReturn = Schema.Struct({
  metric: EditorialSnoozeMetric,
  /** Value of the metric in the latest run when the snooze was recorded. */
  baseline: Schema.Finite,
  atLeast: Schema.Finite,
});
export type EditorialSnoozeReturn = typeof EditorialSnoozeReturn.Type;

/**
 * Human inbox state of a trend. Read, snoozed, dismissed and in production are independent:
 * a trend in production keeps receiving evidence and stays visible.
 */
export const EditorialTrendInboxState = Schema.Struct({
  /** Activity after the revision last opened, or never opened; never when snoozed or dismissed. */
  isNew: Schema.Boolean,
  seenRunId: Schema.NullOr(EditorialRunId),
  seenAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.NullOr(
    Schema.Struct({
      at: IsoDateTime,
      until: Schema.NullOr(IsoDateTime),
      returnWhen: Schema.NullOr(EditorialSnoozeReturn),
    }),
  ),
  dismissed: Schema.NullOr(Schema.Struct({ at: IsoDateTime, reason: Schema.String })),
  production: Schema.NullOr(Schema.Struct({ threadId: Schema.String, linkedAt: IsoDateTime })),
});
export type EditorialTrendInboxState = typeof EditorialTrendInboxState.Type;

/** `partial`: some dossiers did not decode. `invalid`: run.json did not; the inbox skips it. */
export const EditorialRunImportState = Schema.Literals(["imported", "partial", "invalid"]);
export type EditorialRunImportState = typeof EditorialRunImportState.Type;

/** A file of the run directory the importer could not read, and why. */
export const EditorialSkippedFile = Schema.Struct({
  file: Schema.String,
  reason: Schema.String,
});
export type EditorialSkippedFile = typeof EditorialSkippedFile.Type;

export const EditorialRunSummary = Schema.Struct({
  runId: EditorialRunId,
  /**
   * The engine only saw items published before this instant. Null only for an invalid run
   * first seen with an unreadable run.json: the cutoff is unknown, not invented.
   */
  cutoffAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  status: Schema.String,
  configVersion: Schema.NullOr(Schema.String),
  sources: Schema.Array(Schema.String),
  dossierCount: NonNegativeInt,
  /** Optional for summaries built before the index existed; the server always sends it. */
  importState: Schema.optional(EditorialRunImportState),
  skippedFiles: Schema.optional(Schema.Array(EditorialSkippedFile)),
});
export type EditorialRunSummary = typeof EditorialRunSummary.Type;

export const EditorialSourceCoverage = Schema.Struct({
  source: Schema.String,
  windowDays: NonNegativeInt,
  daysComplete: NonNegativeInt,
  daysPartial: NonNegativeInt,
  daysUnavailable: NonNegativeInt,
});
export type EditorialSourceCoverage = typeof EditorialSourceCoverage.Type;

/** One day of the trend's activity. `known: false` means the day was not captured, not zero. */
export const EditorialCurveDay = Schema.Struct({
  day: Schema.String,
  items: NonNegativeInt,
  authors: NonNegativeInt,
  sources: NonNegativeInt,
  known: Schema.Boolean,
});
export type EditorialCurveDay = typeof EditorialCurveDay.Type;

/** Assistant-written title and summary (U7). Absent until a presentation exists for the dossier. */
export const EditorialTrendPresentation = Schema.Struct({
  title: Schema.String,
  summary: Schema.Struct({
    whatHappened: Schema.String,
    whyItMatters: Schema.String,
    videoAngle: Schema.String,
  }),
  citedItemIds: Schema.Array(Schema.String),
  provider: Schema.String,
  model: Schema.String,
  promptVersion: Schema.String,
  generatedAt: IsoDateTime,
  /** `stale`: written for an earlier input (evidence, profile or prompt); kept until regenerated. */
  status: Schema.optionalKey(Schema.Literals(["current", "stale"])),
});
export type EditorialTrendPresentation = typeof EditorialTrendPresentation.Type;

export const EditorialTrendSummary = Schema.Struct({
  dossierId: EditorialDossierId,
  runId: EditorialRunId,
  /** Engine label built from terms. Always shown, also next to an assistant title. */
  label: Schema.String,
  terms: Schema.Array(Schema.String),
  /** Title of the most recent evidence item, until an assistant title exists. */
  subtitle: Schema.NullOr(Schema.String),
  presentation: Schema.optionalKey(EditorialTrendPresentation),
  stage: Schema.String,
  corroboration: Schema.String,
  items7d: NonNegativeInt,
  items28d: NonNegativeInt,
  authors7d: NonNegativeInt,
  /** Competition rank by `items7d` (the engine's baseline); ties share a rank. */
  volumeRank: PositiveInt,
  /** Rank by the engine's weighted score. */
  scoreRank: PositiveInt,
  score: Schema.Finite,
  growth: Schema.NullOr(Schema.Finite),
  affinity: Schema.NullOr(Schema.Finite),
  sourceCount: NonNegativeInt,
  /** Sources named by the evidence; `sourceCount` can be higher when the curve saw more. */
  sources: Schema.Array(Schema.String),
  /** Last 14 days of `items`; `null` for a day that was not captured. */
  sparkline: Schema.Array(Schema.NullOr(NonNegativeInt)),
  /** Same as `inbox.isNew`, kept flat for the sort and older clients. */
  isNew: Schema.Boolean,
  /** Always sent by servers with the importer; optional so older payloads still decode. */
  trendKey: Schema.optionalKey(EditorialTrendKey),
  inbox: Schema.optionalKey(EditorialTrendInboxState),
});
export type EditorialTrendSummary = typeof EditorialTrendSummary.Type;

export const EditorialRankComponent = Schema.Struct({
  name: Schema.String,
  value: Schema.Finite,
  weight: Schema.Finite,
  contribution: Schema.Finite,
});
export type EditorialRankComponent = typeof EditorialRankComponent.Type;

export const EditorialEvidenceItem = Schema.Struct({
  itemId: Schema.String,
  source: Schema.String,
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  publishedAt: IsoDateTime,
  permalink: Schema.NullOr(Schema.String),
  externalUrl: Schema.NullOr(Schema.String),
});
export type EditorialEvidenceItem = typeof EditorialEvidenceItem.Type;

export const EditorialTrendDossier = Schema.Struct({
  trend: EditorialTrendSummary,
  run: EditorialRunSummary,
  rankMethod: Schema.String,
  rankComponents: Schema.Array(EditorialRankComponent),
  /** Profile inclusion threshold the engine applied (`profile.include_min`). */
  affinityThreshold: Schema.Finite,
  curve: Schema.Array(EditorialCurveDay),
  coverage: Schema.Array(EditorialSourceCoverage),
  evidence: Schema.Array(EditorialEvidenceItem),
  evidenceTotal: NonNegativeInt,
  evidenceOffset: NonNegativeInt,
  /** Oldest and newest `publishedAt` over every selected item, not just this page. */
  evidenceRange: Schema.NullOr(Schema.Struct({ from: IsoDateTime, to: IsoDateTime })),
});
export type EditorialTrendDossier = typeof EditorialTrendDossier.Type;

export const EditorialInboxSort = Schema.Literals(["new-first-growth", "volume", "affinity"]);
export type EditorialInboxSort = typeof EditorialInboxSort.Type;

const EDITORIAL_INBOX_PAGE_LIMIT = 100;
const EDITORIAL_EVIDENCE_PAGE_LIMIT = 50;

export const EditorialListRunsInput = Schema.Struct({});
export const EditorialListRunsResult = Schema.Struct({
  runs: Schema.Array(EditorialRunSummary),
});
export type EditorialListRunsResult = typeof EditorialListRunsResult.Type;

export const EditorialGetInboxInput = Schema.Struct({
  /** Defaults to the most recent run. */
  runId: Schema.optionalKey(EditorialRunId),
  sort: Schema.optionalKey(EditorialInboxSort),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(EDITORIAL_INBOX_PAGE_LIMIT)),
  ),
});
export type EditorialGetInboxInput = typeof EditorialGetInboxInput.Type;

export const EditorialInbox = Schema.Struct({
  run: Schema.NullOr(EditorialRunSummary),
  sort: EditorialInboxSort,
  trends: Schema.Array(EditorialTrendSummary),
  total: NonNegativeInt,
  /** New trends of the run, excluding snoozed and dismissed ones. */
  newCount: NonNegativeInt,
  snoozedCount: NonNegativeInt,
  dismissedCount: NonNegativeInt,
});
export type EditorialInbox = typeof EditorialInbox.Type;

export const EditorialGetDossierInput = Schema.Struct({
  runId: EditorialRunId,
  dossierId: EditorialDossierId,
  evidenceOffset: Schema.optionalKey(NonNegativeInt),
  evidenceLimit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(EDITORIAL_EVIDENCE_PAGE_LIMIT)),
  ),
});
export type EditorialGetDossierInput = typeof EditorialGetDossierInput.Type;

export class EditorialReadError extends Schema.TaggedError<EditorialReadError>()(
  "EditorialReadError",
  {
    reason: Schema.Literals(["run-not-found", "dossier-not-found", "unreadable", "unavailable"]),
    message: Schema.String,
  },
) {}

export const EditorialMarkReadInput = Schema.Struct({
  trendKey: EditorialTrendKey,
  /** The run and dossier the operator opened; the server reads the run's cutoff itself. */
  runId: EditorialRunId,
  dossierId: EditorialDossierId,
});
export type EditorialMarkReadInput = typeof EditorialMarkReadInput.Type;

/** Longest dismissal reason the server stores. */
export const EDITORIAL_REASON_MAX_CHARS = 500;

export const EditorialSnoozeInput = Schema.Struct({
  trendKey: EditorialTrendKey,
  until: Schema.optionalKey(IsoDateTime),
  /**
   * Growth target. The server takes the baseline from the latest imported run; without
   * `until` or `returnWhen` it applies its documented default growth threshold.
   */
  returnWhen: Schema.optionalKey(
    Schema.Struct({ metric: EditorialSnoozeMetric, atLeast: Schema.Finite }),
  ),
});
export type EditorialSnoozeInput = typeof EditorialSnoozeInput.Type;

export const EditorialTrendKeyInput = Schema.Struct({ trendKey: EditorialTrendKey });
export type EditorialTrendKeyInput = typeof EditorialTrendKeyInput.Type;

export const EditorialDismissInput = Schema.Struct({
  trendKey: EditorialTrendKey,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(EDITORIAL_REASON_MAX_CHARS)),
});
export type EditorialDismissInput = typeof EditorialDismissInput.Type;

export const EditorialTrendStateResult = Schema.Struct({
  trendKey: EditorialTrendKey,
  state: EditorialTrendInboxState,
});
export type EditorialTrendStateResult = typeof EditorialTrendStateResult.Type;

/**
 * "Crear hilo de video" from a dossier. The server reads the title and the dossier hash from
 * its index; the client sends the project and composer defaults a new thread there would get.
 */
export const EditorialCreateVideoInput = Schema.Struct({
  trendKey: EditorialTrendKey,
  runId: EditorialRunId,
  dossierId: EditorialDossierId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: Schema.optionalKey(RuntimeMode),
});
export type EditorialCreateVideoInput = typeof EditorialCreateVideoInput.Type;

/** `created: false` when the trend already had its video thread; `threadId` is that thread. */
export const EditorialCreateVideoResult = Schema.Struct({
  trendKey: EditorialTrendKey,
  threadId: ThreadId,
  created: Schema.Boolean,
  state: EditorialTrendInboxState,
});
export type EditorialCreateVideoResult = typeof EditorialCreateVideoResult.Type;

export class EditorialCommandError extends Schema.TaggedError<EditorialCommandError>()(
  "EditorialCommandError",
  {
    /** `launch-failed`: the video thread is registered but T3 could not create it; retry. */
    reason: Schema.Literals([
      "invalid-input",
      "not-found",
      "storage",
      "unavailable",
      "launch-failed",
    ]),
    message: Schema.String,
  },
) {}

export const EditorialSubscribeInput = Schema.Struct({
  /** Last `seq` the client applied. The server replays from it or sends a new snapshot. */
  since: Schema.optionalKey(NonNegativeInt),
  sort: Schema.optionalKey(EditorialInboxSort),
});
export type EditorialSubscribeInput = typeof EditorialSubscribeInput.Type;

/**
 * `snapshot` replaces the client's inbox: first item, after a gap too large to replay and after
 * a run import. `trend` carries the current state of one trend; applying it twice is harmless.
 */
export const EditorialStreamItem = Schema.Union([
  Schema.TaggedStruct("snapshot", { seq: NonNegativeInt, inbox: EditorialInbox }),
  Schema.TaggedStruct("trend", {
    seq: NonNegativeInt,
    trendKey: EditorialTrendKey,
    state: EditorialTrendInboxState,
    newCount: NonNegativeInt,
  }),
]);
export type EditorialStreamItem = typeof EditorialStreamItem.Type;

const EditorialListRunsRpc = Rpc.make(EDITORIAL_WS_METHODS.listRuns, {
  payload: EditorialListRunsInput,
  success: EditorialListRunsResult,
  error: Schema.Union([EditorialReadError, EnvironmentAuthorizationError]),
});

const EditorialGetInboxRpc = Rpc.make(EDITORIAL_WS_METHODS.getInbox, {
  payload: EditorialGetInboxInput,
  success: EditorialInbox,
  error: Schema.Union([EditorialReadError, EnvironmentAuthorizationError]),
});

const EditorialGetDossierRpc = Rpc.make(EDITORIAL_WS_METHODS.getDossier, {
  payload: EditorialGetDossierInput,
  success: EditorialTrendDossier,
  error: Schema.Union([EditorialReadError, EnvironmentAuthorizationError]),
});

const EditorialSubscribeRpc = Rpc.make(EDITORIAL_WS_METHODS.subscribe, {
  payload: EditorialSubscribeInput,
  success: EditorialStreamItem,
  error: Schema.Union([EditorialReadError, EnvironmentAuthorizationError]),
  stream: true,
});

const commandError = Schema.Union([EditorialCommandError, EnvironmentAuthorizationError]);

const EditorialMarkReadRpc = Rpc.make(EDITORIAL_WS_METHODS.markRead, {
  payload: EditorialMarkReadInput,
  success: EditorialTrendStateResult,
  error: commandError,
});

const EditorialSnoozeRpc = Rpc.make(EDITORIAL_WS_METHODS.snooze, {
  payload: EditorialSnoozeInput,
  success: EditorialTrendStateResult,
  error: commandError,
});

const EditorialUnsnoozeRpc = Rpc.make(EDITORIAL_WS_METHODS.unsnooze, {
  payload: EditorialTrendKeyInput,
  success: EditorialTrendStateResult,
  error: commandError,
});

const EditorialDismissRpc = Rpc.make(EDITORIAL_WS_METHODS.dismiss, {
  payload: EditorialDismissInput,
  success: EditorialTrendStateResult,
  error: commandError,
});

const EditorialReopenRpc = Rpc.make(EDITORIAL_WS_METHODS.reopen, {
  payload: EditorialTrendKeyInput,
  success: EditorialTrendStateResult,
  error: commandError,
});

const EditorialCreateVideoRpc = Rpc.make(EDITORIAL_WS_METHODS.createVideo, {
  payload: EditorialCreateVideoInput,
  success: EditorialCreateVideoResult,
  error: commandError,
});

/** Merged into `WsRpcGroup`, so it shares the socket, the scope middleware and the typed client. */
export const EditorialRpcGroup = RpcGroup.make(
  EditorialListRunsRpc,
  EditorialGetInboxRpc,
  EditorialGetDossierRpc,
  EditorialSubscribeRpc,
  EditorialMarkReadRpc,
  EditorialSnoozeRpc,
  EditorialUnsnoozeRpc,
  EditorialDismissRpc,
  EditorialReopenRpc,
  EditorialCreateVideoRpc,
);

/**
 * Reads need `orchestration:read`. Inbox writes need `orchestration:operate`, the scope that
 * already separates acting from observing for threads; a session without it cannot change
 * editorial state. `createVideo` launches a T3 thread, which needs the same scope.
 */
export const EDITORIAL_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_WS_METHODS.listRuns]: AuthOrchestrationReadScope,
  [EDITORIAL_WS_METHODS.getInbox]: AuthOrchestrationReadScope,
  [EDITORIAL_WS_METHODS.getDossier]: AuthOrchestrationReadScope,
  [EDITORIAL_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [EDITORIAL_WS_METHODS.markRead]: AuthOrchestrationOperateScope,
  [EDITORIAL_WS_METHODS.snooze]: AuthOrchestrationOperateScope,
  [EDITORIAL_WS_METHODS.unsnooze]: AuthOrchestrationOperateScope,
  [EDITORIAL_WS_METHODS.dismiss]: AuthOrchestrationOperateScope,
  [EDITORIAL_WS_METHODS.reopen]: AuthOrchestrationOperateScope,
  [EDITORIAL_WS_METHODS.createVideo]: AuthOrchestrationOperateScope,
} as const;

/** Methods that change editorial state. Never registered as MCP tools or orchestration commands. */
export const EDITORIAL_WRITE_METHODS = [
  EDITORIAL_WS_METHODS.markRead,
  EDITORIAL_WS_METHODS.snooze,
  EDITORIAL_WS_METHODS.unsnooze,
  EDITORIAL_WS_METHODS.dismiss,
  EDITORIAL_WS_METHODS.reopen,
  EDITORIAL_WS_METHODS.createVideo,
] as const;
