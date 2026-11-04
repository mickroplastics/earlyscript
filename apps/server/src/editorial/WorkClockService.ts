import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { SqlError } from "effect/sql/SqlError";

import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import type {
  EditorialActor,
  EditorialEvent,
  EditorialEventType,
  UnresolvedInterval,
  WorkClockSummary,
  WorkStage,
} from "./persistence/EditorialModel.ts";
import {
  EditorialConflictError,
  EditorialInvalidInputError,
  EditorialNotFoundError,
  type EditorialPersistenceError,
  toPersistenceError,
  WorkClockStateError,
} from "./persistence/Errors.ts";
import {
  makeNewId,
  nowIso,
  operationAlreadyApplied,
  parseIso,
  requireVideoThread,
} from "./persistence/support.ts";
import {
  clockStateOf,
  closeInterval,
  loadIntervals,
  type IntervalSource,
  openInterval,
  stopClock,
  summarize,
} from "./persistence/workIntervals.ts";

export interface WorkClockCommandOptions {
  /** Persisted with the event; a retry with the same id returns the current summary. */
  readonly operationId?: string | undefined;
  readonly actor?: EditorialActor | undefined;
  /**
   * Fails with `decided` when the thread has a decision, checked in the command's own
   * transaction, so a command admitted before a decision commits cannot reopen the clock.
   */
  readonly refuseWhenDecided?: boolean | undefined;
  /**
   * Persisted with the segment it opens. `manual` (the default) is the operator choosing the
   * stage by hand; `auto` is a rule of the thread flow, which never overrides a manual choice.
   * A resume keeps the source of the segment it continues.
   */
  readonly source?: IntervalSource | undefined;
}

export interface WorkClockStageOptions extends WorkClockCommandOptions {
  /** Applies only while `onlyFrom` is running; otherwise records nothing. */
  readonly onlyFrom?: WorkStage | undefined;
  /**
   * Applies only when `stage` never ran on this thread; otherwise records nothing. The
   * automatic stage changes use it, so an operator who left a stage by hand is not sent back.
   */
  readonly onlyFirst?: boolean | undefined;
  /**
   * Records nothing when the running or paused stage was chosen by hand (`source = 'manual'`),
   * checked in the change's own transaction. The automatic move out of Leer uses it, so a Leer
   * the operator chose stays even if Escribir never ran.
   */
  readonly unlessChosenByHand?: boolean | undefined;
  /** Why an automatic change happened, kept in the event's payload. */
  readonly cause?: "agent-request" | "script-version" | "decision-block" | undefined;
}

export interface WorkClockPauseOptions extends WorkClockCommandOptions {
  readonly reason?: string | undefined;
}

export type WorkClockError =
  | EditorialPersistenceError
  | EditorialNotFoundError
  | EditorialConflictError
  | WorkClockStateError;

/**
 * Human working time per video thread, as persisted segments. The server is
 * the source of truth; clients interpolate the display and re-read on
 * reconnect. Focus loss is not a pause: only explicit pauses are subtracted.
 */
export class WorkClockService extends Context.Service<
  WorkClockService,
  {
    /** Fails when any segment is open or the clock is paused (use resume or changeStage). */
    readonly start: (
      threadId: string,
      stage: WorkStage,
      options?: WorkClockCommandOptions,
    ) => Effect.Effect<WorkClockSummary, WorkClockError>;
    readonly pause: (
      threadId: string,
      options?: WorkClockPauseOptions,
    ) => Effect.Effect<WorkClockSummary, WorkClockError>;
    readonly resume: (
      threadId: string,
      options?: WorkClockCommandOptions,
    ) => Effect.Effect<WorkClockSummary, WorkClockError>;
    /** Closes the current stage and opens `stage` in one transaction; from a pause, ends it. */
    readonly changeStage: (
      threadId: string,
      stage: WorkStage,
      options?: WorkClockStageOptions,
    ) => Effect.Effect<WorkClockSummary, WorkClockError>;
    /** Idempotent: stopping an idle clock records nothing. */
    readonly stop: (
      threadId: string,
      options?: WorkClockCommandOptions,
    ) => Effect.Effect<WorkClockSummary, WorkClockError>;
    /** Active time per stage, excluding pauses and unresolved segments. */
    readonly summary: (
      threadId: string,
    ) => Effect.Effect<WorkClockSummary, EditorialPersistenceError | EditorialNotFoundError>;
    /**
     * Marks segments left open by a previous process as needing resolution.
     * Run once at startup, before clients can start new segments.
     */
    readonly recoverOpenIntervals: () => Effect.Effect<
      ReadonlyArray<UnresolvedInterval>,
      EditorialPersistenceError
    >;
    /**
     * The operator says when a recovered segment actually ended. A retry with the same
     * `operationId` returns the current summary without resolving or recording again.
     */
    readonly resolveInterval: (input: {
      readonly intervalId: string;
      readonly endedAt: string;
      readonly actor?: EditorialActor | undefined;
      readonly operationId?: string | undefined;
    }) => Effect.Effect<WorkClockSummary, WorkClockError | EditorialInvalidInputError>;
  }
>()("t3/editorial/WorkClockService") {}

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const eventLog = yield* EditorialEventLog;
  const newId = yield* makeNewId;

  const readSummary = Effect.fn("WorkClockService.readSummary")(function* (threadId: string) {
    const rows = yield* loadIntervals(sql, threadId);
    return summarize(threadId, rows, yield* nowIso);
  });

  const stateError = (threadId: string, reason: WorkClockStateError["reason"], detail: string) =>
    new WorkClockStateError({ threadId, reason, detail });

  /**
   * Shared shell of every clock command: one transaction, thread check,
   * operation replay, then the summary after the change.
   */
  const command = (
    operation: string,
    eventType: EditorialEventType,
    threadId: string,
    options: WorkClockCommandOptions | undefined,
    apply: (
      at: string,
      actor: EditorialActor,
    ) => Effect.Effect<ReadonlyArray<EditorialEvent>, SqlError | WorkClockStateError>,
  ) =>
    eventLog.transact(
      operation,
      Effect.gen(function* () {
        yield* requireVideoThread(sql, threadId);
        const replay = yield* operationAlreadyApplied(
          sql,
          operation,
          options?.operationId,
          threadId,
          eventType,
        );
        if (!replay && options?.refuseWhenDecided === true) {
          const decided = yield* sql`
            SELECT 1 FROM editorial_decisions WHERE thread_id = ${threadId} LIMIT 1
          `;
          if (decided.length > 0) {
            return yield* stateError(threadId, "decided", "the thread was decided");
          }
        }
        const events = replay ? [] : yield* apply(yield* nowIso, options?.actor ?? "operator");
        return { result: yield* readSummary(threadId), events };
      }),
    );

  const start: WorkClockService["Service"]["start"] = (threadId, stage, options) =>
    command("workClock.start", "work.started", threadId, options, (at, actor) =>
      Effect.gen(function* () {
        const state = clockStateOf(yield* loadIntervals(sql, threadId));
        if (state._tag === "running") {
          return yield* stateError(
            threadId,
            "already-running",
            `stage ${state.stage} is already running`,
          );
        }
        if (state._tag === "paused") {
          return yield* stateError(threadId, "paused", `stage ${state.stage} is paused`);
        }
        const intervalId = yield* newId;
        const source = options?.source ?? "manual";
        yield* openInterval(sql, { intervalId, threadId, stage, startedAt: at, actor, source });
        return [
          yield* appendEvent(sql, {
            type: "work.started",
            aggregateKind: "video_thread",
            aggregateId: threadId,
            operationId: options?.operationId,
            actor,
            payload: { stage, intervalId },
            createdAt: at,
          }),
        ];
      }),
    );

  const pause: WorkClockService["Service"]["pause"] = (threadId, options) =>
    command("workClock.pause", "work.paused", threadId, options, (at, actor) =>
      Effect.gen(function* () {
        const state = clockStateOf(yield* loadIntervals(sql, threadId));
        if (state._tag !== "running") {
          return yield* stateError(threadId, "not-running", "nothing is running");
        }
        const reason = options?.reason?.trim() || null;
        yield* closeInterval(sql, state.intervalId, at, "paused", reason);
        return [
          yield* appendEvent(sql, {
            type: "work.paused",
            aggregateKind: "video_thread",
            aggregateId: threadId,
            operationId: options?.operationId,
            actor,
            payload: { stage: state.stage, intervalId: state.intervalId, reason },
            createdAt: at,
          }),
        ];
      }),
    );

  const resume: WorkClockService["Service"]["resume"] = (threadId, options) =>
    command("workClock.resume", "work.resumed", threadId, options, (at, actor) =>
      Effect.gen(function* () {
        const intervals = yield* loadIntervals(sql, threadId);
        const state = clockStateOf(intervals);
        if (state._tag !== "paused") {
          return yield* stateError(threadId, "not-paused", "the clock is not paused");
        }
        const intervalId = yield* newId;
        // Resuming continues the paused stage: whoever chose it still did. A segment from
        // before migration 016 passes on its unknown origin.
        yield* openInterval(sql, {
          intervalId,
          threadId,
          stage: state.stage,
          startedAt: at,
          actor,
          source: intervals.find((row) => row.interval_id === state.intervalId)?.source ?? null,
        });
        return [
          yield* appendEvent(sql, {
            type: "work.resumed",
            aggregateKind: "video_thread",
            aggregateId: threadId,
            operationId: options?.operationId,
            actor,
            payload: { stage: state.stage, intervalId, pausedIntervalId: state.intervalId },
            createdAt: at,
          }),
        ];
      }),
    );

  const changeStage: WorkClockService["Service"]["changeStage"] = (threadId, stage, options) =>
    command("workClock.changeStage", "work.stage-changed", threadId, options, (at, actor) =>
      Effect.gen(function* () {
        const intervals = yield* loadIntervals(sql, threadId);
        const state = clockStateOf(intervals);
        const onlyFrom = options?.onlyFrom;
        if (onlyFrom !== undefined && (state._tag !== "running" || state.stage !== onlyFrom)) {
          return [];
        }
        if (options?.onlyFirst === true && intervals.some((row) => row.stage === stage)) {
          return [];
        }
        if (
          options?.unlessChosenByHand === true &&
          state._tag !== "idle" &&
          intervals.find((row) => row.interval_id === state.intervalId)?.source === "manual"
        ) {
          return [];
        }
        if (state._tag === "idle") {
          return yield* stateError(threadId, "not-started", "start the clock first");
        }
        if (state._tag === "running" && state.stage === stage) {
          return yield* stateError(threadId, "same-stage", `stage ${stage} is already running`);
        }
        if (state._tag === "running") {
          yield* closeInterval(sql, state.intervalId, at, "stage_changed");
        }
        const intervalId = yield* newId;
        const source = options?.source ?? "manual";
        yield* openInterval(sql, { intervalId, threadId, stage, startedAt: at, actor, source });
        return [
          yield* appendEvent(sql, {
            type: "work.stage-changed",
            aggregateKind: "video_thread",
            aggregateId: threadId,
            operationId: options?.operationId,
            actor,
            payload: {
              from: state.stage,
              to: stage,
              fromState: state._tag,
              intervalId,
              ...(options?.cause === undefined ? {} : { cause: options.cause }),
            },
            createdAt: at,
          }),
        ];
      }),
    );

  const stop: WorkClockService["Service"]["stop"] = (threadId, options) =>
    command("workClock.stop", "work.stopped", threadId, options, (at, actor) =>
      stopClock(sql, {
        threadId,
        at,
        reason: "stopped",
        actor,
        operationId: options?.operationId,
      }),
    );

  const summary: WorkClockService["Service"]["summary"] = Effect.fn("WorkClockService.summary")(
    function* (threadId) {
      return yield* Effect.gen(function* () {
        yield* requireVideoThread(sql, threadId);
        return yield* readSummary(threadId);
      }).pipe(
        Effect.catchTags({
          SqlError: (cause) => Effect.fail(toPersistenceError("workClock.summary")(cause)),
        }),
      );
    },
  );

  const recoverOpenIntervals: WorkClockService["Service"]["recoverOpenIntervals"] = () =>
    eventLog.transact(
      "workClock.recoverOpenIntervals",
      Effect.gen(function* () {
        const at = yield* nowIso;
        const orphans = yield* sql<{
          readonly interval_id: string;
          readonly thread_id: string;
          readonly stage: WorkStage;
          readonly started_at: string;
        }>`
          UPDATE editorial_work_intervals
          SET status = 'needs_resolution', recovered_at = ${at}
          WHERE status = 'open'
          RETURNING interval_id, thread_id, stage, started_at
        `;
        const events = yield* Effect.forEach(orphans, (orphan) =>
          appendEvent(sql, {
            type: "work.recovery-needed",
            aggregateKind: "video_thread",
            aggregateId: orphan.thread_id,
            actor: "system",
            payload: {
              intervalId: orphan.interval_id,
              stage: orphan.stage,
              startedAt: orphan.started_at,
            },
            createdAt: at,
          }),
        );
        const result: ReadonlyArray<UnresolvedInterval> = orphans.map((orphan) => ({
          intervalId: orphan.interval_id,
          stage: orphan.stage,
          startedAt: orphan.started_at,
          recoveredAt: at,
        }));
        return { result, events };
      }),
    );

  const resolveInterval: WorkClockService["Service"]["resolveInterval"] = (input) =>
    eventLog.transact(
      "workClock.resolveInterval",
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly thread_id: string;
          readonly status: string;
          readonly started_at: string;
          readonly recovered_at: string | null;
        }>`
          SELECT thread_id, status, started_at, recovered_at
          FROM editorial_work_intervals
          WHERE interval_id = ${input.intervalId}
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* new EditorialNotFoundError({
            entity: "work_interval",
            id: input.intervalId,
          });
        }
        if (
          yield* operationAlreadyApplied(
            sql,
            "workClock.resolveInterval",
            input.operationId,
            row.thread_id,
            "work.resolved",
          )
        ) {
          return { result: yield* readSummary(row.thread_id), events: [] };
        }
        if (row.status !== "needs_resolution") {
          return yield* stateError(
            row.thread_id,
            "not-unresolved",
            `interval ${input.intervalId} does not need resolution`,
          );
        }
        const endedAt = Option.getOrUndefined(parseIso(input.endedAt));
        // ISO strings in UTC with fixed precision compare in time order.
        if (
          endedAt === undefined ||
          endedAt < row.started_at ||
          (row.recovered_at !== null && endedAt > row.recovered_at)
        ) {
          return yield* new EditorialInvalidInputError({
            operation: "workClock.resolveInterval",
            detail: "endedAt must fall between the segment start and its recovery",
          });
        }
        const at = yield* nowIso;
        const actor = input.actor ?? "operator";
        yield* closeInterval(sql, input.intervalId, endedAt, "resolved");
        const event = yield* appendEvent(sql, {
          type: "work.resolved",
          aggregateKind: "video_thread",
          aggregateId: row.thread_id,
          operationId: input.operationId,
          actor,
          payload: { intervalId: input.intervalId, endedAt },
          createdAt: at,
        });
        return { result: yield* readSummary(row.thread_id), events: [event] };
      }),
    );

  return WorkClockService.of({
    start,
    pause,
    resume,
    changeStage,
    stop,
    summary,
    recoverOpenIntervals,
    resolveInterval,
  });
});

export const layer = Layer.effect(WorkClockService, make);
