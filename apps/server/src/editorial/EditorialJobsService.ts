// @effect-diagnostics nodeBuiltinImport:off -- the shared embeddings cache defaults under the home directory, as the engine's does.
import * as NodeOS from "node:os";

import {
  EDITORIAL_JOB_PHASES,
  EditorialJobArtifacts,
  EditorialJobNotice,
  EditorialJobsError,
  isDraftBudgetReached,
  type EditorialJob,
  type EditorialJobActivity,
  type EditorialJobPhase,
  type EditorialJobPhaseName,
  type EditorialJobsList,
  type EditorialJobStatus,
  type EditorialNightlySettings,
  type EditorialNightlySettingsUpdateInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialProfileService } from "./EditorialProfileService.ts";
import { EditorialPresentationService } from "./EditorialPresentationService.ts";
import { EditorialSourcesService, type EnabledSources } from "./EditorialSourcesService.ts";
import { EnginePromotionService, type PlannedEngine } from "./EnginePromotionService.ts";
import {
  EngineSpawnRejected,
  killProcess,
  lastJsonLine,
  LOCK_TOKEN_FLAG,
  modelsArgs,
  processesWithToken,
  resolveEngineLocation,
  resolveModelsDir,
  runEngineCommand,
  type EngineLocation,
  type EngineNotFound,
} from "./engineProcess.ts";
import {
  canonicalJson,
  collectWindow,
  cutoffOf,
  isTimeZone,
  lastOccurrence,
  nextUsefulOccurrence,
  sha256,
  upcomingOccurrences,
} from "./nightlySchedule.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId } from "./persistence/support.ts";
import { EditorialRunDirectory } from "./RunDirectory.ts";

const LIST_LIMIT = 30;
/** An empty corpus starts this many days back: the engine's 28-day curves. */
const INITIAL_CORPUS_DAYS = 28;
const DEFAULT_TIME_OF_DAY = "03:00";
const DEFAULT_WORKERS = 2;
/** Scheduled times `nextRunAt` looks through for one whose cutoff has no job yet. */
const NEXT_RUN_LOOKAHEAD = 7;
/** A capture lock older than this outlived its process; a newer one may still be working. */
const STALE_COLLECT_LOCK_MS = 60 * 60_000;
const EMBEDDINGS_CACHE_ENV = "EARLYSCRIPT_EDITORIAL_EMBEDDINGS_CACHE";

export interface EditorialJobsOptions {
  /** Found once at startup; without it every job reports `engine_missing` in its first phase. */
  readonly engine: Result.Result<EngineLocation, EngineNotFound>;
  /** One directory per job, with its logs and the files it hands the engine. */
  readonly jobsDir: string;
  /**
   * Where the studio profile files the engine reads are written, one per version hash, from
   * `EditorialProfileService`.
   */
  readonly profilesDir: string;
  readonly cacheFile: string;
  /** Null leaves the engine's default model directory. */
  readonly modelsDir: string | null;
  readonly leaseMs: number;
  /** Renewal period; a renewal that cannot happen before the lease lapses stops the job. */
  readonly heartbeatMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
  /** How often a new owner looks again for the former owner's engine child. */
  readonly pollMs: number;
  /** After waiting this long for that child, it is killed. */
  readonly staleEngineTimeoutMs: number;
}

export const DEFAULT_JOB_TIMING = {
  leaseMs: 2 * 60_000,
  heartbeatMs: 30_000,
  retryDelayMs: 15 * 60_000,
  maxAttempts: 3,
  pollMs: 1_000,
  staleEngineTimeoutMs: 2 * 60 * 60_000,
} as const;

export interface EditorialJobsServiceShape {
  readonly list: Effect.Effect<EditorialJobsList, EditorialJobsError>;
  readonly runNow: Effect.Effect<EditorialJob, EditorialJobsError>;
  readonly getSettings: Effect.Effect<EditorialNightlySettings, EditorialJobsError>;
  readonly updateSettings: (
    input: EditorialNightlySettingsUpdateInput,
  ) => Effect.Effect<EditorialNightlySettings, EditorialJobsError>;
  /** The job in flight, then every change to it; null while none runs. */
  readonly watch: Stream.Stream<EditorialJobActivity>;
  /**
   * One Scheduler pass: creates the job of the latest scheduled time when the nightly run is
   * on, then runs the oldest due job whose lease is free, from its first unfinished phase.
   */
  readonly runDue: Effect.Effect<void, EditorialJobsError>;
}

/** The nightly run's jobs over `editorial.sqlite`, and the engine they launch. */
export class EditorialJobsService extends Context.Service<
  EditorialJobsService,
  EditorialJobsServiceShape
>()("t3/editorial/EditorialJobsService") {}

interface JobRow {
  readonly job_id: string;
  readonly kind: "daily";
  readonly profile_hash: string;
  readonly cutoff_at: string;
  readonly config_hash: string;
  readonly timezone: string;
  readonly scheduled_for: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly attempt: number;
  readonly lease_until: string | null;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly prev_engine_token: string | null;
  readonly accepted_run_id: string | null;
  readonly status: EditorialJobStatus;
  readonly error: string | null;
  readonly artifacts_json: string;
}

const JOB_COLUMNS =
  "job_id, kind, profile_hash, cutoff_at, config_hash, timezone, scheduled_for, started_at, " +
  "finished_at, attempt, lease_until, lease_owner, lease_generation, prev_engine_token, " +
  "accepted_run_id, status, " +
  "error, artifacts_json";

interface SettingsRow {
  readonly enabled: number;
  readonly time_of_day: string;
  readonly timezone: string;
  readonly workers: number;
  readonly enabled_at: string | null;
}

interface StoredSettings {
  readonly enabled: boolean;
  readonly timeOfDay: string;
  readonly timezone: string;
  readonly workers: number;
  readonly enabledAt: string | null;
}

const ArtifactsJson = Schema.fromJsonString(EditorialJobArtifacts);
const decodeArtifacts = Schema.decodeUnknownOption(ArtifactsJson);
const encodeArtifacts = Schema.encodeSync(ArtifactsJson);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeConfigObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const ManifestHead = Schema.fromJsonString(Schema.Struct({ to_day: Schema.String }));
const decodeManifestHead = Schema.decodeUnknownOption(ManifestHead);

const CollectRows = Schema.Array(
  Schema.Struct({
    source: Schema.String,
    day: Schema.String,
    status: Schema.String,
    items: Schema.Number,
  }),
);
const decodeCollectRows = Schema.decodeUnknownOption(CollectRows);

const RunResult = Schema.Struct({
  run_id: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  dossiers: Schema.Number,
});
const decodeRunResult = Schema.decodeUnknownOption(RunResult);

const CheckResult = Schema.Struct({ ok: Schema.Boolean });
const decodeCheckResult = Schema.decodeUnknownOption(CheckResult);

const EmbedProgress = Schema.Struct({
  phase: Schema.Literal("embed"),
  inferred: Schema.Number,
  total: Schema.Number,
});
const decodeEmbedProgress = Schema.decodeUnknownOption(EmbedProgress);

/** The fields of a run.json that identify the job that wrote it. */
const RunJsonHead = Schema.fromJsonString(
  Schema.Struct({
    run_id: Schema.String,
    status: Schema.String,
    cutoff_at: Schema.String,
    config_hash: Schema.String,
    started_at: Schema.String,
    profile: Schema.Struct({ hash: Schema.String }),
  }),
);
const decodeRunJsonHead = Schema.decodeUnknownOption(RunJsonHead);

const storage = (cause: unknown) =>
  new EditorialJobsError({
    reason: "storage",
    message: `The nightly run storage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** A phase that could not finish; the job retries from it. */
class PhaseFailure extends Schema.TaggedError<PhaseFailure>()("PhaseFailure", {
  message: Schema.String,
  notice: EditorialJobNotice,
}) {}

/** Another claim took the job: this executor stops and writes nothing more. */
class LeaseLost extends Schema.TaggedError<LeaseLost>()("LeaseLost", {
  message: Schema.String,
}) {}

const fail = (message: string, notice: EditorialJobNotice) =>
  Effect.fail(new PhaseFailure({ message, notice }));

/** This executor's claim: every write of the job requires both fields. */
interface Lease {
  readonly owner: string;
  readonly generation: number;
  /** Until when the last claim or renewal holds, in epoch milliseconds. */
  validUntilMs: number;
}

interface PhaseOutcome {
  readonly status: "done" | "skipped";
  readonly note: string | null;
  readonly log?: string;
}

const phaseOfCommand = (command: string | undefined): EditorialJobPhaseName =>
  command === "collect" ? "collect" : command === "check" ? "check" : "run";

const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const emptyPhases = (): ReadonlyArray<EditorialJobPhase> =>
  EDITORIAL_JOB_PHASES.map((phase) => ({
    phase,
    status: "pending",
    startedAt: null,
    finishedAt: null,
    note: null,
    log: null,
  }));

const toJob = (row: JobRow, fallback: () => EditorialJobArtifacts): EditorialJob => ({
  jobId: row.job_id,
  kind: row.kind,
  profileHash: row.profile_hash,
  cutoffAt: row.cutoff_at,
  configHash: row.config_hash,
  timezone: row.timezone,
  scheduledFor: row.scheduled_for,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  attempt: row.attempt,
  status: row.status,
  error: row.error,
  artifacts: Option.getOrElse(decodeArtifacts(row.artifacts_json), fallback),
});

interface JobPlan {
  readonly enabled: EnabledSources;
  readonly config: Record<string, unknown>;
  readonly configHash: string;
  readonly profileHash: string;
  /** The active engine manifest the configuration came from (the engine lab's pointer). */
  readonly engine: Omit<PlannedEngine, "config">;
}

const makeWith = Effect.fn("EditorialJobsService.make")(function* (options: EditorialJobsOptions) {
  const sql = yield* EditorialSql;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sources = yield* EditorialSourcesService;
  const importer = yield* EditorialImportService;
  const presentations = yield* EditorialPresentationService;
  const directory = yield* EditorialRunDirectory;
  const newId = yield* makeNewId;
  // The engine runs under the services the layer was built with, not the Scheduler's.
  const context = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const active = yield* SubscriptionRef.make<EditorialJob | null>(null);
  const runsDir = directory.runsDir;
  const corpusDir = sources.corpusDir;
  const profiles = yield* EditorialProfileService;
  // Optional so the jobs service builds without the engine lab, as before it existed.
  const engineLab = yield* Effect.serviceOption(EnginePromotionService);

  const fallbackArtifacts = (jobDir: string, enabled?: EnabledSources): EditorialJobArtifacts => ({
    jobDir,
    corpusDir,
    runsDir,
    sources: { collect: enabled?.collect ?? [], rank: enabled?.rank ?? [] },
    phases: emptyPhases(),
    collect: null,
    runId: null,
    runDir: null,
    dossiers: null,
    presentations: null,
    notes: [],
    notices: [],
    failure: null,
    progress: null,
  });
  const jobDirOf = (jobId: string) => path.join(options.jobsDir, jobId);
  const rowToJob = (row: JobRow) => toJob(row, () => fallbackArtifacts(jobDirOf(row.job_id)));

  const readSettings = sql<SettingsRow>`
    SELECT enabled, time_of_day, timezone, workers, enabled_at
    FROM editorial_nightly_settings WHERE id = 1
  `.pipe(
    Effect.map((rows): StoredSettings => {
      const row = rows[0];
      if (row === undefined) {
        return {
          enabled: false,
          timeOfDay: DEFAULT_TIME_OF_DAY,
          timezone: systemTimeZone(),
          workers: DEFAULT_WORKERS,
          enabledAt: null,
        };
      }
      return {
        enabled: row.enabled === 1,
        timeOfDay: row.time_of_day,
        timezone: isTimeZone(row.timezone) ? row.timezone : "UTC",
        workers: row.workers,
        enabledAt: row.enabled_at,
      };
    }),
    Effect.mapError(storage),
  );

  /** The next scheduled time that would run a job, not one whose cutoff already has its job. */
  const nextRunAtOf = Effect.fn("EditorialJobsService.nextRunAt")(function* (
    stored: StoredSettings,
    nowMs: number,
  ) {
    if (!stored.enabled || stored.enabledAt === null) return null;
    const occurrences = upcomingOccurrences(
      stored.timeOfDay,
      stored.timezone,
      nowMs,
      NEXT_RUN_LOOKAHEAD,
    );
    const first = occurrences[0];
    const last = occurrences.at(-1);
    if (first === undefined || last === undefined) return null;
    const covered = yield* sql<{ readonly cutoff_at: string }>`
      SELECT DISTINCT cutoff_at FROM editorial_jobs
      WHERE kind = 'daily' AND cutoff_at >= ${cutoffOf(first)} AND cutoff_at <= ${cutoffOf(last)}
    `.pipe(Effect.mapError(storage));
    const next = nextUsefulOccurrence(
      occurrences,
      Date.parse(stored.enabledAt),
      new Set(covered.map((row) => row.cutoff_at)),
    );
    return next === null ? null : isoOf(next);
  });

  const settingsView = Effect.fn("EditorialJobsService.settingsView")(function* (
    stored: StoredSettings,
    nowMs: number,
  ) {
    return {
      enabled: stored.enabled,
      timeOfDay: stored.timeOfDay,
      timezone: stored.timezone,
      workers: stored.workers,
      nextRunAt: yield* nextRunAtOf(stored, nowMs),
    } satisfies EditorialNightlySettings;
  });

  const getSettings = Effect.gen(function* () {
    return yield* settingsView(yield* readSettings, yield* Clock.currentTimeMillis);
  }).pipe(Effect.withSpan("EditorialJobsService.getSettings"));

  const updateSettings = Effect.fn("EditorialJobsService.updateSettings")(function* (
    input: EditorialNightlySettingsUpdateInput,
  ) {
    const current = yield* readSettings;
    const nowMs = yield* Clock.currentTimeMillis;
    const now = isoOf(nowMs);
    const enabled = input.enabled ?? current.enabled;
    // Turning it on schedules from now on: a time already past today waits for tomorrow.
    const enabledAt = enabled ? (current.enabled ? (current.enabledAt ?? now) : now) : null;
    const next: StoredSettings = {
      enabled,
      timeOfDay: input.timeOfDay ?? current.timeOfDay,
      timezone: systemTimeZone(),
      workers: input.workers ?? current.workers,
      enabledAt,
    };
    yield* sql`
      INSERT INTO editorial_nightly_settings (
        id, enabled, time_of_day, timezone, workers, enabled_at, updated_at
      )
      VALUES (
        1, ${next.enabled ? 1 : 0}, ${next.timeOfDay}, ${next.timezone}, ${next.workers},
        ${next.enabledAt}, ${now}
      )
      ON CONFLICT (id) DO UPDATE SET
        enabled = excluded.enabled,
        time_of_day = excluded.time_of_day,
        timezone = excluded.timezone,
        workers = excluded.workers,
        enabled_at = excluded.enabled_at,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(storage));
    return yield* settingsView(next, nowMs);
  });

  const plan: Effect.Effect<JobPlan, EditorialJobsError> = Effect.gen(function* () {
    const enabled = yield* sources.enabledSources.pipe(Effect.mapError(storage));
    // No engine, no configuration to hash: the job still gets its row and shows why it failed.
    let base: Record<string, unknown> = {};
    if (Result.isSuccess(options.engine)) {
      const defaultConfig = options.engine.success.defaultConfig;
      const decoded = decodeConfigObject(
        yield* fs.readFileString(defaultConfig).pipe(Effect.mapError(storage)),
      );
      if (Option.isNone(decoded)) return yield* storage(`${defaultConfig} is not a JSON object`);
      base = decoded.value;
    }
    // The engine reads its sources from the configuration, so the switches enter its hash. The
    // active engine manifest (EnginePromotionService) chooses the rest; with none, the default.
    const { config, ...engine } =
      Option.isSome(engineLab) && Result.isSuccess(options.engine)
        ? yield* engineLab.value.planEngine({ defaultConfig: base, enabled })
        : {
            config: { ...base, sources: enabled.rank },
            manifestHash: null,
            engineSourceHash: null,
            stale: [] as ReadonlyArray<string>,
          };
    // The active profile enters the job key: a new version replaces a pending job.
    const profileHash = (yield* profiles.activeFile.pipe(Effect.mapError(storage))).hash;
    return { enabled, config, configHash: sha256(canonicalJson(config)), profileHash, engine };
  });

  const selectJob = (jobId: string) =>
    sql<JobRow>`
      SELECT ${sql.literal(JOB_COLUMNS)} FROM editorial_jobs WHERE job_id = ${jobId}
    `.pipe(
      Effect.mapError(storage),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(storage(`job ${jobId} vanished`))
          : Effect.succeed(rows[0]),
      ),
    );

  /** Inserts the job of this key unless it exists, and answers the stored one. */
  const ensureJob = Effect.fn("EditorialJobsService.ensureJob")(function* (input: {
    readonly cutoffAt: string;
    readonly scheduledFor: string;
    readonly timezone: string;
    readonly plan: JobPlan;
    readonly status?: EditorialJobStatus;
    readonly error?: string;
    readonly failure?: EditorialJobNotice;
  }) {
    const jobId = yield* newId;
    const createdAt = isoOf(yield* Clock.currentTimeMillis);
    const artifacts = {
      ...fallbackArtifacts(jobDirOf(jobId), input.plan.enabled),
      failure: input.failure ?? null,
    };
    yield* sql`
      INSERT INTO editorial_jobs (
        job_id, kind, profile_hash, cutoff_at, config_hash, timezone, scheduled_for,
        attempt, status, error, artifacts_json, created_at
      )
      VALUES (
        ${jobId}, 'daily', ${input.plan.profileHash}, ${input.cutoffAt}, ${input.plan.configHash},
        ${input.timezone}, ${input.scheduledFor}, 0, ${input.status ?? "pending"},
        ${input.error ?? null}, ${encodeArtifacts(artifacts)}, ${createdAt}
      )
      ON CONFLICT (kind, profile_hash, cutoff_at, config_hash) DO NOTHING
    `.pipe(Effect.mapError(storage));
    const rows = yield* sql<JobRow>`
      SELECT ${sql.literal(JOB_COLUMNS)} FROM editorial_jobs
      WHERE kind = 'daily' AND profile_hash = ${input.plan.profileHash}
        AND cutoff_at = ${input.cutoffAt} AND config_hash = ${input.plan.configHash}
    `.pipe(Effect.mapError(storage));
    const row = rows[0];
    if (row === undefined) return yield* storage("the job was not stored");
    return row;
  });

  const list = sql<JobRow>`
    SELECT ${sql.literal(JOB_COLUMNS)} FROM editorial_jobs
    ORDER BY cutoff_at DESC, created_at DESC
    LIMIT ${LIST_LIMIT}
  `.pipe(
    Effect.map((rows) => ({ jobs: rows.map(rowToJob) })),
    Effect.mapError(storage),
    Effect.withSpan("EditorialJobsService.list"),
  );

  const runNow = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = isoOf(nowMs);
    const current = yield* plan;
    if (current.enabled.rank.length === 0) {
      return yield* new EditorialJobsError({
        reason: "no-sources",
        message: "No source is enabled for the engine.",
      });
    }
    const settings = yield* readSettings;
    const row = yield* ensureJob({
      cutoffAt: cutoffOf(nowMs),
      scheduledFor: now,
      timezone: settings.timezone,
      plan: current,
    });
    // Pending: due now. Failed or skipped: again from the first unfinished phase.
    // Running or done: answered as they are.
    if (row.status === "pending" || row.status === "failed" || row.status === "skipped") {
      yield* sql`
        UPDATE editorial_jobs SET
          status = 'pending',
          scheduled_for = ${now},
          attempt = CASE WHEN status = 'pending' THEN attempt ELSE 0 END,
          finished_at = NULL
        WHERE job_id = ${row.job_id} AND status IN ('pending', 'failed', 'skipped')
      `.pipe(Effect.mapError(storage));
    }
    return rowToJob(yield* selectJob(row.job_id));
  }).pipe(Effect.withSpan("EditorialJobsService.runNow"));

  /** The job of the latest scheduled time, once per cutoff, when the nightly run is on. */
  const scheduleDue = Effect.gen(function* () {
    const settings = yield* readSettings;
    if (!settings.enabled || settings.enabledAt === null) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const occurrence = lastOccurrence(settings.timeOfDay, settings.timezone, nowMs);
    if (occurrence === null || occurrence < Date.parse(settings.enabledAt)) return;
    const cutoffAt = cutoffOf(occurrence);
    const existing = yield* sql<{ readonly found: number }>`
      SELECT 1 AS found FROM editorial_jobs WHERE kind = 'daily' AND cutoff_at = ${cutoffAt} LIMIT 1
    `.pipe(Effect.mapError(storage));
    if (existing.length > 0) return;
    const current = yield* plan;
    const noSources = current.enabled.rank.length === 0;
    yield* ensureJob({
      cutoffAt,
      scheduledFor: isoOf(occurrence),
      timezone: settings.timezone,
      plan: current,
      ...(noSources
        ? {
            status: "skipped" as const,
            error: "No source is enabled for the engine.",
            failure: { code: "no_sources" as const },
          }
        : {}),
    });
  });

  /**
   * Takes the lease of the oldest due job, pending or running with a lapsed lease, under a
   * new owner and generation. A former owner still running loses every write from here on.
   */
  const claimDue = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = isoOf(nowMs);
    const owner = yield* newId;
    const rows = yield* sql<JobRow>`
      UPDATE editorial_jobs SET
        status = 'running',
        attempt = attempt + 1,
        lease_until = ${isoOf(nowMs + options.leaseMs)},
        lease_owner = ${owner},
        lease_generation = lease_generation + 1,
        -- The former claim's child, kept across claims that never launched one.
        prev_engine_token = COALESCE(engine_token, prev_engine_token),
        prev_engine_pid = COALESCE(engine_pid, prev_engine_pid),
        engine_token = NULL,
        engine_pid = NULL,
        engine_started_at = NULL,
        started_at = COALESCE(started_at, ${now})
      WHERE job_id = (
        SELECT job_id FROM editorial_jobs
        WHERE status IN ('pending', 'running') AND scheduled_for <= ${now}
          AND (lease_until IS NULL OR lease_until < ${now})
        ORDER BY scheduled_for, created_at
        LIMIT 1
      )
        AND (lease_until IS NULL OR lease_until < ${now})
      RETURNING ${sql.literal(JOB_COLUMNS)}
    `.pipe(Effect.mapError(storage));
    return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
      row,
      lease: {
        owner,
        generation: row.lease_generation,
        validUntilMs: nowMs + options.leaseMs,
      } satisfies Lease,
    }));
  });

  const execute = Effect.fn("EditorialJobsService.execute")(function* (
    claimed: JobRow,
    lease: Lease,
  ) {
    const jobId = claimed.job_id;
    const jobDir = jobDirOf(jobId);
    let artifacts = rowToJob(claimed).artifacts;
    let row = claimed;

    const owned = (rows: ReadonlyArray<unknown>, what: string) =>
      rows.length > 0
        ? Effect.void
        : Effect.fail(
            new LeaseLost({
              message: `${what}: generation ${lease.generation} no longer holds job ${jobId}`,
            }),
          );

    const publish = (next: JobRow) =>
      SubscriptionRef.set(active, next.status === "running" ? rowToJob(next) : null);

    const save = Effect.fn("EditorialJobsService.save")(function* (
      patch: Partial<EditorialJobArtifacts>,
    ) {
      const next = { ...artifacts, ...patch };
      const encoded = encodeArtifacts(next);
      const rows = yield* sql<{ readonly job_id: string }>`
        UPDATE editorial_jobs SET artifacts_json = ${encoded}
        WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
          AND lease_generation = ${lease.generation}
        RETURNING job_id
      `.pipe(Effect.mapError(storage));
      yield* owned(rows, "save");
      artifacts = next;
      row = { ...row, artifacts_json: encoded };
      yield* publish(row);
    });

    const setPhase = (phase: EditorialJobPhaseName, patch: Partial<EditorialJobPhase>) =>
      save({
        phases: artifacts.phases.map((entry) =>
          entry.phase === phase ? { ...entry, ...patch } : entry,
        ),
      });

    const finish = Effect.fn("EditorialJobsService.finish")(function* (
      status: EditorialJobStatus,
      failure: { readonly message: string; readonly notice: EditorialJobNotice } | null,
      retryAtMs: number | null,
    ) {
      const nowMs = yield* Clock.currentTimeMillis;
      const next = { ...artifacts, progress: null, failure: failure?.notice ?? null };
      const encoded = encodeArtifacts(next);
      const rows = yield* sql<{ readonly job_id: string }>`
        UPDATE editorial_jobs SET
          status = ${status},
          error = ${failure?.message ?? null},
          lease_until = NULL,
          finished_at = ${retryAtMs === null ? isoOf(nowMs) : null},
          scheduled_for = ${retryAtMs === null ? row.scheduled_for : isoOf(retryAtMs)},
          artifacts_json = ${encoded}
        WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
          AND lease_generation = ${lease.generation}
        RETURNING job_id
      `.pipe(Effect.mapError(storage));
      yield* owned(rows, "finish");
      artifacts = next;
      row = { ...row, status, error: failure?.message ?? null, lease_until: null };
      yield* SubscriptionRef.set(active, null);
    });

    /** Renews the lease; fails when another claim took it or when it may lapse unrenewed. */
    const heartbeat = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(`${options.heartbeatMs} millis`);
        const nowMs = yield* Clock.currentTimeMillis;
        const renewed = yield* sql<{ readonly job_id: string }>`
          UPDATE editorial_jobs SET lease_until = ${isoOf(nowMs + options.leaseMs)}
          WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
            AND lease_generation = ${lease.generation} AND status = 'running'
          RETURNING job_id
        `.pipe(Effect.result);
        if (Result.isSuccess(renewed)) {
          yield* owned(renewed.success, "renew");
          lease.validUntilMs = nowMs + options.leaseMs;
          continue;
        }
        yield* Effect.logWarning("editorial: job lease renewal failed", {
          jobId,
          cause: renewed.failure,
        });
        if (nowMs + options.heartbeatMs >= lease.validUntilMs) {
          return yield* new LeaseLost({
            message: `renew: the lease of job ${jobId} would lapse before the next renewal`,
          });
        }
      }
    });

    /** Fails unless this executor still holds the job, right before it launches a child. */
    const confirmLease = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs >= lease.validUntilMs) {
        return yield* new LeaseLost({ message: `launch: the lease of job ${jobId} lapsed` });
      }
      const rows = yield* sql<{ readonly job_id: string }>`
        SELECT job_id FROM editorial_jobs
        WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
          AND lease_generation = ${lease.generation} AND status = 'running'
      `.pipe(Effect.mapError(storage));
      yield* owned(rows, "launch");
    });

    const token = `${jobId}:${lease.owner}:${lease.generation}`;

    /** Names this claim's engine on the row before the child starts; no row, no launch. */
    const publishEngine = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{ readonly job_id: string }>`
        UPDATE editorial_jobs SET
          engine_token = ${token}, engine_pid = NULL, engine_started_at = ${isoOf(nowMs)}
        WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
          AND lease_generation = ${lease.generation} AND status = 'running'
          AND lease_until > ${isoOf(nowMs)}
        RETURNING job_id
      `.pipe(Effect.mapError(storage));
      yield* owned(rows, "publish engine");
    });

    /** Records the child's pid; failing, the caller kills the child it just started. */
    const publishPid = Effect.fn("EditorialJobsService.publishPid")(function* (pid: number) {
      const nowMs = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{ readonly job_id: string }>`
        UPDATE editorial_jobs SET engine_pid = ${pid}
        WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
          AND lease_generation = ${lease.generation} AND status = 'running'
          AND engine_token = ${token} AND lease_until > ${isoOf(nowMs)}
        RETURNING job_id
      `.pipe(Effect.mapError(storage));
      yield* owned(rows, "publish pid");
    });

    /**
     * Records the run this claim keeps, the only one of the job's key the importer will take;
     * a former owner's choice fails here like any of its writes.
     */
    const acceptRun = Effect.fn("EditorialJobsService.acceptRun")(function* (runId: string) {
      const rows = yield* sql<{ readonly job_id: string }>`
        UPDATE editorial_jobs SET accepted_run_id = ${runId}
        WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
          AND lease_generation = ${lease.generation} AND status = 'running'
        RETURNING job_id
      `.pipe(Effect.mapError(storage));
      yield* owned(rows, "accept run");
    });

    const work = Effect.gen(function* () {
      yield* fs.makeDirectory(jobDir, { recursive: true }).pipe(Effect.mapError(storage));
      yield* publish(row);

      if (row.attempt > options.maxAttempts) {
        return yield* finish(
          "failed",
          { message: row.error ?? "Too many attempts.", notice: { code: "too_many_attempts" } },
          null,
        );
      }

      const current = yield* plan;
      if (current.configHash !== row.config_hash || current.profileHash !== row.profile_hash) {
        // The switches changed since the job was created: a job of the new key takes its place.
        yield* save({
          notes: [...artifacts.notes, "The engine configuration changed; replaced."],
          notices: [...artifacts.notices, { code: "config_changed" }],
        });
        yield* finish("skipped", null, null);
        if (current.enabled.rank.length > 0) {
          yield* ensureJob({
            cutoffAt: row.cutoff_at,
            scheduledFor: isoOf(yield* Clock.currentTimeMillis),
            timezone: row.timezone,
            plan: current,
          });
        }
        return;
      }
      yield* save({
        jobDir,
        corpusDir,
        runsDir,
        sources: { collect: current.enabled.collect, rank: current.enabled.rank },
      });

      const settings = yield* readSettings;
      const ctx: PhaseContext = {
        job: row,
        jobDir,
        lease,
        plan: current,
        workers: settings.workers,
        artifacts: () => artifacts,
        save,
        confirmLease,
        token,
        publishEngine,
        publishPid,
        acceptRun,
      };

      const phases = Effect.gen(function* () {
        for (const phase of EDITORIAL_JOB_PHASES) {
          const entry = artifacts.phases.find((candidate) => candidate.phase === phase);
          if (entry?.status === "done" || entry?.status === "skipped") continue;
          const startedAt = isoOf(yield* Clock.currentTimeMillis);
          yield* setPhase(phase, { status: "running", startedAt, finishedAt: null, note: null });
          yield* save({ progress: { phase, done: null, total: null } });
          const outcome = yield* runPhase(phase, ctx).pipe(
            Effect.tapError((failure) =>
              failure._tag === "PhaseFailure"
                ? Clock.currentTimeMillis.pipe(
                    Effect.flatMap((ms) =>
                      setPhase(phase, {
                        status: "failed",
                        finishedAt: isoOf(ms),
                        note: failure.message,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          yield* setPhase(phase, {
            status: outcome.status,
            finishedAt: isoOf(yield* Clock.currentTimeMillis),
            note: outcome.note,
            ...(outcome.log === undefined ? {} : { log: outcome.log }),
          });
        }
      });

      // Losing the lease interrupts the phases, and with them the engine child.
      yield* Effect.raceFirst(phases, heartbeat).pipe(
        Effect.matchEffect({
          onSuccess: () => finish("done", null, null),
          onFailure: Effect.fn("EditorialJobsService.retryOrFail")(function* (failure) {
            if (failure._tag === "LeaseLost") return yield* failure;
            const notice: EditorialJobNotice =
              failure._tag === "PhaseFailure" ? failure.notice : { code: "storage" };
            if (row.attempt < options.maxAttempts) {
              const nowMs = yield* Clock.currentTimeMillis;
              return yield* finish(
                "pending",
                { message: failure.message, notice },
                nowMs + options.retryDelayMs,
              );
            }
            return yield* finish("failed", { message: failure.message, notice }, null);
          }),
        }),
        // A shutdown hands the job back at once instead of waiting for the lease to lapse.
        Effect.onInterrupt(() =>
          sql`
            UPDATE editorial_jobs SET
              status = 'pending', lease_until = NULL, attempt = MAX(attempt - 1, 0)
            WHERE job_id = ${jobId} AND lease_owner = ${lease.owner}
              AND lease_generation = ${lease.generation} AND status = 'running'
          `.pipe(Effect.ignore),
        ),
      );
    });

    yield* work.pipe(
      Effect.catchTags({
        LeaseLost: (lost) =>
          Effect.logWarning("editorial: job taken over; this executor stopped", {
            jobId,
            generation: lease.generation,
            reason: lost.message,
          }).pipe(
            Effect.andThen(
              SubscriptionRef.update(active, (job) => (job?.jobId === jobId ? null : job)),
            ),
          ),
      }),
    );
  });

  interface PhaseContext {
    readonly job: JobRow;
    readonly jobDir: string;
    readonly lease: Lease;
    readonly plan: JobPlan;
    readonly workers: number;
    readonly artifacts: () => EditorialJobArtifacts;
    readonly save: (
      patch: Partial<EditorialJobArtifacts>,
    ) => Effect.Effect<void, EditorialJobsError | LeaseLost>;
    readonly confirmLease: Effect.Effect<void, EditorialJobsError | LeaseLost>;
    /** `<job>:<owner>:<generation>`, on the command line of every child of this claim. */
    readonly token: string;
    readonly publishEngine: Effect.Effect<void, EditorialJobsError | LeaseLost>;
    readonly publishPid: (pid: number) => Effect.Effect<void, EditorialJobsError | LeaseLost>;
    readonly acceptRun: (runId: string) => Effect.Effect<void, EditorialJobsError | LeaseLost>;
  }

  /** Files of one claim: a former owner still running cannot overwrite the current one's. */
  const jobFile = (ctx: PhaseContext, name: string, extension: string) =>
    path.join(ctx.jobDir, `${name}.g${ctx.lease.generation}.${extension}`);

  /**
   * Waits while the former claim's engine child lives (a process carrying its token), then
   * runs `body`, which reads the disk as that child left it. After the timeout only processes
   * carrying the token are killed.
   */
  const afterPreviousEngine = Effect.fn("EditorialJobsService.afterPreviousEngine")(function* <
    A,
    E,
    R,
  >(ctx: PhaseContext, body: Effect.Effect<A, E, R>) {
    const previous = ctx.job.prev_engine_token;
    if (previous !== null) {
      const waitStarted = yield* Clock.currentTimeMillis;
      let waited: { readonly pids: ReadonlyArray<number>; readonly killed: boolean } | null = null;
      while (true) {
        const pids = yield* processesWithToken(previous).pipe(Effect.provide(context));
        if (pids === null || pids.length === 0) break;
        const killed =
          (yield* Clock.currentTimeMillis) - waitStarted > options.staleEngineTimeoutMs;
        waited = { pids, killed };
        if (killed) for (const pid of pids) killProcess(pid);
        yield* Effect.sleep(`${options.pollMs} millis`);
      }
      if (waited !== null) {
        yield* ctx.save({
          notes: [
            ...ctx.artifacts().notes,
            `Waited for the engine ${waited.pids.join(", ")} of ${previous}${waited.killed ? "; killed after the timeout" : ""}.`,
          ],
          notices: [...ctx.artifacts().notices, { code: "stale_engine_waited" }],
        });
      }
    }
    return yield* body;
  });

  const engineRun = (
    ctx: PhaseContext,
    logName: string,
    args: ReadonlyArray<string>,
    onStderrLine?: (line: string) => Effect.Effect<void>,
  ) => {
    const logFile = jobFile(ctx, logName, "log");
    const tail: Array<string> = [];
    return Effect.fromResult(options.engine).pipe(
      Effect.mapError(
        (cause) => new PhaseFailure({ message: cause.message, notice: { code: "engine_missing" } }),
      ),
      Effect.tap(() => ctx.confirmLease),
      // Published before the child exists: a claim that took the job after this point finds
      // the token in prev_engine_token and waits for the child.
      Effect.tap(() => ctx.publishEngine),
      Effect.flatMap((engine) =>
        runEngineCommand(engine, {
          args: [...args, LOCK_TOKEN_FLAG, ctx.token],
          logFile,
          onSpawn: (pid) =>
            ctx
              .publishPid(pid)
              .pipe(
                Effect.mapError(
                  (cause) => new EngineSpawnRejected({ message: `child ${pid}: ${cause.message}` }),
                ),
              ),
          onStderrLine: (line) =>
            Effect.suspend(() => {
              if (line.trim().length > 0) {
                tail.push(line);
                if (tail.length > 5) tail.shift();
              }
              return onStderrLine?.(line) ?? Effect.void;
            }),
        }).pipe(
          Effect.provide(context),
          Effect.mapError((cause) =>
            cause._tag === "EngineSpawnRejected"
              ? new LeaseLost({ message: `launch: ${cause.message}` })
              : new PhaseFailure({
                  message: `engine ${args[0]}: ${cause.message}`,
                  notice: { code: "engine_failed", phase: phaseOfCommand(args[0]) },
                }),
          ),
        ),
      ),
      Effect.map((output) => ({ ...output, logFile, tail: tail.join("\n") })),
    );
  };

  const readCorpusToDay = Effect.gen(function* () {
    const text = yield* fs
      .readFileString(path.join(corpusDir, "corpus-manifest.json"))
      .pipe(Effect.option);
    return Option.match(Option.flatMap(text, decodeManifestHead), {
      onNone: () => null,
      onSome: (manifest) => manifest.to_day,
    });
  });

  /** A capture lock left by a process that died; a recent one belongs to a live capture. */
  const clearStaleLock = Effect.gen(function* () {
    const lockPath = path.join(corpusDir, ".collect.lock");
    const info = yield* fs.stat(lockPath).pipe(Effect.option);
    if (Option.isNone(info)) return null;
    const nowMs = yield* Clock.currentTimeMillis;
    const mtime = Option.match(info.value.mtime, {
      onNone: () => nowMs,
      onSome: (d) => d.getTime(),
    });
    if (nowMs - mtime < STALE_COLLECT_LOCK_MS) {
      return yield* fail(`Another capture holds ${lockPath}.`, { code: "collect_locked" });
    }
    yield* fs.remove(lockPath).pipe(Effect.ignore);
    return `Removed a stale capture lock from ${isoOf(mtime)}.`;
  });

  const collectPhase = Effect.fn("EditorialJobsService.collect")(function* (ctx: PhaseContext) {
    const collectSources = ctx.plan.enabled.collect;
    if (collectSources.length === 0) {
      return { status: "skipped", note: "No source has capture enabled." } satisfies PhaseOutcome;
    }
    const cutoffDay = ctx.job.cutoff_at.slice(0, 10);
    const window = collectWindow({
      corpusToDay: yield* readCorpusToDay,
      cutoffDay,
      initialDays: INITIAL_CORPUS_DAYS,
    });
    if (window === null) {
      return {
        status: "skipped",
        note: "The corpus already reaches yesterday.",
      } satisfies PhaseOutcome;
    }
    return yield* afterPreviousEngine(ctx, collectWithLock(ctx, window));
  });

  const collectWithLock = Effect.fn("EditorialJobsService.collectWithLock")(function* (
    ctx: PhaseContext,
    window: NonNullable<ReturnType<typeof collectWindow>>,
  ) {
    const collectSources = ctx.plan.enabled.collect;
    const lockNote = yield* clearStaleLock;
    const args = [
      "collect",
      "--corpus",
      corpusDir,
      "--sources",
      collectSources.join(","),
      "--from",
      window.fromDay,
      "--to",
      window.toDay,
    ];
    if (collectSources.includes("rss")) {
      const feedsFile = jobFile(ctx, "rss-feeds", "json");
      yield* fs
        .writeFileString(feedsFile, `${encodeJson(ctx.plan.enabled.rssFeeds)}\n`)
        .pipe(Effect.mapError(storage));
      args.push("--rss-feeds", feedsFile);
    }
    const output = yield* engineRun(ctx, "collect", args);
    if (output.exitCode !== 0) {
      return yield* fail(`engine collect exited with ${output.exitCode}: ${output.tail}`, {
        code: "engine_failed",
        phase: "collect",
      });
    }
    const rows = Option.getOrElse(decodeCollectRows(lastJsonLine(output.stdout)), () => []);
    const collect = {
      sources: [...collectSources],
      fromDay: window.fromDay,
      toDay: window.toDay,
      items: rows.reduce((sum, entry) => sum + Math.max(0, Math.trunc(entry.items)), 0),
      incomplete: rows.filter((entry) => entry.status !== "complete").length,
      missedDays: [...window.missedDays],
    };
    const notes = [...ctx.artifacts().notes];
    const notices = [...ctx.artifacts().notices];
    if (lockNote !== null) {
      notes.push(lockNote);
      notices.push({ code: "stale_lock_removed" });
    }
    if (window.missedDays.length > 0) {
      notes.push(
        `Backfill: ${window.missedDays.join(", ")} had no run; captured now, ranked only from this cutoff.`,
      );
      notices.push({ code: "missed_days", days: [...window.missedDays] });
    }
    yield* ctx.save({ collect, notes, notices });
    return {
      status: "done",
      note: `${rows.length} source-days, ${collect.items} items, ${collect.incomplete} not complete.`,
      log: output.logFile,
    } satisfies PhaseOutcome;
  });

  const isJobRun = (job: JobRow, run: typeof RunJsonHead.Type) =>
    run.status === "ok" &&
    run.cutoff_at === job.cutoff_at &&
    run.config_hash === job.config_hash &&
    run.profile.hash === job.profile_hash &&
    job.started_at !== null &&
    run.started_at >= job.started_at;

  /** A run this job already wrote: same cutoff, configuration and profile, after it started. */
  const findRunOnDisk = Effect.fn("EditorialJobsService.findRunOnDisk")(function* (job: JobRow) {
    const names = yield* fs.readDirectory(runsDir).pipe(Effect.orElseSucceed(() => []));
    let found: { readonly runId: string; readonly startedAt: string } | null = null;
    for (const name of names) {
      if (!name.startsWith("run_")) continue;
      const text = yield* fs
        .readFileString(path.join(runsDir, name, "run.json"))
        .pipe(Effect.option);
      const head = Option.flatMap(text, decodeRunJsonHead);
      if (Option.isNone(head)) continue;
      const run = head.value;
      if (isJobRun(job, run) && (found === null || run.started_at > found.startedAt)) {
        found = { runId: run.run_id, startedAt: run.started_at };
      }
    }
    return found?.runId ?? null;
  });

  /** Whether the run a previous claim accepted is still on disk, finished and the job's. */
  const acceptedOnDisk = Effect.fn("EditorialJobsService.acceptedOnDisk")(function* (job: JobRow) {
    const runId = job.accepted_run_id;
    if (runId === null) return null;
    const text = yield* fs
      .readFileString(path.join(runsDir, runId, "run.json"))
      .pipe(Effect.option);
    const head = Option.flatMap(text, decodeRunJsonHead);
    return Option.isSome(head) && head.value.run_id === runId && isJobRun(job, head.value)
      ? runId
      : null;
  });

  /**
   * Writes the profile version the job was keyed with (not whichever is active now, which may
   * have changed since the claim) and answers its path. Named by hash, so it never changes.
   */
  const ensureProfileFile = Effect.fn("EditorialJobsService.ensureProfileFile")(function* (
    profileHash: string,
  ) {
    const file = yield* profiles.fileByHash(profileHash).pipe(Effect.mapError(storage));
    if (Option.isNone(file)) return yield* storage(`no stored profile has ${profileHash}`);
    const target = path.join(options.profilesDir, `${profileHash.replace(/^sha256:/, "")}.json`);
    const existing = yield* fs.readFileString(target).pipe(Effect.option);
    if (Option.isSome(existing) && existing.value === file.value.bytes) return target;
    yield* fs
      .makeDirectory(options.profilesDir, { recursive: true })
      .pipe(Effect.mapError(storage));
    const tmp = `${target}.${yield* newId}.tmp`;
    yield* fs.writeFileString(tmp, file.value.bytes).pipe(Effect.mapError(storage));
    yield* fs.rename(tmp, target).pipe(Effect.mapError(storage));
    return target;
  });

  const runPhaseEngine = (ctx: PhaseContext) => afterPreviousEngine(ctx, runWithLock(ctx));

  const runWithLock = Effect.fn("EditorialJobsService.run")(function* (ctx: PhaseContext) {
    // A run a previous claim already accepted stays the job's run.
    const accepted = yield* acceptedOnDisk(ctx.job);
    // Read after the former engine ended: a former owner's child may have just written the run.
    const onDisk = accepted ?? (yield* findRunOnDisk(ctx.job));
    if (onDisk !== null) {
      yield* ctx.acceptRun(onDisk);
      yield* ctx.save({ runId: onDisk, runDir: path.join(runsDir, onDisk) });
      return {
        status: "done",
        note: `Found ${onDisk} on disk; not run again.`,
      } satisfies PhaseOutcome;
    }
    if (ctx.plan.enabled.rank.length === 0) {
      return yield* fail("No source is enabled for the engine.", { code: "no_sources" });
    }
    const profileFile = yield* ensureProfileFile(ctx.job.profile_hash);
    const configFile = jobFile(ctx, "engine-config", "json");
    yield* fs
      .writeFileString(configFile, `${encodeJson(ctx.plan.config)}\n`)
      .pipe(Effect.mapError(storage));
    // Which active engine manifest this run executes, beside the configuration it was given.
    yield* fs
      .writeFileString(
        jobFile(ctx, "engine-manifest", "json"),
        `${encodeJson({
          manifest_hash: ctx.plan.engine.manifestHash,
          config_hash: ctx.job.config_hash,
          profile_hash: ctx.job.profile_hash,
          engine_source_hash: ctx.plan.engine.engineSourceHash,
          stale: ctx.plan.engine.stale,
        })}\n`,
      )
      .pipe(Effect.mapError(storage));
    const args = [
      "run",
      "--corpus",
      corpusDir,
      "--cutoff",
      ctx.job.cutoff_at,
      "--profile",
      profileFile,
      "--out",
      runsDir,
      "--config",
      configFile,
      "--workers",
      String(ctx.workers),
      "--cache",
      options.cacheFile,
      ...modelsArgs(options.modelsDir),
    ];
    const output = yield* engineRun(ctx, "run", args, (line) =>
      Option.match(Option.flatMap(decodeJsonOption(line), decodeEmbedProgress), {
        onNone: () => Effect.void,
        onSome: (progress) =>
          ctx
            .save({ progress: { phase: "run", done: progress.inferred, total: progress.total } })
            // Progress only; a lost lease surfaces at the next renewal or guarded write.
            .pipe(Effect.ignore),
      }),
    );
    const result = decodeRunResult(lastJsonLine(output.stdout));
    const engineFailed = { code: "engine_failed", phase: "run" } as const;
    if (Option.isNone(result)) {
      return yield* fail(`engine run exited with ${output.exitCode}: ${output.tail}`, engineFailed);
    }
    if (output.exitCode !== 0 || result.value.status !== "ok") {
      return yield* fail(
        `engine run ${result.value.run_id} failed: ${result.value.error ?? output.tail}`,
        engineFailed,
      );
    }
    yield* ctx.acceptRun(result.value.run_id);
    yield* ctx.save({
      runId: result.value.run_id,
      runDir: path.join(runsDir, result.value.run_id),
      dossiers: Math.max(0, Math.trunc(result.value.dossiers)),
    });
    return {
      status: "done",
      note: `${result.value.run_id}: ${result.value.dossiers} dossiers.`,
      log: output.logFile,
    } satisfies PhaseOutcome;
  });

  const runIdOf = (ctx: PhaseContext) => {
    const runId = ctx.artifacts().runId;
    return runId === null
      ? fail("The job has no run.", { code: "engine_failed", phase: "run" })
      : Effect.succeed(runId);
  };

  const checkPhase = Effect.fn("EditorialJobsService.check")(function* (ctx: PhaseContext) {
    const runId = yield* runIdOf(ctx);
    const output = yield* afterPreviousEngine(
      ctx,
      engineRun(ctx, "check", ["check", "--run", path.join(runsDir, runId)]),
    );
    const result = decodeCheckResult(lastJsonLine(output.stdout));
    if (output.exitCode !== 0 || Option.isNone(result) || !result.value.ok) {
      return yield* fail(
        `engine check did not reproduce ${runId}: ${output.tail || output.stdout.trim()}`,
        { code: "check_failed" },
      );
    }
    return {
      status: "done",
      note: "Logical hash reproduced.",
      log: output.logFile,
    } satisfies PhaseOutcome;
  });

  const importPhase = Effect.fn("EditorialJobsService.import")(function* (ctx: PhaseContext) {
    const runId = yield* runIdOf(ctx);
    // Only the accepted run: any other run of this key is superseded by the importer.
    yield* ctx.acceptRun(runId);
    const result = yield* importer.importRun(runId).pipe(
      Effect.mapError(
        (cause) =>
          new PhaseFailure({
            message: `import: ${cause.message}`,
            notice: { code: "import_failed" },
          }),
      ),
    );
    if (result === null) {
      return yield* fail(`The run ${runId} is not on disk.`, { code: "import_failed" });
    }
    switch (result.outcome) {
      case "imported":
      case "updated":
      case "unchanged":
        return { status: "done", note: `Run ${result.outcome}.` } satisfies PhaseOutcome;
      case "duplicate": {
        // Same inputs and logical hash as a run already indexed: draft that one.
        const kept = result.keptRunId ?? runId;
        yield* ctx.save({ runId: kept, runDir: path.join(runsDir, kept) });
        return {
          status: "done",
          note: `Run ${runId} has the content of ${kept}, already indexed.`,
        } satisfies PhaseOutcome;
      }
      default:
        return yield* fail(`The importer did not take ${runId}: ${result.outcome}.`, {
          code: "import_failed",
        });
    }
  });

  const presentationsPhase = Effect.fn("EditorialJobsService.presentations")(function* (
    ctx: PhaseContext,
  ) {
    const runId = yield* runIdOf(ctx);
    const pending = Effect.fn("EditorialJobsService.presentationsPending")(function* (
      reason: string,
      notice: EditorialJobNotice,
    ) {
      yield* ctx.save({
        notes: [...ctx.artifacts().notes, `Presentations pending: ${reason}`],
        notices: [...ctx.artifacts().notices, notice],
      });
      return { status: "done", note: `Presentations pending: ${reason}` } satisfies PhaseOutcome;
    });
    const report = (progress: { ready: number; failed: number; total: number }) =>
      ctx.save({
        presentations: { ready: progress.ready, failed: progress.failed, total: progress.total },
        progress: { phase: "presentations", done: progress.ready, total: progress.total },
      });
    const progress = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* presentations.startRun(runId);
        yield* Effect.forkScoped(
          presentations.runProgress(runId).pipe(
            Effect.flatMap(report),
            // Progress only; a lost lease surfaces at the next renewal or guarded write.
            Effect.ignore,
            Effect.repeat(Schedule.spaced("5 seconds")),
          ),
        );
        return yield* presentations.awaitRun(runId);
      }),
    ).pipe(Effect.catchTags({ EditorialPresentationError: () => Effect.succeed(null) }));
    if (progress === null) {
      return yield* pending("the run could not be drafted.", { code: "presentations_unavailable" });
    }
    yield* report(progress);
    const { ready, total } = progress;
    if (ready < total) {
      // A disabled provider or the monthly cap stops drafting without failing the job: the rest
      // can be drafted later.
      const enabled = yield* presentations.draftingProviderEnabled.pipe(Effect.option);
      if (Option.isSome(enabled) && !enabled.value) {
        return yield* pending(`the drafting provider is disabled, ${ready} of ${total} drafted.`, {
          code: "presentations_provider_disabled",
          ready,
          total,
        });
      }
      const budget = yield* presentations.getBudget.pipe(Effect.option);
      if (Option.isSome(budget) && isDraftBudgetReached(budget.value)) {
        return yield* pending(`monthly cap reached, ${ready} of ${total} drafted.`, {
          code: "presentations_budget",
          ready,
          total,
          used: budget.value.usedThisMonth,
          limit: budget.value.monthlyLimit,
        });
      }
      return yield* pending(`${ready} of ${total} drafted.`, {
        code: "presentations_pending",
        ready,
        total,
      });
    }
    return { status: "done", note: `${total} drafted.` } satisfies PhaseOutcome;
  });

  function runPhase(
    phase: EditorialJobPhaseName,
    ctx: PhaseContext,
  ): Effect.Effect<PhaseOutcome, PhaseFailure | EditorialJobsError | LeaseLost> {
    switch (phase) {
      case "collect":
        return collectPhase(ctx);
      case "run":
        return runPhaseEngine(ctx);
      case "check":
        return checkPhase(ctx);
      case "import":
        return importPhase(ctx);
      case "presentations":
        return presentationsPhase(ctx);
    }
  }

  const runDue = Effect.gen(function* () {
    yield* scheduleDue;
    const claimed = yield* claimDue;
    if (Option.isNone(claimed)) return;
    yield* execute(claimed.value.row, claimed.value.lease);
  }).pipe(Effect.withSpan("EditorialJobsService.runDue"));

  const watch = SubscriptionRef.changes(active).pipe(
    Stream.map((job): EditorialJobActivity => ({ active: job })),
  );

  return EditorialJobsService.of({
    list,
    runNow,
    getSettings,
    updateSettings,
    watch,
    runDue,
  });
});

/** Paths from the environment and the server's state directory. */
const resolveOptions = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const engine = yield* resolveEngineLocation.pipe(
    Effect.map(Result.succeed),
    Effect.catchTags({ EngineNotFound: (missing) => Effect.succeed(Result.fail(missing)) }),
  );
  if (Result.isFailure(engine)) yield* Effect.logWarning(engine.failure.message);
  const cache = yield* Config.String(EMBEDDINGS_CACHE_ENV).pipe(Config.option);
  return {
    engine,
    jobsDir: path.join(stateDir, "editorial-jobs"),
    profilesDir: path.join(stateDir, "editorial-profiles"),
    // The engine's default: one cache shared by every run and backtest of this machine.
    cacheFile: Option.match(cache, {
      onNone: () =>
        path.join(NodeOS.homedir(), "earlyscript-data", "embeddings", "embeddings.sqlite"),
      onSome: (file) => path.resolve(file),
    }),
    modelsDir: yield* resolveModelsDir,
    ...DEFAULT_JOB_TIMING,
  } satisfies EditorialJobsOptions;
});

export const layer = Layer.effect(
  EditorialJobsService,
  resolveOptions.pipe(Effect.orDie, Effect.flatMap(makeWith)),
);

export const layerWith = (options: EditorialJobsOptions) =>
  Layer.effect(EditorialJobsService, makeWith(options));
