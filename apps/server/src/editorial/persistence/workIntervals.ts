import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { appendEvent } from "./EditorialEventLog.ts";
import {
  WORK_STAGES,
  type EditorialActor,
  type EditorialEvent,
  type StageDuration,
  type UnresolvedInterval,
  type WorkClockState,
  type WorkClockSummary,
  type WorkStage,
} from "./EditorialModel.ts";

// Transaction-level clock operations shared by WorkClockService and by the
// decision command, which must close the clock in its own transaction.

export type IntervalEndReason = "paused" | "stage_changed" | "stopped" | "decided" | "resolved";

/**
 * Who opened a segment: the operator choosing its stage by hand, or a rule of the thread flow.
 * Null for segments recorded before migration 016.
 */
export type IntervalSource = "manual" | "auto";

export interface IntervalRow {
  readonly interval_id: string;
  readonly thread_id: string;
  readonly stage: WorkStage;
  readonly status: "open" | "closed" | "needs_resolution";
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly end_reason: IntervalEndReason | null;
  readonly pause_reason: string | null;
  readonly recovered_at: string | null;
  readonly pause_ended_at: string | null;
  readonly source: IntervalSource | null;
}

export const loadIntervals = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<IntervalRow>`
    SELECT
      interval_id, thread_id, stage, status, started_at, ended_at, end_reason,
      pause_reason, recovered_at, pause_ended_at, source
    FROM editorial_work_intervals
    WHERE thread_id = ${threadId}
    ORDER BY started_at, rowid
  `;

/** Running if a segment is open; paused if the latest segment ended in a pause. */
export const clockStateOf = (rows: ReadonlyArray<IntervalRow>): WorkClockState => {
  const open = rows.find((row) => row.status === "open");
  if (open !== undefined) {
    return {
      _tag: "running",
      stage: open.stage,
      intervalId: open.interval_id,
      since: open.started_at,
    };
  }
  const last = rows.at(-1);
  if (last?.status === "closed" && last.end_reason === "paused" && last.ended_at !== null) {
    return {
      _tag: "paused",
      stage: last.stage,
      intervalId: last.interval_id,
      since: last.ended_at,
    };
  }
  return { _tag: "idle" };
};

const elapsedMs = (from: string, to: string) => Math.max(0, Date.parse(to) - Date.parse(from));

export const summarize = (
  threadId: string,
  rows: ReadonlyArray<IntervalRow>,
  asOf: string,
): WorkClockSummary => {
  const byStage = new Map<WorkStage, { activeMs: number; segments: number }>();
  const unresolved: Array<UnresolvedInterval> = [];
  let pausedMs = 0;
  let pausedSince: string | undefined;

  for (const row of rows) {
    if (pausedSince !== undefined) {
      pausedMs += elapsedMs(pausedSince, row.started_at);
      pausedSince = undefined;
    }
    const stage = byStage.get(row.stage) ?? { activeMs: 0, segments: 0 };
    stage.segments += 1;
    byStage.set(row.stage, stage);
    if (row.status === "needs_resolution") {
      unresolved.push({
        intervalId: row.interval_id,
        stage: row.stage,
        startedAt: row.started_at,
        recoveredAt: row.recovered_at,
      });
      continue;
    }
    stage.activeMs += elapsedMs(row.started_at, row.ended_at ?? asOf);
    if (row.ended_at === null) continue;
    if (row.pause_ended_at !== null) pausedMs += elapsedMs(row.ended_at, row.pause_ended_at);
    else if (row.end_reason === "paused") pausedSince = row.ended_at;
  }
  if (pausedSince !== undefined) pausedMs += elapsedMs(pausedSince, asOf);

  const stages: Array<StageDuration> = WORK_STAGES.flatMap((stage) => {
    const entry = byStage.get(stage);
    return entry === undefined ? [] : [{ stage, ...entry }];
  });
  return {
    threadId,
    state: clockStateOf(rows),
    stages,
    activeMs: stages.reduce((total, stage) => total + stage.activeMs, 0),
    pausedMs,
    unresolved,
    definitive: unresolved.length === 0,
    asOf,
  };
};

export interface OpenIntervalInput {
  readonly intervalId: string;
  readonly threadId: string;
  readonly stage: WorkStage;
  readonly startedAt: string;
  readonly actor: EditorialActor;
  readonly source: IntervalSource | null;
}

export const openInterval = (sql: SqlClient.SqlClient, input: OpenIntervalInput) =>
  sql`
    INSERT INTO editorial_work_intervals (
      interval_id, thread_id, stage, status, started_at, actor, source
    )
    VALUES (
      ${input.intervalId}, ${input.threadId}, ${input.stage}, 'open', ${input.startedAt},
      ${input.actor}, ${input.source}
    )
  `;

export const closeInterval = (
  sql: SqlClient.SqlClient,
  intervalId: string,
  endedAt: string,
  reason: IntervalEndReason,
  pauseReason: string | null = null,
) =>
  sql`
    UPDATE editorial_work_intervals
    SET status = 'closed', ended_at = ${endedAt}, end_reason = ${reason},
      pause_reason = ${pauseReason}
    WHERE interval_id = ${intervalId}
  `;

/**
 * Ends whatever the clock is doing: closes the open segment, or ends a pause,
 * keeping the segment's end and recording when the pause ended. No-op when idle.
 */
export const stopClock = Effect.fn("stopEditorialClock")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly at: string;
    readonly reason: "stopped" | "decided";
    readonly actor: EditorialActor;
    readonly operationId?: string | undefined;
  },
): Effect.fn.Return<ReadonlyArray<EditorialEvent>, SqlError> {
  const state = clockStateOf(yield* loadIntervals(sql, input.threadId));
  if (state._tag === "idle") return [];
  if (state._tag === "running") {
    yield* closeInterval(sql, state.intervalId, input.at, input.reason);
  } else {
    yield* sql`
      UPDATE editorial_work_intervals
      SET end_reason = ${input.reason}, pause_ended_at = ${input.at}
      WHERE interval_id = ${state.intervalId}
    `;
  }
  const event = yield* appendEvent(sql, {
    type: "work.stopped",
    aggregateKind: "video_thread",
    aggregateId: input.threadId,
    operationId: input.operationId,
    actor: input.actor,
    payload: {
      stage: state.stage,
      intervalId: state.intervalId,
      reason: input.reason,
      from: state._tag,
    },
    createdAt: input.at,
  });
  return [event];
});
