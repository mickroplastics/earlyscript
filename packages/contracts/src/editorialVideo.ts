import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";
import {
  EditorialResultsAction,
  EditorialResultsMode,
  EditorialResultsStage,
} from "./editorialResults.ts";

// Earlyscript video thread: the editorial side of one T3 thread (mode, dossier, work clock,
// script versions, decision and video results), stored in editorial.sqlite. Human commands
// only: none of these methods is an MCP tool or an orchestration command, so the agent of the
// thread cannot pause the clock, snapshot the script or decide.

export const EDITORIAL_VIDEO_WS_METHODS = {
  get: "editorial.video.get",
  subscribe: "editorial.video.subscribe",
  clock: "editorial.video.clock",
  saveScript: "editorial.video.saveScript",
  decide: "editorial.video.decide",
  saveResult: "editorial.video.saveResult",
} as const;

export const EditorialVideoClockState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("running", { stage: EditorialResultsStage, since: IsoDateTime }),
  Schema.TaggedStruct("paused", { stage: EditorialResultsStage, since: IsoDateTime }),
]);
export type EditorialVideoClockState = typeof EditorialVideoClockState.Type;

/** A segment a previous server process left open; it counts only once the operator resolves it. */
export const EditorialVideoUnresolvedInterval = Schema.Struct({
  intervalId: Schema.String,
  stage: EditorialResultsStage,
  startedAt: IsoDateTime,
  recoveredAt: Schema.NullOr(IsoDateTime),
});
export type EditorialVideoUnresolvedInterval = typeof EditorialVideoUnresolvedInterval.Type;

/**
 * Active time as of `asOf`, pauses and unresolved segments excluded. A running clock keeps
 * counting after `asOf`; clients interpolate from the moment they received it.
 */
export const EditorialVideoClock = Schema.Struct({
  state: EditorialVideoClockState,
  /** Stages with at least one segment, in work order. */
  stages: Schema.Array(
    Schema.Struct({
      stage: EditorialResultsStage,
      activeMs: NonNegativeInt,
      segments: NonNegativeInt,
    }),
  ),
  activeMs: NonNegativeInt,
  pausedMs: NonNegativeInt,
  unresolved: Schema.Array(EditorialVideoUnresolvedInterval),
  /** False while a segment awaits resolution: the durations are a floor. */
  definitive: Schema.Boolean,
  asOf: IsoDateTime,
});
export type EditorialVideoClock = typeof EditorialVideoClock.Type;

/**
 * An immutable snapshot of the script. `claims` and `cited` are the mechanical count of
 * `@earlyscript/editorial-script` (a sentence with a citation marker, not a claim a source
 * supports); null when the snapshot cannot be parsed.
 */
export const EditorialVideoScriptVersion = Schema.Struct({
  versionId: Schema.String,
  contentHash: Schema.String,
  savedAt: IsoDateTime,
  claims: Schema.NullOr(NonNegativeInt),
  cited: Schema.NullOr(NonNegativeInt),
});
export type EditorialVideoScriptVersion = typeof EditorialVideoScriptVersion.Type;

export const EditorialVideoScript = Schema.Struct({
  /** Relative to the thread's worktree, else its project's checkout. */
  path: Schema.NullOr(Schema.String),
  /** Whether the server could read the file when this view was built. */
  exists: Schema.Boolean,
  /** The version a decision must name: the latest one saved. */
  head: Schema.NullOr(EditorialVideoScriptVersion),
  versionCount: NonNegativeInt,
});
export type EditorialVideoScript = typeof EditorialVideoScript.Type;

export const EditorialVideoDecision = Schema.Struct({
  decisionId: Schema.String,
  action: EditorialResultsAction,
  utility: NonNegativeInt,
  reason: Schema.NullOr(Schema.String),
  scriptVersionHash: Schema.NullOr(Schema.String),
  /** Null when the stage never ran, never zero by omission. */
  durations: Schema.Struct({
    exploreMs: Schema.NullOr(NonNegativeInt),
    readMs: Schema.NullOr(NonNegativeInt),
    writeMs: Schema.NullOr(NonNegativeInt),
    decideMs: Schema.NullOr(NonNegativeInt),
    totalMs: Schema.NullOr(NonNegativeInt),
  }),
  clockDefinitive: Schema.Boolean,
  decidedAt: IsoDateTime,
});
export type EditorialVideoDecision = typeof EditorialVideoDecision.Type;

/** Video metrics typed by hand. Descriptive only, never attributed to the system. */
export const EditorialVideoResult = Schema.Struct({
  resultId: Schema.String,
  views: Schema.NullOr(NonNegativeInt),
  subscribers: Schema.NullOr(NonNegativeInt),
  clicks: Schema.NullOr(NonNegativeInt),
  comments: Schema.NullOr(NonNegativeInt),
  observedAt: IsoDateTime,
  recordedAt: IsoDateTime,
});
export type EditorialVideoResult = typeof EditorialVideoResult.Type;

export const EditorialVideoThread = Schema.Struct({
  threadId: Schema.String,
  mode: EditorialResultsMode,
  launchState: Schema.Literals(["pending", "launched", "failed"]),
  createdAt: IsoDateTime,
  trendKey: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  dossierId: Schema.NullOr(Schema.String),
  /** Assistant title of the dossier, else the engine label; null when the run is not readable. */
  trendTitle: Schema.NullOr(Schema.String),
});
export type EditorialVideoThread = typeof EditorialVideoThread.Type;

export const EditorialVideoState = Schema.Struct({
  thread: EditorialVideoThread,
  clock: EditorialVideoClock,
  script: EditorialVideoScript,
  /** The current decision: the most recent one. */
  decision: Schema.NullOr(EditorialVideoDecision),
  /** Most recent observation first, at most 20. */
  results: Schema.Array(EditorialVideoResult),
});
export type EditorialVideoState = typeof EditorialVideoState.Type;

/** Null for a thread with no editorial association: an ordinary T3 thread. */
export const EditorialVideoView = Schema.Struct({
  threadId: Schema.String,
  video: Schema.NullOr(EditorialVideoState),
});
export type EditorialVideoView = typeof EditorialVideoView.Type;

export const EditorialVideoThreadInput = Schema.Struct({ threadId: ThreadId });
export type EditorialVideoThreadInput = typeof EditorialVideoThreadInput.Type;

const Reason = Schema.String.check(Schema.isMaxLength(2_000));

export const EditorialVideoClockCommand = Schema.Union([
  /** Starts a stopped or recovered clock; refused while running or paused. */
  Schema.TaggedStruct("start", { stage: EditorialResultsStage }),
  Schema.TaggedStruct("pause", { reason: Schema.optionalKey(Reason) }),
  Schema.TaggedStruct("resume", {}),
  /** Closes the running stage and opens `stage`; from a pause, ends the pause too. */
  Schema.TaggedStruct("stage", { stage: EditorialResultsStage }),
  Schema.TaggedStruct("stop", {}),
  /** The operator says when a recovered segment actually ended. */
  Schema.TaggedStruct("resolve", { intervalId: Schema.String, endedAt: IsoDateTime }),
]);
export type EditorialVideoClockCommand = typeof EditorialVideoClockCommand.Type;

export const EditorialVideoClockInput = Schema.Struct({
  threadId: ThreadId,
  command: EditorialVideoClockCommand,
  /** Reused on a retry of the same click, so it applies once. */
  operationId: Schema.optionalKey(Schema.String),
});
export type EditorialVideoClockInput = typeof EditorialVideoClockInput.Type;

export const EditorialVideoDecideInput = Schema.Struct({
  threadId: ThreadId,
  action: EditorialResultsAction,
  utility: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  /** Required to edit or reject. */
  reason: Schema.optionalKey(Reason),
  /** The version the operator read; the server refuses when the script changed since. */
  scriptVersionHash: Schema.NullOr(Schema.String),
  operationId: Schema.String,
});
export type EditorialVideoDecideInput = typeof EditorialVideoDecideInput.Type;

export const EditorialVideoSaveResultInput = Schema.Struct({
  threadId: ThreadId,
  views: Schema.optionalKey(NonNegativeInt),
  subscribers: Schema.optionalKey(NonNegativeInt),
  clicks: Schema.optionalKey(NonNegativeInt),
  comments: Schema.optionalKey(NonNegativeInt),
  observedAt: IsoDateTime,
});
export type EditorialVideoSaveResultInput = typeof EditorialVideoSaveResultInput.Type;

export const EditorialVideoErrorReason = Schema.Literals([
  "unavailable",
  /** The thread has no editorial association, or the interval does not exist. */
  "not-found",
  "invalid-input",
  /** The script changed after the version the decision names. */
  "version-changed",
  /** The clock is not in a state that allows the command. */
  "clock-state",
  /** The thread was decided; its clock is final. */
  "decided",
  /** A result needs a decision first. */
  "not-decided",
  /** The script file is missing, outside the workspace or not text. */
  "script-file",
  "storage",
]);
export type EditorialVideoErrorReason = typeof EditorialVideoErrorReason.Type;

export class EditorialVideoError extends Schema.TaggedError<EditorialVideoError>()(
  "EditorialVideoError",
  {
    reason: EditorialVideoErrorReason,
    message: Schema.String,
  },
) {}

const videoError = Schema.Union([EditorialVideoError, EnvironmentAuthorizationError]);

const EditorialVideoGetRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.get, {
  payload: EditorialVideoThreadInput,
  success: EditorialVideoView,
  error: videoError,
});

/** The view, then a new view after each editorial event of the thread. */
const EditorialVideoSubscribeRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.subscribe, {
  payload: EditorialVideoThreadInput,
  success: EditorialVideoView,
  error: videoError,
  stream: true,
});

const EditorialVideoClockRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.clock, {
  payload: EditorialVideoClockInput,
  success: EditorialVideoState,
  error: videoError,
});

/** Snapshots the script file as it is on disk; the first save moves the clock from read to write. */
const EditorialVideoSaveScriptRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.saveScript, {
  payload: EditorialVideoThreadInput,
  success: EditorialVideoState,
  error: videoError,
});

const EditorialVideoDecideRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.decide, {
  payload: EditorialVideoDecideInput,
  success: EditorialVideoState,
  error: videoError,
});

const EditorialVideoSaveResultRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.saveResult, {
  payload: EditorialVideoSaveResultInput,
  success: EditorialVideoState,
  error: videoError,
});

/** Merged into `WsRpcGroup` next to the editorial and Results groups. */
export const EditorialVideoRpcGroup = RpcGroup.make(
  EditorialVideoGetRpc,
  EditorialVideoSubscribeRpc,
  EditorialVideoClockRpc,
  EditorialVideoSaveScriptRpc,
  EditorialVideoDecideRpc,
  EditorialVideoSaveResultRpc,
);

export const EDITORIAL_VIDEO_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_VIDEO_WS_METHODS.get]: AuthOrchestrationReadScope,
  [EDITORIAL_VIDEO_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [EDITORIAL_VIDEO_WS_METHODS.clock]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.saveScript]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.decide]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.saveResult]: AuthOrchestrationOperateScope,
} as const;
