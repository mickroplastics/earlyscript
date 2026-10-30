import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import type {
  EditorialActor,
  VideoThread,
  VideoThreadLaunchState,
  VideoThreadMode,
} from "./persistence/EditorialModel.ts";
import {
  EditorialConflictError,
  EditorialInvalidInputError,
  type EditorialPersistenceError,
  toPersistenceError,
} from "./persistence/Errors.ts";
import { nowIso } from "./persistence/support.ts";

export interface RegisterVideoThreadInput {
  /** Generated once by the caller and reused on every retry of the same creation. */
  readonly operationId: string;
  readonly environmentId: string;
  /** The ThreadId the caller will launch, chosen before launching. */
  readonly threadId: string;
  readonly mode: VideoThreadMode;
  readonly trendKey?: string | undefined;
  readonly runId?: string | undefined;
  readonly dossierId?: string | undefined;
  readonly dossierHash?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly actor?: EditorialActor | undefined;
}

export interface RegisterVideoThreadResult {
  readonly thread: VideoThread;
  /** False when the operation was already registered and this call replayed it. */
  readonly created: boolean;
}

/**
 * Durable link between a T3 thread and its editorial context. `createVideo`
 * (not here yet) registers first, then calls ThreadLaunchService.launch; a
 * retry resumes by operation id and launch_state, never launching twice.
 */
export class EditorialThreadService extends Context.Service<
  EditorialThreadService,
  {
    readonly registerVideoThread: (
      input: RegisterVideoThreadInput,
    ) => Effect.Effect<
      RegisterVideoThreadResult,
      EditorialPersistenceError | EditorialInvalidInputError | EditorialConflictError
    >;
    readonly getVideoThread: (
      threadId: string,
    ) => Effect.Effect<Option.Option<VideoThread>, EditorialPersistenceError>;
  }
>()("t3/editorial/EditorialThreadService") {}

interface VideoThreadRow {
  readonly thread_id: string;
  readonly environment_id: string;
  readonly operation_id: string;
  readonly mode: VideoThreadMode;
  readonly trend_key: string | null;
  readonly run_id: string | null;
  readonly dossier_id: string | null;
  readonly dossier_hash: string | null;
  readonly script_path: string | null;
  readonly launch_state: VideoThreadLaunchState;
  readonly created_by: EditorialActor;
  readonly created_at: string;
}

const toVideoThread = (row: VideoThreadRow): VideoThread => ({
  threadId: row.thread_id,
  environmentId: row.environment_id,
  operationId: row.operation_id,
  mode: row.mode,
  trendKey: row.trend_key,
  runId: row.run_id,
  dossierId: row.dossier_id,
  dossierHash: row.dossier_hash,
  scriptPath: row.script_path,
  launchState: row.launch_state,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const selectBy = (sql: SqlClient.SqlClient, column: "thread_id" | "operation_id", value: string) =>
  sql<VideoThreadRow>`
    SELECT
      thread_id, environment_id, operation_id, mode, trend_key, run_id, dossier_id,
      dossier_hash, script_path, launch_state, created_by, created_at
    FROM editorial_video_threads
    WHERE ${sql(column)} = ${value}
  `.pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toVideoThread)));

const nullable = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const eventLog = yield* EditorialEventLog;

  const registerVideoThread: EditorialThreadService["Service"]["registerVideoThread"] = Effect.fn(
    "EditorialThreadService.registerVideoThread",
  )(function* (input) {
    const operation = "editorial.registerVideoThread";
    for (const [field, value] of [
      ["operationId", input.operationId],
      ["environmentId", input.environmentId],
      ["threadId", input.threadId],
    ] as const) {
      if (value.trim().length === 0) {
        return yield* new EditorialInvalidInputError({ operation, detail: `${field} is required` });
      }
    }
    return yield* eventLog.transact(
      operation,
      Effect.gen(function* () {
        // The persisted operation wins over whatever a retry proposes.
        const replay = yield* selectBy(sql, "operation_id", input.operationId);
        if (Option.isSome(replay))
          return { result: { thread: replay.value, created: false }, events: [] };
        if (Option.isSome(yield* selectBy(sql, "thread_id", input.threadId))) {
          return yield* new EditorialConflictError({
            operation,
            detail: `thread ${input.threadId} is registered by another operation`,
          });
        }
        const at = yield* nowIso;
        const actor = input.actor ?? "operator";
        const thread: VideoThread = {
          threadId: input.threadId,
          environmentId: input.environmentId,
          operationId: input.operationId,
          mode: input.mode,
          trendKey: nullable(input.trendKey),
          runId: nullable(input.runId),
          dossierId: nullable(input.dossierId),
          dossierHash: nullable(input.dossierHash),
          scriptPath: nullable(input.scriptPath),
          launchState: "pending",
          createdBy: actor,
          createdAt: at,
        };
        yield* sql`
            INSERT INTO editorial_video_threads (
              thread_id, environment_id, operation_id, mode, trend_key, run_id, dossier_id,
              dossier_hash, script_path, launch_state, created_by, created_at
            )
            VALUES (
              ${thread.threadId}, ${thread.environmentId}, ${thread.operationId}, ${thread.mode},
              ${thread.trendKey}, ${thread.runId}, ${thread.dossierId}, ${thread.dossierHash},
              ${thread.scriptPath}, ${thread.launchState}, ${actor}, ${at}
            )
          `;
        const event = yield* appendEvent(sql, {
          type: "video-thread.registered",
          aggregateKind: "video_thread",
          aggregateId: thread.threadId,
          operationId: thread.operationId,
          actor,
          payload: {
            environmentId: thread.environmentId,
            mode: thread.mode,
            trendKey: thread.trendKey,
            runId: thread.runId,
            dossierId: thread.dossierId,
          },
          createdAt: at,
        });
        return { result: { thread, created: true }, events: [event] };
      }),
    );
  });

  const getVideoThread: EditorialThreadService["Service"]["getVideoThread"] = (threadId) =>
    selectBy(sql, "thread_id", threadId).pipe(
      Effect.mapError(toPersistenceError("editorial.getVideoThread")),
    );

  return EditorialThreadService.of({ registerVideoThread, getVideoThread });
});

export const layer = Layer.effect(EditorialThreadService, make);
