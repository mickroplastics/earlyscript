import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";

// Earlyscript nightly run: one durable job per profile, cutoff and engine configuration that
// captures the enabled sources, runs the trend engine, checks and imports the run and drafts
// its presentations. The server's Scheduler runs due jobs; nothing here starts an agent.

export const EDITORIAL_JOBS_WS_METHODS = {
  list: "editorial.jobs.list",
  runNow: "editorial.jobs.runNow",
  getSettings: "editorial.jobs.getSettings",
  updateSettings: "editorial.jobs.updateSettings",
  watch: "editorial.jobs.watch",
} as const;

const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

export const EDITORIAL_NIGHTLY_MAX_WORKERS = 16;
const Workers = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: EDITORIAL_NIGHTLY_MAX_WORKERS }),
);

export const EditorialJobStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
]);
export type EditorialJobStatus = typeof EditorialJobStatus.Type;

/** In execution order. */
export const EDITORIAL_JOB_PHASES = ["collect", "run", "check", "import", "presentations"] as const;
export const EditorialJobPhaseName = Schema.Literals(EDITORIAL_JOB_PHASES);
export type EditorialJobPhaseName = typeof EditorialJobPhaseName.Type;

export const EditorialJobPhaseStatus = Schema.Literals([
  "pending",
  "running",
  "done",
  "skipped",
  "failed",
]);
export type EditorialJobPhaseStatus = typeof EditorialJobPhaseStatus.Type;

export const EditorialJobPhase = Schema.Struct({
  phase: EditorialJobPhaseName,
  status: EditorialJobPhaseStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  /** What the phase found or decided, for the operator: days captured, a reused run. */
  note: Schema.NullOr(Schema.String),
  /** The phase's log file in the job directory, when it launched the engine. */
  log: Schema.NullOr(Schema.String),
});
export type EditorialJobPhase = typeof EditorialJobPhase.Type;

/**
 * Something the operator should know about a job, as a code with its data; the client words
 * it. The technical detail stays in `notes`, `error` and the phase logs.
 */
export const EditorialJobNoticeCode = Schema.Literals([
  "missed_days",
  "stale_lock_removed",
  "stale_engine_waited",
  "presentations_pending",
  "presentations_unavailable",
  "config_changed",
  "no_sources",
  "engine_missing",
  "engine_failed",
  "check_failed",
  "import_failed",
  "collect_locked",
  "storage",
  "too_many_attempts",
  "presentations_budget",
  "presentations_provider_disabled",
]);
export type EditorialJobNoticeCode = typeof EditorialJobNoticeCode.Type;

export const EditorialJobNotice = Schema.Struct({
  code: EditorialJobNoticeCode,
  phase: Schema.optionalKey(EditorialJobPhaseName),
  days: Schema.optionalKey(Schema.Array(Day)),
  ready: Schema.optionalKey(NonNegativeInt),
  total: Schema.optionalKey(NonNegativeInt),
  /** `presentations_budget`: trends drafted this month and the monthly cap. */
  used: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(NonNegativeInt),
});
export type EditorialJobNotice = typeof EditorialJobNotice.Type;

/** Days the capture reached; `missedDays` had no run and are not run after the fact. */
export const EditorialJobCollect = Schema.Struct({
  sources: Schema.Array(Schema.String),
  fromDay: Day,
  /** Exclusive, as in corpus/1. */
  toDay: Day,
  items: NonNegativeInt,
  incomplete: NonNegativeInt,
  missedDays: Schema.Array(Day),
});
export type EditorialJobCollect = typeof EditorialJobCollect.Type;

/** Live progress of the phase in flight; embedding reports texts, the others nothing. */
export const EditorialJobProgress = Schema.Struct({
  phase: EditorialJobPhaseName,
  done: Schema.NullOr(NonNegativeInt),
  total: Schema.NullOr(NonNegativeInt),
});
export type EditorialJobProgress = typeof EditorialJobProgress.Type;

export const EditorialJobArtifacts = Schema.Struct({
  jobDir: Schema.String,
  corpusDir: Schema.String,
  runsDir: Schema.String,
  sources: Schema.Struct({
    collect: Schema.Array(Schema.String),
    rank: Schema.Array(Schema.String),
  }),
  phases: Schema.Array(EditorialJobPhase),
  collect: Schema.NullOr(EditorialJobCollect),
  runId: Schema.NullOr(Schema.String),
  runDir: Schema.NullOr(Schema.String),
  dossiers: Schema.NullOr(NonNegativeInt),
  presentations: Schema.NullOr(
    Schema.Struct({ ready: NonNegativeInt, failed: NonNegativeInt, total: NonNegativeInt }),
  ),
  /** Technical notes in English, for logs and diagnosis; not shown as they are. */
  notes: Schema.Array(Schema.String),
  /** What the operator reads, in order. */
  notices: Schema.Array(EditorialJobNotice),
  /** Why the last attempt failed; null after a success. */
  failure: Schema.NullOr(EditorialJobNotice),
  progress: Schema.NullOr(EditorialJobProgress),
});
export type EditorialJobArtifacts = typeof EditorialJobArtifacts.Type;

export const EditorialJob = Schema.Struct({
  jobId: Schema.String,
  kind: Schema.Literal("daily"),
  profileHash: Schema.String,
  cutoffAt: IsoDateTime,
  configHash: Schema.String,
  timezone: Schema.String,
  scheduledFor: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  attempt: NonNegativeInt,
  status: EditorialJobStatus,
  /** Technical error of the last failed attempt; the client shows `artifacts.failure`. */
  error: Schema.NullOr(Schema.String),
  artifacts: EditorialJobArtifacts,
});
export type EditorialJob = typeof EditorialJob.Type;

export const EditorialJobsList = Schema.Struct({ jobs: Schema.Array(EditorialJob) });
export type EditorialJobsList = typeof EditorialJobsList.Type;

export const EditorialNightlySettings = Schema.Struct({
  enabled: Schema.Boolean,
  /** Local time of day, HH:MM, in `timezone`. */
  timeOfDay: TimeOfDay,
  /** IANA zone the time is read in: the server's zone when the setting was saved. */
  timezone: Schema.String,
  /** Embedding child processes of the engine run. */
  workers: Workers,
  /** The next scheduled time that would run a job (its cutoff has none yet); null while disabled. */
  nextRunAt: Schema.NullOr(IsoDateTime),
  /**
   * `editorial.activeEngineConfig`: the configuration file of the installed engine the nightly
   * run starts from. `engine.v1.json` until the operator chooses another one.
   */
  engineConfig: Schema.String,
  /** When the operator chose it; null while the default was never changed. */
  engineConfigChosenAt: Schema.NullOr(IsoDateTime),
  /** The configuration files the installed engine ships; empty without an engine. */
  engineConfigs: Schema.Array(Schema.String),
});
export type EditorialNightlySettings = typeof EditorialNightlySettings.Type;

export const EditorialNightlySettingsUpdateInput = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  timeOfDay: Schema.optionalKey(TimeOfDay),
  workers: Schema.optionalKey(Workers),
  /** Only an explicit operator action sends it; one of `engineConfigs`. */
  engineConfig: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^engine\.[A-Za-z0-9][A-Za-z0-9._-]*\.json$/)),
  ),
});
export type EditorialNightlySettingsUpdateInput = typeof EditorialNightlySettingsUpdateInput.Type;

/** The job in flight, or null when none runs; sent again on every change. */
export const EditorialJobActivity = Schema.Struct({ active: Schema.NullOr(EditorialJob) });
export type EditorialJobActivity = typeof EditorialJobActivity.Type;

export class EditorialJobsError extends Schema.TaggedError<EditorialJobsError>()(
  "EditorialJobsError",
  {
    reason: Schema.Literals(["unavailable", "storage", "invalid-settings", "no-sources"]),
    message: Schema.String,
  },
) {}

const jobsError = Schema.Union([EditorialJobsError, EnvironmentAuthorizationError]);

/** The latest 30 jobs, newest cutoff first, with their phases and errors. */
const EditorialJobsListRpc = Rpc.make(EDITORIAL_JOBS_WS_METHODS.list, {
  payload: Schema.Struct({}),
  success: EditorialJobsList,
  error: jobsError,
});

/**
 * Creates today's job when it does not exist and makes it due now. Idempotent: a job that
 * runs or finished is answered as it is; a failed one starts again from its missing phases.
 */
const EditorialJobsRunNowRpc = Rpc.make(EDITORIAL_JOBS_WS_METHODS.runNow, {
  payload: Schema.Struct({}),
  success: EditorialJob,
  error: jobsError,
});

const EditorialJobsGetSettingsRpc = Rpc.make(EDITORIAL_JOBS_WS_METHODS.getSettings, {
  payload: Schema.Struct({}),
  success: EditorialNightlySettings,
  error: jobsError,
});

const EditorialJobsUpdateSettingsRpc = Rpc.make(EDITORIAL_JOBS_WS_METHODS.updateSettings, {
  payload: EditorialNightlySettingsUpdateInput,
  success: EditorialNightlySettings,
  error: jobsError,
});

const EditorialJobsWatchRpc = Rpc.make(EDITORIAL_JOBS_WS_METHODS.watch, {
  payload: Schema.Struct({}),
  success: EditorialJobActivity,
  error: jobsError,
  stream: true,
});

/** Merged into `WsRpcGroup` next to the other editorial groups. */
export const EditorialJobsRpcGroup = RpcGroup.make(
  EditorialJobsListRpc,
  EditorialJobsRunNowRpc,
  EditorialJobsGetSettingsRpc,
  EditorialJobsUpdateSettingsRpc,
  EditorialJobsWatchRpc,
);

export const EDITORIAL_JOBS_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_JOBS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [EDITORIAL_JOBS_WS_METHODS.runNow]: AuthOrchestrationOperateScope,
  [EDITORIAL_JOBS_WS_METHODS.getSettings]: AuthOrchestrationReadScope,
  [EDITORIAL_JOBS_WS_METHODS.updateSettings]: AuthOrchestrationOperateScope,
  [EDITORIAL_JOBS_WS_METHODS.watch]: AuthOrchestrationReadScope,
} as const;
