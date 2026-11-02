import {
  EDITORIAL_DRAFT_BUDGET_DEFAULT,
  EditorialDossierId,
  EditorialPresentationError,
  EditorialRunId,
  isDraftBudgetReached,
  type EditorialDraftBudget,
  type EditorialPresentationResult,
  type EditorialPresentationRunProgress,
  type EditorialPresentationTarget,
  type EditorialTrendPresentation,
} from "@t3tools/contracts";
import type { TrendPresentationGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { nowIso } from "./persistence/support.ts";
import { loadPresentationDossiers, type PresentationDossier } from "./presentationDossierSource.ts";
import { EditorialRunDirectory } from "./RunDirectory.ts";
import {
  encodeStrings,
  parseStrings,
  PRESENTATION_COLUMNS,
  presentationOfRow,
  type PresentationRow,
} from "./presentationRead.ts";

/** Generations in flight while drafting a whole run. Two keep a cheap model busy without
 * piling CLI processes on the operator's machine. */
const ENSURE_RUN_CONCURRENCY = 2;

export interface EditorialPresentationServiceShape {
  /** The stored presentation for the dossier's current input, or a new one. */
  readonly ensure: (
    target: EditorialPresentationTarget,
  ) => Effect.Effect<EditorialPresentationResult, EditorialPresentationError>;
  /** Always generates; the previous rows stay as history. */
  readonly regenerate: (
    target: EditorialPresentationTarget,
  ) => Effect.Effect<EditorialPresentationResult, EditorialPresentationError>;
  /**
   * Drafts every dossier of the run that has no ready presentation for its current input.
   * Resumable: ready ones are skipped. A failure is recorded and the rest continue.
   */
  readonly ensureAll: (
    runId: string,
    options?: { readonly concurrency?: number },
  ) => Effect.Effect<EditorialPresentationRunProgress, EditorialPresentationError>;
  /** Starts `ensureAll` in the background, once per run at a time, and returns its progress. */
  readonly startRun: (
    runId: string,
  ) => Effect.Effect<EditorialPresentationRunProgress, EditorialPresentationError>;
  readonly runProgress: (
    runId: string,
  ) => Effect.Effect<EditorialPresentationRunProgress, EditorialPresentationError>;
  /** Waits for the run's background drafting, if one was started, then reports progress. */
  readonly awaitRun: (
    runId: string,
  ) => Effect.Effect<EditorialPresentationRunProgress, EditorialPresentationError>;
  /** The monthly cap and the trends drafted this month. */
  readonly getBudget: Effect.Effect<EditorialDraftBudget, EditorialPresentationError>;
  readonly updateBudget: (
    monthlyLimit: number,
  ) => Effect.Effect<EditorialDraftBudget, EditorialPresentationError>;
}

/**
 * The calendar month around `nowMs` in the server's time zone, as the UTC range its
 * `requested_at` values fall in. UTC ISO strings sort as instants, so the range compares as
 * text.
 */
export function draftBudgetMonth(nowMs: number): {
  readonly month: string;
  readonly from: string;
  readonly to: string;
} {
  const start = DateTime.startOf(
    DateTime.makeZonedUnsafe(nowMs, { timeZone: DateTime.zoneMakeLocal() }),
    "month",
  );
  return {
    month: DateTime.formatIsoDate(start).slice(0, 7),
    from: DateTime.formatIso(start),
    to: DateTime.formatIso(DateTime.add(start, { months: 1 })),
  };
}

/** Diagnostic detail of `budget-reached`; the client words the reason itself. */
const draftBudgetReachedMessage = (budget: EditorialDraftBudget): string =>
  `Monthly drafting cap reached (${budget.usedThisMonth}/${budget.monthlyLimit}).`;

export class EditorialPresentationService extends Context.Service<
  EditorialPresentationService,
  EditorialPresentationServiceShape
>()("t3/editorial/EditorialPresentationService") {}

type PresentationStatus = PresentationRow["status"];

const storageFailed = (operation: string) => (cause: unknown) =>
  new EditorialPresentationError({
    reason: "storage-failed",
    message: `Editorial presentation storage failed in ${operation}${cause instanceof Error ? `: ${cause.message}` : "."}`,
  });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const dossierNotFound = (target: EditorialPresentationTarget) =>
  new EditorialPresentationError({
    reason: "dossier-not-found",
    message: `Dossier ${target.dossierId} is not in run ${target.runId}.`,
  });

const toResult = (
  row: PresentationRow,
  presentation: EditorialTrendPresentation,
  reused: boolean,
): EditorialPresentationResult => ({
  runId: EditorialRunId.make(row.run_id),
  dossierId: EditorialDossierId.make(row.dossier_id),
  // Written for the input the dossier has now.
  presentation: { ...presentation, status: "current" },
  warnings: parseStrings(row.warnings_json),
  reused,
});

const latestReadyForHash = (
  sql: SqlClient.SqlClient,
  runId: string,
  dossierId: string,
  inputHash: string,
) =>
  sql<PresentationRow>`
    SELECT ${sql.literal(PRESENTATION_COLUMNS)} FROM editorial_presentations
    WHERE run_id = ${runId} AND dossier_id = ${dossierId} AND input_hash = ${inputHash}
      AND status = 'ready'
    ORDER BY revision DESC
    LIMIT 1
  `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

interface RunJob {
  running: boolean;
  startedAt: string;
  finishedAt: string | null;
  readonly done: Deferred.Deferred<void>;
}

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const directory = yield* EditorialRunDirectory;
  const loadRun = (runId: string) => loadPresentationDossiers(directory, sql, runId);

  // A row left pending by a previous process never finishes; say so instead of hiding it.
  yield* sql`
    UPDATE editorial_presentations
    SET status = 'failed', error = 'interrupted by a server restart'
    WHERE status = 'pending'
  `.pipe(Effect.mapError(storageFailed("recoverPending")));

  const jobScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(jobScope, Exit.void));
  const jobs = new Map<string, RunJob>();
  // One generation per dossier at a time: a click during a run waits for it instead of paying twice.
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockOf = (runId: string, dossierId: string) => {
    const key = `${runId}\u0000${dossierId}`;
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock;
  };

  const generationInput = Effect.fn("EditorialPresentationService.generationInput")(function* (
    dossier: PresentationDossier,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new EditorialPresentationError({
            reason: "generation-failed",
            message: `Cannot read the text generation settings: ${cause.message}`,
          }),
      ),
    );
    // The identity was computed with the dossier; cwd and model stay outside it.
    const input: TrendPresentationGenerationInput = {
      ...dossier.input,
      // Claude runs this operation in a temporary directory; Codex gets a directory
      // without project instructions.
      cwd: config.stateDir,
      modelSelection: settings.textGenerationModelSelection,
    };
    return { input, inputHash: dossier.inputHash };
  });

  const loadDossier = Effect.fn("EditorialPresentationService.loadDossier")(function* (
    target: EditorialPresentationTarget,
  ) {
    const run = yield* loadRun(target.runId);
    const dossier = run.find((candidate) => candidate.dossierId === target.dossierId);
    if (dossier === undefined) return yield* dossierNotFound(target);
    return dossier;
  });

  const readBudget = Effect.gen(function* () {
    const window = draftBudgetMonth(yield* Clock.currentTimeMillis);
    const limits = yield* sql<{ readonly monthly_limit: number }>`
      SELECT monthly_limit FROM editorial_draft_budget WHERE budget_id = 1
    `;
    const used = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM editorial_presentations
      WHERE requested_at >= ${window.from} AND requested_at < ${window.to}
        AND status IN ('ready', 'pending')
    `;
    return {
      monthlyLimit: limits[0]?.monthly_limit ?? EDITORIAL_DRAFT_BUDGET_DEFAULT,
      usedThisMonth: used[0]?.count ?? 0,
      month: window.month,
    } satisfies EditorialDraftBudget;
  }).pipe(Effect.mapError(storageFailed("readBudget")));

  // The count and the pending row are written under one permit, so two generations in flight
  // never both take the last unit of the month.
  const budgetLock = Semaphore.makeUnsafe(1);

  const updateBudget: EditorialPresentationServiceShape["updateBudget"] = Effect.fn(
    "EditorialPresentationService.updateBudget",
  )(function* (monthlyLimit) {
    const updatedAt = yield* nowIso;
    yield* sql`
      INSERT INTO editorial_draft_budget (budget_id, monthly_limit, updated_at)
      VALUES (1, ${monthlyLimit}, ${updatedAt})
      ON CONFLICT (budget_id) DO UPDATE SET
        monthly_limit = excluded.monthly_limit,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(storageFailed("updateBudget")));
    return yield* readBudget;
  });

  const generate = Effect.fn("EditorialPresentationService.generate")(function* (
    dossier: PresentationDossier,
    input: TrendPresentationGenerationInput,
    inputHash: string,
  ) {
    const presentationId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    yield* budgetLock.withPermits(1)(
      Effect.gen(function* () {
        const budget = yield* readBudget;
        if (isDraftBudgetReached(budget)) {
          return yield* new EditorialPresentationError({
            reason: "budget-reached",
            message: draftBudgetReachedMessage(budget),
          });
        }
        const requestedAt = yield* nowIso;
        yield* sql`
          INSERT INTO editorial_presentations (
            presentation_id, run_id, dossier_id, trend_key, input_hash, revision, requested_at,
            status
          )
          SELECT
            ${presentationId}, ${dossier.runId}, ${dossier.dossierId}, ${dossier.trendKey},
            ${inputHash}, COALESCE(MAX(revision), 0) + 1, ${requestedAt}, 'pending'
          FROM editorial_presentations
          WHERE run_id = ${dossier.runId} AND dossier_id = ${dossier.dossierId}
        `.pipe(Effect.mapError(storageFailed("insertPending")));
      }),
    );

    // The pending row holds a unit of the monthly cap, so it is resolved on every exit: failed
    // with the reason, or deleted when even that write fails. Covers storing the result too.
    const resolvePending = (error: string) =>
      sql`
        UPDATE editorial_presentations SET status = 'failed', error = ${error}
        WHERE presentation_id = ${presentationId} AND status = 'pending'
      `.pipe(
        Effect.catch(
          () =>
            sql`
            DELETE FROM editorial_presentations
            WHERE presentation_id = ${presentationId} AND status = 'pending'
          `,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("editorial: a pending presentation could not be resolved").pipe(
            Effect.annotateLogs({ presentationId, cause: Cause.pretty(cause) }),
          ),
        ),
      );

    return yield* storeGeneration(dossier, input, presentationId).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : resolvePending(
              Cause.hasInterruptsOnly(exit.cause)
                ? "interrupted"
                : errorMessage(Cause.squash(exit.cause)),
            ),
      ),
    );
  });

  /** Calls the provider and writes the result over the pending row `generate` inserted. */
  const storeGeneration = Effect.fn("EditorialPresentationService.storeGeneration")(function* (
    dossier: PresentationDossier,
    input: TrendPresentationGenerationInput,
    presentationId: string,
  ) {
    const [duration, generated] = yield* textGeneration.generateTrendPresentation(input).pipe(
      Effect.timed,
      Effect.mapError(
        (cause) =>
          new EditorialPresentationError({ reason: "generation-failed", message: cause.message }),
      ),
    );
    yield* Effect.logInfo("editorial: trend presentation generated").pipe(
      Effect.annotateLogs({
        runId: dossier.runId,
        dossierId: dossier.dossierId,
        provider: generated.provider,
        model: generated.model,
        durationMs: Duration.toMillis(duration),
        warnings: generated.warnings.length,
      }),
    );
    // The provider's hash and ours cover the same logical input; keep ours as the key.
    yield* sql`
      UPDATE editorial_presentations SET
        status = 'ready',
        prompt_version = ${generated.promptVersion},
        provider = ${generated.provider},
        model = ${generated.model},
        title = ${generated.title},
        what_happened = ${generated.summary.whatHappened},
        why_it_matters = ${generated.summary.whyItMatters},
        video_angle = ${generated.summary.videoAngle},
        cited_item_ids_json = ${encodeStrings(generated.citedItemIds)},
        warnings_json = ${encodeStrings(generated.warnings)},
        generated_at = ${generated.generatedAt},
        error = NULL
      WHERE presentation_id = ${presentationId}
    `.pipe(Effect.mapError(storageFailed("markReady")));
    const rows = yield* sql<PresentationRow>`
      SELECT ${sql.literal(PRESENTATION_COLUMNS)} FROM editorial_presentations
      WHERE presentation_id = ${presentationId}
    `.pipe(Effect.mapError(storageFailed("readGenerated")));
    const row = rows[0];
    const presentation = row === undefined ? null : presentationOfRow(row);
    if (row === undefined || presentation === null) {
      return yield* storageFailed("readGenerated")(new Error("the stored row is not ready"));
    }
    return toResult(row, presentation, false);
  });

  const ensureDossier = Effect.fn("EditorialPresentationService.ensureDossier")(function* (
    dossier: PresentationDossier,
  ) {
    const { input, inputHash } = yield* generationInput(dossier);
    const stored = latestReadyForHash(sql, dossier.runId, dossier.dossierId, inputHash).pipe(
      Effect.mapError(storageFailed("latestReady")),
      Effect.map(
        Option.flatMap((row) =>
          Option.map(Option.fromNullishOr(presentationOfRow(row)), (presentation) =>
            toResult(row, presentation, true),
          ),
        ),
      ),
    );
    const before = yield* stored;
    if (Option.isSome(before)) return before.value;
    return yield* lockOf(dossier.runId, dossier.dossierId).withPermits(1)(
      // Another caller may have written it while this one waited.
      stored.pipe(
        Effect.flatMap((after) =>
          Option.isSome(after) ? Effect.succeed(after.value) : generate(dossier, input, inputHash),
        ),
      ),
    );
  });

  const ensure: EditorialPresentationServiceShape["ensure"] = Effect.fn(
    "EditorialPresentationService.ensure",
  )(function* (target) {
    return yield* ensureDossier(yield* loadDossier(target));
  });

  const regenerate: EditorialPresentationServiceShape["regenerate"] = Effect.fn(
    "EditorialPresentationService.regenerate",
  )(function* (target) {
    const dossier = yield* loadDossier(target);
    const { input, inputHash } = yield* generationInput(dossier);
    return yield* lockOf(dossier.runId, dossier.dossierId).withPermits(1)(
      generate(dossier, input, inputHash),
    );
  });

  const runProgress: EditorialPresentationServiceShape["runProgress"] = Effect.fn(
    "EditorialPresentationService.runProgress",
  )(function* (runId) {
    const run = yield* loadRun(runId);
    const hashes = new Map(run.map((dossier) => [dossier.dossierId, dossier.inputHash]));
    const rows = yield* sql<{
      readonly dossier_id: string;
      readonly input_hash: string;
      readonly status: PresentationStatus;
      readonly revision: number;
    }>`
      SELECT dossier_id, input_hash, status, revision FROM editorial_presentations
      WHERE run_id = ${runId}
      ORDER BY revision ASC
    `.pipe(Effect.mapError(storageFailed("runProgress")));
    const ready = new Set<string>();
    const latest = new Map<string, PresentationStatus>();
    for (const row of rows) {
      if (hashes.get(row.dossier_id) !== row.input_hash) continue;
      if (row.status === "ready") ready.add(row.dossier_id);
      latest.set(row.dossier_id, row.status);
    }
    const failed = [...latest].filter(
      ([dossierId, status]) => status === "failed" && !ready.has(dossierId),
    ).length;
    const job = jobs.get(runId);
    return {
      runId: EditorialRunId.make(runId),
      status: job?.running ? ("running" as const) : ("idle" as const),
      total: run.length,
      ready: ready.size,
      failed,
      startedAt: job?.startedAt ?? null,
      finishedAt: job?.finishedAt ?? null,
    };
  });

  const ensureAll: EditorialPresentationServiceShape["ensureAll"] = Effect.fn(
    "EditorialPresentationService.ensureAll",
  )(function* (runId, options) {
    const run = yield* loadRun(runId);
    // Once the monthly cap stops one dossier it stops the rest: they stay undrafted, with no
    // failed row, for the operator to draft by hand later.
    let capped = false;
    yield* Effect.forEach(
      run,
      (dossier) =>
        capped
          ? Effect.void
          : ensureDossier(dossier).pipe(
              Effect.asVoid,
              Effect.catch((error) => {
                if (error.reason !== "budget-reached") {
                  return Effect.logWarning("editorial: trend presentation failed").pipe(
                    Effect.annotateLogs({
                      runId,
                      dossierId: dossier.dossierId,
                      error: error.message,
                    }),
                  );
                }
                if (capped) return Effect.void;
                capped = true;
                return Effect.logWarning("editorial: monthly drafting cap reached").pipe(
                  Effect.annotateLogs({ runId, error: error.message }),
                );
              }),
            ),
      { concurrency: options?.concurrency ?? ENSURE_RUN_CONCURRENCY, discard: true },
    );
    return yield* runProgress(runId);
  });

  const startRun: EditorialPresentationServiceShape["startRun"] = Effect.fn(
    "EditorialPresentationService.startRun",
  )(function* (runId) {
    if (jobs.get(runId)?.running !== true) {
      // Fails here, not in the background, when the run does not exist.
      yield* loadRun(runId);
      const job: RunJob = {
        running: true,
        startedAt: yield* nowIso,
        finishedAt: null,
        done: yield* Deferred.make<void>(),
      };
      jobs.set(runId, job);
      yield* ensureAll(runId, { concurrency: ENSURE_RUN_CONCURRENCY }).pipe(
        Effect.tap((progress) =>
          Effect.logInfo("editorial: run presentations finished").pipe(
            Effect.annotateLogs({ runId, ready: progress.ready, failed: progress.failed }),
          ),
        ),
        Effect.ignoreCause({ log: true }),
        Effect.ensuring(
          nowIso.pipe(
            Effect.map((at) => {
              job.running = false;
              job.finishedAt = at;
            }),
            Effect.andThen(Deferred.succeed(job.done, undefined)),
          ),
        ),
        Effect.forkIn(jobScope),
      );
    }
    return yield* runProgress(runId);
  });

  const awaitRun: EditorialPresentationServiceShape["awaitRun"] = Effect.fn(
    "EditorialPresentationService.awaitRun",
  )(function* (runId) {
    const job = jobs.get(runId);
    if (job !== undefined) yield* Deferred.await(job.done);
    return yield* runProgress(runId);
  });

  return EditorialPresentationService.of({
    ensure,
    regenerate,
    ensureAll,
    startRun,
    runProgress,
    awaitRun,
    getBudget: readBudget,
    updateBudget,
  });
});

/** Needs the shared `EditorialRunDirectory`, which `editorial/layer.ts` mounts below it. */
export const layer = Layer.effect(EditorialPresentationService, make);
