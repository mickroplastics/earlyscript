import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { EditorialTrendKey } from "./editorial.ts";
import { ModelSelection } from "./modelSelection.ts";
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
  openVersion: "editorial.video.openVersion",
  createManual: "editorial.video.createManual",
  capture: "editorial.video.capture",
  removeCapture: "editorial.video.removeCapture",
  purge: "editorial.video.purge",
  prepare: "editorial.video.prepare",
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
  /**
   * The read-only Markdown copy of the dossier the server writes next to the script
   * (`videos/<slug>/expediente.md`); null for a thread without a dossier. Absent from older
   * servers.
   */
  dossierPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  /**
   * The T3 thread was deleted, or is gone after its launch. Its editorial record stays until
   * `purge`; work commands answer `thread-deleted`.
   */
  deleted: Schema.Boolean,
});
export type EditorialVideoThread = typeof EditorialVideoThread.Type;

/** A finding the operator kept while exploring by hand: the page, and a note in their words. */
export const EditorialVideoCapture = Schema.Struct({
  captureId: Schema.String,
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  capturedAt: IsoDateTime,
});
export type EditorialVideoCapture = typeof EditorialVideoCapture.Type;

/**
 * A page the integrated browser finished loading in a manual thread, recorded by the server
 * from the preview state it receives, so a client reload loses none. `origin` is the browser
 * runtime that reported it: `desktop`, `server`, or `automation` when a tool drove the tab.
 */
export const EditorialVideoBrowserVisit = Schema.Struct({
  visitId: Schema.String,
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  origin: Schema.Literals(["desktop", "server", "automation"]),
  visitedAt: IsoDateTime,
});
export type EditorialVideoBrowserVisit = typeof EditorialVideoBrowserVisit.Type;

export const EditorialVideoState = Schema.Struct({
  thread: EditorialVideoThread,
  clock: EditorialVideoClock,
  script: EditorialVideoScript,
  /** The current decision: the most recent one. */
  decision: Schema.NullOr(EditorialVideoDecision),
  /** Most recent observation first, at most 20. */
  results: Schema.Array(EditorialVideoResult),
  /** Kept captures, oldest first; a removed one leaves only its events. */
  captures: Schema.Array(EditorialVideoCapture),
  /** Browser history of a manual thread, most recent first, at most 200; empty when assisted. */
  visits: Schema.Array(EditorialVideoBrowserVisit),
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

/** How the server names a script version: SHA-256 of its content, lowercase hex. */
export const EditorialScriptContentHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const EditorialVideoOpenVersionInput = Schema.Struct({
  threadId: ThreadId,
  contentHash: EditorialScriptContentHash,
});
export type EditorialVideoOpenVersionInput = typeof EditorialVideoOpenVersionInput.Type;

/** An absolute host path holding the version's snapshot, read-only, outside the workspace. */
export const EditorialVideoOpenVersionResult = Schema.Struct({ path: Schema.String });
export type EditorialVideoOpenVersionResult = typeof EditorialVideoOpenVersionResult.Type;

export const EditorialVideoPrepareInput = Schema.Struct({ threadId: ThreadId });
export type EditorialVideoPrepareInput = typeof EditorialVideoPrepareInput.Type;

/** `prepared`: something of the thread's folder was missing or not its own and was written. */
export const EditorialVideoPrepareResult = Schema.Struct({ prepared: Schema.Boolean });
export type EditorialVideoPrepareResult = typeof EditorialVideoPrepareResult.Type;

export const EditorialVideoSaveResultInput = Schema.Struct({
  threadId: ThreadId,
  views: Schema.optionalKey(NonNegativeInt),
  subscribers: Schema.optionalKey(NonNegativeInt),
  clicks: Schema.optionalKey(NonNegativeInt),
  comments: Schema.optionalKey(NonNegativeInt),
  observedAt: IsoDateTime,
});
export type EditorialVideoSaveResultInput = typeof EditorialVideoSaveResultInput.Type;

/**
 * "Nuevo hilo manual" from the Threads space: a video thread with no dossier, no chat and no
 * agent, its clock in Explorar. `trendKey` records, for the paired comparison, that it works
 * the same topic as that trend; it shows nothing of the trend in the thread.
 */
export const EditorialVideoCreateManualInput = Schema.Struct({
  /** Generated once by the client per creation and reused on retries. */
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** The server's studio project when omitted, as for "Crear hilo de video". */
  projectId: Schema.optionalKey(ProjectId),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  /** Kept on the thread for its T3 shell; the policy refuses to run it. */
  modelSelection: ModelSelection,
  trendKey: Schema.optionalKey(EditorialTrendKey),
});
export type EditorialVideoCreateManualInput = typeof EditorialVideoCreateManualInput.Type;

export const EditorialVideoCreateManualResult = Schema.Struct({
  threadId: ThreadId,
  /** False when a retry found the operation already done. */
  created: Schema.Boolean,
});
export type EditorialVideoCreateManualResult = typeof EditorialVideoCreateManualResult.Type;

export const EditorialVideoCaptureInput = Schema.Struct({
  threadId: ThreadId,
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_000))),
  note: Schema.optionalKey(Reason),
});
export type EditorialVideoCaptureInput = typeof EditorialVideoCaptureInput.Type;

export const EditorialVideoRemoveCaptureInput = Schema.Struct({
  threadId: ThreadId,
  captureId: Schema.String,
});
export type EditorialVideoRemoveCaptureInput = typeof EditorialVideoRemoveCaptureInput.Type;

export const EditorialVideoPurgeInput = Schema.Struct({ threadId: ThreadId });
export type EditorialVideoPurgeInput = typeof EditorialVideoPurgeInput.Type;

/** What a purge deleted, row by row and file by file. */
export const EditorialVideoPurgeResult = Schema.Struct({
  threadId: ThreadId,
  deleted: Schema.Struct({
    visits: NonNegativeInt,
    captures: NonNegativeInt,
    scriptVersions: NonNegativeInt,
    versionFiles: NonNegativeInt,
    decisions: NonNegativeInt,
    results: NonNegativeInt,
    workIntervals: NonNegativeInt,
    events: NonNegativeInt,
  }),
});
export type EditorialVideoPurgeResult = typeof EditorialVideoPurgeResult.Type;

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
  /** A segment recovered after a restart must be resolved before deciding. */
  "clock-unresolved",
  /** A result needs a decision first. */
  "not-decided",
  /** The script file is missing, outside the workspace or not text. */
  "script-file",
  /** The T3 thread was deleted: its record can be read or purged, not worked on. */
  "thread-deleted",
  /** A purge needs the T3 thread deleted first, so a live thread never loses its mode. */
  "thread-live",
  /**
   * The video thread was registered but T3 did not create it: its project is gone or cloning,
   * its provider is off, or the launch failed. The message is the server's Spanish text for it.
   */
  "launch",
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

/**
 * Snapshots the script, then decides in one transaction that moves the clock to Decidir and
 * stops it. A stale hash fails with `version-changed` yet keeps that snapshot and its event:
 * the head becomes the version on disk, to review. `clock-unresolved` while a segment waits.
 */
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

/** Writes the snapshot of a saved version to a read-only file the file surface can show. */
const EditorialVideoOpenVersionRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.openVersion, {
  payload: EditorialVideoOpenVersionInput,
  success: EditorialVideoOpenVersionResult,
  error: videoError,
});

const EditorialVideoCreateManualRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.createManual, {
  payload: EditorialVideoCreateManualInput,
  success: EditorialVideoCreateManualResult,
  error: videoError,
});

/** Keeps a page of the integrated browser with the operator's note; refused once decided. */
const EditorialVideoCaptureRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.capture, {
  payload: EditorialVideoCaptureInput,
  success: EditorialVideoState,
  error: videoError,
});

/** Takes a capture off the list; its saved and removed events stay. Refused once decided. */
const EditorialVideoRemoveCaptureRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.removeCapture, {
  payload: EditorialVideoRemoveCaptureInput,
  success: EditorialVideoState,
  error: videoError,
});

/**
 * Deletes a video thread's editorial record and its version copies for good; one event with
 * counts remains. Only once the T3 thread is deleted (`thread-live` otherwise): a live manual
 * thread without its record would lose the policy that keeps agents out.
 */
const EditorialVideoPurgeRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.purge, {
  payload: EditorialVideoPurgeInput,
  success: EditorialVideoPurgeResult,
  error: videoError,
});

/**
 * Writes what is missing of a video thread's folder (script, dossier file, the studio's
 * instructions) without replacing anything that is there. Idempotent; nothing for a decided
 * thread. "Abrir hilo de video" calls it, since the thread's subscription may already be live.
 */
const EditorialVideoPrepareRpc = Rpc.make(EDITORIAL_VIDEO_WS_METHODS.prepare, {
  payload: EditorialVideoPrepareInput,
  success: EditorialVideoPrepareResult,
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
  EditorialVideoOpenVersionRpc,
  EditorialVideoCreateManualRpc,
  EditorialVideoCaptureRpc,
  EditorialVideoRemoveCaptureRpc,
  EditorialVideoPurgeRpc,
  EditorialVideoPrepareRpc,
);

export const EDITORIAL_VIDEO_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_VIDEO_WS_METHODS.get]: AuthOrchestrationReadScope,
  [EDITORIAL_VIDEO_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [EDITORIAL_VIDEO_WS_METHODS.clock]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.saveScript]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.decide]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.saveResult]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.openVersion]: AuthOrchestrationReadScope,
  [EDITORIAL_VIDEO_WS_METHODS.createManual]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.capture]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.removeCapture]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.purge]: AuthOrchestrationOperateScope,
  [EDITORIAL_VIDEO_WS_METHODS.prepare]: AuthOrchestrationOperateScope,
} as const;
