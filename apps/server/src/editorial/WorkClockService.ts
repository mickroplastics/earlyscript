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
  openInterval,
  stopClock,
  summarize,
} from "./persistence/workIntervals.ts";

export interface WorkClockCommandOptions {
  /** Persisted with the event; a retry with the same id returns the current summary. */
  readonly operationId?: string | undefined;
  readonly actor?: EditorialActor | undefined;
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
      options?: WorkClockCommandOptions,
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
    /** The operator says when a recovered segment actually ended. */
    readonly resolveInterval: (input: {
      readonly intervalId: string;
      readonly endedAt: string;
      readonly actor?: EditorialActor | undefined;
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
        );
        const events = replay ? [] : yield* apply(yield* nowIso, options?.actor ?? "operator");
        return { result: yield* readSummary(threadId), events };
      }),
    );

  const start: WorkClockService["Service"]["start"] = (threadId, stage, options) =>
    command("workClock.start", threadId, options, (at, actor) =>
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
        yield* openInterval(sql, { intervalId, threadId, stage, startedAt: at, actor });
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
    command("workClock.pause", threadId, options, (at, actor) =>
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
    command("workClock.resume", threadId, options, (at, actor) =>
      Effect.gen(function* () {
        const state = clockStateOf(yield* loadIntervals(sql, threadId));
        if (state._tag !== "paused") {
          return yield* stateError(threadId, "not-paused", "the clock is not paused");
        }
        const intervalId = yield* newId;
        yield* openInterval(sql, {
          intervalId,
          threadId,
          stage: state.stage,
          startedAt: at,
          actor,
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
    command("workClock.changeStage", threadId, options, (at, actor) =>
      Effect.gen(function* () {
        const state = clockStateOf(yield* loadIntervals(sql, threadId));
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
        yield* openInterval(sql, { intervalId, threadId, stage, startedAt: at, actor });
        return [
          yield* appendEvent(sql, {
            type: "work.stage-changed",
            aggregateKind: "video_thread",
            aggregateId: threadId,
            operationId: options?.operationId,
            actor,
            payload: { from: state.stage, to: stage, fromState: state._tag, intervalId },
            createdAt: at,
          }),
        ];
      }),
    );

  const stop: WorkClockService["Service"]["stop"] = (threadId, options) =>
    command("workClock.stop", threadId, options, (at, actor) =>
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
