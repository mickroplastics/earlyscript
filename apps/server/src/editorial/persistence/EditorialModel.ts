import * as Schema from "effect/Schema";

// Editorial primitives as stored in editorial.sqlite. Kept next to the storage
// until packages/editorial-contracts exists; the RPC contracts can import or
// mirror these schemas without depending on SQL.

export const EditorialActor = Schema.Literals(["operator", "system"]);
export type EditorialActor = typeof EditorialActor.Type;

export const VideoThreadMode = Schema.Literals(["assisted", "manual"]);
export type VideoThreadMode = typeof VideoThreadMode.Type;

export const VideoThreadLaunchState = Schema.Literals(["pending", "launched", "failed"]);
export type VideoThreadLaunchState = typeof VideoThreadLaunchState.Type;

/** Explorar, Leer (assisted dossier reading), Escribir, Decidir. */
export const WorkStage = Schema.Literals(["explore", "read", "write", "decide"]);
export type WorkStage = typeof WorkStage.Type;
export const WORK_STAGES: ReadonlyArray<WorkStage> = ["explore", "read", "write", "decide"];

export const DecisionAction = Schema.Literals(["accept", "edit", "reject"]);
export type DecisionAction = typeof DecisionAction.Type;

/**
 * "Seguir observando" returns the trend when its metric reaches `atLeast`.
 * The run importer evaluates it; this storage only records it.
 */
export const SnoozeReturnCondition = Schema.Struct({
  metric: Schema.String,
  baseline: Schema.Number,
  atLeast: Schema.Number,
});
export type SnoozeReturnCondition = typeof SnoozeReturnCondition.Type;

export const UnsnoozeCause = Schema.Literals(["operator", "growth", "expired"]);
export type UnsnoozeCause = typeof UnsnoozeCause.Type;

/** Raw inbox columns; the read side derives "new", "snoozed now" and counters. */
export const TrendInboxState = Schema.Struct({
  trendKey: Schema.String,
  seenRunId: Schema.NullOr(Schema.String),
  seenRunCutoffAt: Schema.NullOr(Schema.String),
  seenDossierId: Schema.NullOr(Schema.String),
  seenAt: Schema.NullOr(Schema.String),
  snoozedAt: Schema.NullOr(Schema.String),
  snoozedUntil: Schema.NullOr(Schema.String),
  snoozeReturn: Schema.NullOr(SnoozeReturnCondition),
  dismissedAt: Schema.NullOr(Schema.String),
  dismissedReason: Schema.NullOr(Schema.String),
  productionThreadId: Schema.NullOr(Schema.String),
  productionLinkedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type TrendInboxState = typeof TrendInboxState.Type;

export const VideoThread = Schema.Struct({
  threadId: Schema.String,
  environmentId: Schema.String,
  operationId: Schema.String,
  mode: VideoThreadMode,
  trendKey: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  dossierId: Schema.NullOr(Schema.String),
  dossierHash: Schema.NullOr(Schema.String),
  scriptPath: Schema.NullOr(Schema.String),
  launchState: VideoThreadLaunchState,
  createdBy: EditorialActor,
  createdAt: Schema.String,
});
export type VideoThread = typeof VideoThread.Type;

export const EditorialEventType = Schema.Literals([
  "trend.read",
  "trend.snoozed",
  "trend.unsnoozed",
  "trend.dismissed",
  "trend.reopened",
  "trend.production-linked",
  "video-thread.registered",
  "video-thread.launched",
  "video-thread.launch-failed",
  "work.started",
  "work.paused",
  "work.resumed",
  "work.stage-changed",
  "work.stopped",
  "work.recovery-needed",
  "work.resolved",
  "decision.recorded",
  "script.version-saved",
  "script.head-restored",
  "capture.saved",
  "result.saved",
  "run.imported",
  "run.updated",
  "run.invalidated",
]);
export type EditorialEventType = typeof EditorialEventType.Type;

export const EditorialAggregateKind = Schema.Literals(["trend", "video_thread", "run"]);
export type EditorialAggregateKind = typeof EditorialAggregateKind.Type;

export const EditorialEvent = Schema.Struct({
  seq: Schema.Number,
  type: EditorialEventType,
  aggregateKind: EditorialAggregateKind,
  aggregateId: Schema.String,
  operationId: Schema.NullOr(Schema.String),
  actor: EditorialActor,
  /** The authenticated session that issued a human command; null for system events. */
  actorSessionId: Schema.NullOr(Schema.String),
  payload: Schema.Unknown,
  createdAt: Schema.String,
});
export type EditorialEvent = typeof EditorialEvent.Type;

export const WorkClockState = Schema.Union([
  Schema.TaggedStruct("idle", {}),
  Schema.TaggedStruct("running", {
    stage: WorkStage,
    intervalId: Schema.String,
    since: Schema.String,
  }),
  Schema.TaggedStruct("paused", {
    stage: WorkStage,
    intervalId: Schema.String,
    since: Schema.String,
  }),
]);
export type WorkClockState = typeof WorkClockState.Type;

export const StageDuration = Schema.Struct({
  stage: WorkStage,
  activeMs: Schema.Number,
  segments: Schema.Number,
});
export type StageDuration = typeof StageDuration.Type;

export const UnresolvedInterval = Schema.Struct({
  intervalId: Schema.String,
  stage: WorkStage,
  startedAt: Schema.String,
  recoveredAt: Schema.NullOr(Schema.String),
});
export type UnresolvedInterval = typeof UnresolvedInterval.Type;

export const WorkClockSummary = Schema.Struct({
  threadId: Schema.String,
  state: WorkClockState,
  /** Stages that have at least one segment, in WORK_STAGES order. */
  stages: Schema.Array(StageDuration),
  activeMs: Schema.Number,
  pausedMs: Schema.Number,
  /** Segments left open by a crash; their duration counts only once resolved. */
  unresolved: Schema.Array(UnresolvedInterval),
  /** True when no segment awaits resolution. */
  definitive: Schema.Boolean,
  asOf: Schema.String,
});
export type WorkClockSummary = typeof WorkClockSummary.Type;

export const Decision = Schema.Struct({
  decisionId: Schema.String,
  threadId: Schema.String,
  action: DecisionAction,
  utility: Schema.Number,
  reason: Schema.NullOr(Schema.String),
  scriptVersionHash: Schema.NullOr(Schema.String),
  /** Null when the stage never ran, never zero by omission. */
  durations: Schema.Struct({
    exploreMs: Schema.NullOr(Schema.Number),
    readMs: Schema.NullOr(Schema.Number),
    writeMs: Schema.NullOr(Schema.Number),
    decideMs: Schema.NullOr(Schema.Number),
    totalMs: Schema.NullOr(Schema.Number),
  }),
  clockDefinitive: Schema.Boolean,
  actor: EditorialActor,
  decidedAt: Schema.String,
});
export type Decision = typeof Decision.Type;

export const ScriptVersion = Schema.Struct({
  versionId: Schema.String,
  threadId: Schema.String,
  contentHash: Schema.String,
  scriptPath: Schema.NullOr(Schema.String),
  savedAt: Schema.String,
});
export type ScriptVersion = typeof ScriptVersion.Type;

export const Capture = Schema.Struct({
  captureId: Schema.String,
  threadId: Schema.String,
  url: Schema.String,
  title: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  capturedAt: Schema.String,
});
export type Capture = typeof Capture.Type;

export const VideoResult = Schema.Struct({
  resultId: Schema.String,
  threadId: Schema.String,
  views: Schema.NullOr(Schema.Number),
  subscribers: Schema.NullOr(Schema.Number),
  clicks: Schema.NullOr(Schema.Number),
  comments: Schema.NullOr(Schema.Number),
  observedAt: Schema.String,
  recordedAt: Schema.String,
});
export type VideoResult = typeof VideoResult.Type;
