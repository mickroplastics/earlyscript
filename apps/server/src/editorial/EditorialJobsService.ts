// @effect-diagnostics nodeBuiltinImport:off -- the shared embeddings cache defaults under the home directory, as the engine's does.
import * as NodeOS from "node:os";

import {
  EDITORIAL_JOB_PHASES,
  EditorialJobArtifacts,
  EditorialJobsError,
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
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import { SINGULARIDEV_PROFILE_V1 } from "./channelProfile.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialPresentationService } from "./EditorialPresentationService.ts";
import { EditorialSourcesService, type EnabledSources } from "./EditorialSourcesService.ts";
import {
  lastJsonLine,
  resolveEngineLocation,
  runEngineCommand,
  type EngineLocation,
} from "./engineProcess.ts";
import {
  canonicalJson,
  collectWindow,
  cutoffOf,
  isTimeZone,
  lastOccurrence,
  nextOccurrence,
  sha256,
} from "./nightlySchedule.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeNewId } from "./persistence/support.ts";
import { EditorialRunDirectory } from "./RunDirectory.ts";

const LIST_LIMIT = 30;
/** An empty corpus starts this many days back: the engine's 28-day curves. */
const INITIAL_CORPUS_DAYS = 28;
const DEFAULT_TIME_OF_DAY = "03:00";
const DEFAULT_WORKERS = 2;
/** A capture lock older than this outlived its process; a newer one may still be working. */
const STALE_COLLECT_LOCK_MS = 60 * 60_000;
const EMBEDDINGS_CACHE_ENV = "EARLYSCRIPT_EDITORIAL_EMBEDDINGS_CACHE";
const MODELS_DIR_ENV = "EARLYSCRIPT_EDITORIAL_MODELS_DIR";

export interface EditorialJobsOptions {
  readonly engine: EngineLocation;
  /** One directory per job, with its logs and the files it hands the engine. */
  readonly jobsDir: string;
  /** The channel profile file the engine reads; written from `channelProfile.ts`. */
  readonly profilePath: string;
  readonly cacheFile: string;
  /** Null leaves the engine's default model directory. */
  readonly modelsDir: string | null;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly retryDelayMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_JOB_TIMING = {
  leaseMs: 2 * 60_000,
  heartbeatMs: 30_000,
  retryDelayMs: 15 * 60_000,
  maxAttempts: 3,
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
  readonly status: EditorialJobStatus;
  readonly error: string | null;
  readonly artifacts_json: string;
}

const JOB_COLUMNS =
  "job_id, kind, profile_hash, cutoff_at, config_hash, timezone, scheduled_for, started_at, " +
  "finished_at, attempt, lease_until, status, error, artifacts_json";

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
}) {}

const fail = (message: string) => Effect.fail(new PhaseFailure({ message }));

interface PhaseOutcome {
  readonly status: "done" | "skipped";
  readonly note: string | null;
  readonly log?: string;
}

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
  const profileHash = sha256(SINGULARIDEV_PROFILE_V1);

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

  const settingsView = (stored: StoredSettings, nowMs: number): EditorialNightlySettings => {
    const next = stored.enabled ? nextOccurrence(stored.timeOfDay, stored.timezone, nowMs) : null;
    return {
      enabled: stored.enabled,
      timeOfDay: stored.timeOfDay,
      timezone: stored.timezone,
      workers: stored.workers,
      nextRunAt: next === null ? null : isoOf(next),
    };
  };

  const getSettings = Effect.gen(function* () {
    return settingsView(yield* readSettings, yield* Clock.currentTimeMillis);
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
    return settingsView(next, nowMs);
  });

  const plan: Effect.Effect<JobPlan, EditorialJobsError> = Effect.gen(function* () {
    const enabled = yield* sources.enabledSources.pipe(Effect.mapError(storage));
    const text = yield* fs
      .readFileString(options.engine.defaultConfig)
      .pipe(Effect.mapError(storage));
    const base = decodeConfigObject(text);
    if (Option.isNone(base)) {
      return yield* storage(`${options.engine.defaultConfig} is not a JSON object`);
    }
    // The engine reads its sources from the configuration, so the switches enter its hash.
    const config = { ...base.value, sources: enabled.rank };
    return { enabled, config, configHash: sha256(canonicalJson(config)), profileHash };
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
  }) {
    const jobId = yield* newId;
    const createdAt = isoOf(yield* Clock.currentTimeMillis);
    const artifacts = fallbackArtifacts(jobDirOf(jobId), input.plan.enabled);
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
        ? { status: "skipped" as const, error: "No source is enabled for the engine." }
        : {}),
    });
  });

  /** Takes the lease of the oldest due job: pending, or running with a lease that lapsed. */
  const claimDue = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const now = isoOf(nowMs);
    const leaseUntil = isoOf(nowMs + options.leaseMs);
    const rows = yield* sql<JobRow>`
      UPDATE editorial_jobs SET
        status = 'running',
        attempt = attempt + 1,
        lease_until = ${leaseUntil},
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
    return Option.fromNullishOr(rows[0]);
  });

  const execute = Effect.fn("EditorialJobsService.execute")(function* (claimed: JobRow) {
    const jobDir = jobDirOf(claimed.job_id);
    let artifacts = rowToJob(claimed).artifacts;
    let row = claimed;

    const publish = (next: JobRow) =>
      SubscriptionRef.set(active, next.status === "running" ? rowToJob(next) : null);

    const save = Effect.fn("EditorialJobsService.save")(function* (
      patch: Partial<EditorialJobArtifacts>,
    ) {
      artifacts = { ...artifacts, ...patch };
      const encoded = encodeArtifacts(artifacts);
      yield* sql`
        UPDATE editorial_jobs SET artifacts_json = ${encoded} WHERE job_id = ${row.job_id}
      `.pipe(Effect.mapError(storage));
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
      error: string | null,
      retryAtMs: number | null,
    ) {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE editorial_jobs SET
          status = ${status},
          error = ${error},
          lease_until = NULL,
          finished_at = ${retryAtMs === null ? isoOf(nowMs) : null},
          scheduled_for = ${retryAtMs === null ? row.scheduled_for : isoOf(retryAtMs)}
        WHERE job_id = ${row.job_id}
      `.pipe(Effect.mapError(storage));
      row = { ...row, status, error, lease_until: null };
      yield* save({ progress: null });
      yield* SubscriptionRef.set(active, null);
    });

    yield* fs.makeDirectory(jobDir, { recursive: true }).pipe(Effect.mapError(storage));
    yield* publish(row);

    if (row.attempt > options.maxAttempts) {
      return yield* finish("failed", row.error ?? "Too many attempts.", null);
    }

    const current = yield* plan;
    if (current.configHash !== row.config_hash || current.profileHash !== row.profile_hash) {
      // The switches changed since the job was created: a job of the new key takes its place.
      yield* save({ notes: [...artifacts.notes, "The engine configuration changed; replaced."] });
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

    const heartbeat = Effect.gen(function* () {
      const leaseUntil = isoOf((yield* Clock.currentTimeMillis) + options.leaseMs);
      yield* sql`
        UPDATE editorial_jobs SET lease_until = ${leaseUntil}
        WHERE job_id = ${row.job_id} AND status = 'running'
      `;
    }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced(`${options.heartbeatMs} millis`)));

    const settings = yield* readSettings;
    const ctx: PhaseContext = {
      job: row,
      jobDir,
      plan: current,
      workers: settings.workers,
      artifacts: () => artifacts,
      save,
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
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((ms) =>
                setPhase(phase, {
                  status: "failed",
                  finishedAt: isoOf(ms),
                  note: failure.message,
                }),
              ),
            ),
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

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.forkScoped(heartbeat);
        return yield* phases;
      }),
    ).pipe(
      Effect.matchEffect({
        onSuccess: () => finish("done", null, null),
        onFailure: Effect.fn("EditorialJobsService.retryOrFail")(function* (failure) {
          if (row.attempt < options.maxAttempts) {
            const nowMs = yield* Clock.currentTimeMillis;
            return yield* finish("pending", failure.message, nowMs + options.retryDelayMs);
          }
          return yield* finish("failed", failure.message, null);
        }),
      }),
      // A shutdown hands the job back at once instead of waiting for the lease to lapse.
      Effect.onInterrupt(() =>
        sql`
          UPDATE editorial_jobs SET
            status = 'pending', lease_until = NULL, attempt = MAX(attempt - 1, 0)
          WHERE job_id = ${row.job_id} AND status = 'running'
        `.pipe(Effect.ignore),
      ),
    );
  });

  interface PhaseContext {
    readonly job: JobRow;
    readonly jobDir: string;
    readonly plan: JobPlan;
    readonly workers: number;
    readonly artifacts: () => EditorialJobArtifacts;
    readonly save: (
      patch: Partial<EditorialJobArtifacts>,
    ) => Effect.Effect<void, EditorialJobsError>;
  }

  const engineRun = (
    ctx: PhaseContext,
    logName: string,
    args: ReadonlyArray<string>,
    onStderrLine?: (line: string) => Effect.Effect<void>,
  ) => {
    const logFile = path.join(ctx.jobDir, logName);
    const tail: Array<string> = [];
    return runEngineCommand(options.engine, {
      args,
      logFile,
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
      Effect.mapError(
        (cause) => new PhaseFailure({ message: `engine ${args[0]}: ${cause.message}` }),
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
      return yield* fail(`Another capture holds ${lockPath}.`);
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
      const feedsFile = path.join(ctx.jobDir, "rss-feeds.json");
      yield* fs
        .writeFileString(feedsFile, `${encodeJson(ctx.plan.enabled.rssFeeds)}\n`)
        .pipe(Effect.mapError(storage));
      args.push("--rss-feeds", feedsFile);
    }
    const output = yield* engineRun(ctx, "collect.log", args);
    if (output.exitCode !== 0) {
      return yield* fail(`engine collect exited with ${output.exitCode}: ${output.tail}`);
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
    if (lockNote !== null) notes.push(lockNote);
    if (window.missedDays.length > 0) {
      notes.push(
        `Backfill: ${window.missedDays.join(", ")} had no run; captured now, ranked only from this cutoff.`,
      );
    }
    yield* ctx.save({ collect, notes });
    return {
      status: "done",
      note: `${rows.length} source-days, ${collect.items} items, ${collect.incomplete} not complete.`,
      log: output.logFile,
    } satisfies PhaseOutcome;
  });

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
      if (
        run.status === "ok" &&
        run.cutoff_at === job.cutoff_at &&
        run.config_hash === job.config_hash &&
        run.profile.hash === job.profile_hash &&
        job.started_at !== null &&
        run.started_at >= job.started_at &&
        (found === null || run.started_at > found.startedAt)
      ) {
        found = { runId: run.run_id, startedAt: run.started_at };
      }
    }
    return found?.runId ?? null;
  });

  const ensureProfileFile = Effect.gen(function* () {
    const existing = yield* fs.readFileString(options.profilePath).pipe(Effect.option);
    if (Option.isSome(existing) && existing.value === SINGULARIDEV_PROFILE_V1) return;
    yield* fs.makeDirectory(path.dirname(options.profilePath), { recursive: true });
    yield* fs.writeFileString(options.profilePath, SINGULARIDEV_PROFILE_V1);
  }).pipe(Effect.mapError(storage));

  const runPhaseEngine = Effect.fn("EditorialJobsService.run")(function* (ctx: PhaseContext) {
    const onDisk = yield* findRunOnDisk(ctx.job);
    if (onDisk !== null) {
      yield* ctx.save({ runId: onDisk, runDir: path.join(runsDir, onDisk) });
      return {
        status: "done",
        note: `Found ${onDisk} on disk; not run again.`,
      } satisfies PhaseOutcome;
    }
    if (ctx.plan.enabled.rank.length === 0)
      return yield* fail("No source is enabled for the engine.");
    yield* ensureProfileFile;
    const configFile = path.join(ctx.jobDir, "engine-config.json");
    yield* fs
      .writeFileString(configFile, `${encodeJson(ctx.plan.config)}\n`)
      .pipe(Effect.mapError(storage));
    const args = [
      "run",
      "--corpus",
      corpusDir,
      "--cutoff",
      ctx.job.cutoff_at,
      "--profile",
      options.profilePath,
      "--out",
      runsDir,
      "--config",
      configFile,
      "--workers",
      String(ctx.workers),
      "--cache",
      options.cacheFile,
      ...(options.modelsDir === null ? [] : ["--models", options.modelsDir]),
    ];
    const output = yield* engineRun(ctx, "run.log", args, (line) =>
      Option.match(Option.flatMap(decodeJsonOption(line), decodeEmbedProgress), {
        onNone: () => Effect.void,
        onSome: (progress) =>
          ctx
            .save({ progress: { phase: "run", done: progress.inferred, total: progress.total } })
            .pipe(Effect.ignore),
      }),
    );
    const result = decodeRunResult(lastJsonLine(output.stdout));
    if (Option.isNone(result)) {
      return yield* fail(`engine run exited with ${output.exitCode}: ${output.tail}`);
    }
    if (output.exitCode !== 0 || result.value.status !== "ok") {
      return yield* fail(
        `engine run ${result.value.run_id} failed: ${result.value.error ?? output.tail}`,
      );
    }
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
    return runId === null ? fail("The job has no run.") : Effect.succeed(runId);
  };

  const checkPhase = Effect.fn("EditorialJobsService.check")(function* (ctx: PhaseContext) {
    const runId = yield* runIdOf(ctx);
    const output = yield* engineRun(ctx, "check.log", [
      "check",
      "--run",
      path.join(runsDir, runId),
    ]);
    const result = decodeCheckResult(lastJsonLine(output.stdout));
    if (output.exitCode !== 0 || Option.isNone(result) || !result.value.ok) {
      return yield* fail(
        `engine check did not reproduce ${runId}: ${output.tail || output.stdout.trim()}`,
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
    const report = yield* importer.sync.pipe(
      Effect.mapError((cause) => new PhaseFailure({ message: `import: ${cause.message}` })),
    );
    const outcome = report.runs.find((entry) => entry.runId === runId)?.outcome ?? "unchanged";
    if (outcome === "invalid") return yield* fail(`The importer rejected ${runId}.`);
    return { status: "done", note: `Run ${outcome}.` } satisfies PhaseOutcome;
  });

  const presentationsPhase = Effect.fn("EditorialJobsService.presentations")(function* (
    ctx: PhaseContext,
  ) {
    const runId = yield* runIdOf(ctx);
    const pending = Effect.fn("EditorialJobsService.presentationsPending")(function* (
      reason: string,
    ) {
      yield* ctx.save({ notes: [...ctx.artifacts().notes, `Presentations pending: ${reason}`] });
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
          presentations
            .runProgress(runId)
            .pipe(
              Effect.flatMap(report),
              Effect.ignore,
              Effect.repeat(Schedule.spaced("5 seconds")),
            ),
        );
        return yield* presentations.awaitRun(runId);
      }),
    ).pipe(Effect.option);
    if (Option.isNone(progress)) return yield* pending("the run could not be drafted.");
    yield* report(progress.value);
    const { ready, total } = progress.value;
    if (ready < total) return yield* pending(`${ready} of ${total} drafted.`);
    return { status: "done", note: `${total} drafted.` } satisfies PhaseOutcome;
  });

  function runPhase(
    phase: EditorialJobPhaseName,
    ctx: PhaseContext,
  ): Effect.Effect<PhaseOutcome, PhaseFailure | EditorialJobsError> {
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
    yield* execute(claimed.value);
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
  const engine = yield* resolveEngineLocation;
  const cache = yield* Config.String(EMBEDDINGS_CACHE_ENV).pipe(Config.option);
  const models = yield* Config.String(MODELS_DIR_ENV).pipe(Config.option);
  return {
    engine,
    jobsDir: path.join(stateDir, "editorial-jobs"),
    profilePath: path.join(stateDir, "editorial-profiles", "singularidev.v1.json"),
    // The engine's default: one cache shared by every run and backtest of this machine.
    cacheFile: Option.match(cache, {
      onNone: () =>
        path.join(NodeOS.homedir(), "earlyscript-data", "embeddings", "embeddings.sqlite"),
      onSome: (file) => path.resolve(file),
    }),
    modelsDir: Option.match(models, { onNone: () => null, onSome: (dir) => path.resolve(dir) }),
    ...DEFAULT_JOB_TIMING,
  } satisfies EditorialJobsOptions;
});

export const layer = Layer.effect(
  EditorialJobsService,
  resolveOptions.pipe(Effect.orDie, Effect.flatMap(makeWith)),
);

export const layerWith = (options: EditorialJobsOptions) =>
  Layer.effect(EditorialJobsService, makeWith(options));
