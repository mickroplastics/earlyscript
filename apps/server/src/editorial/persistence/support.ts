import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { findOperationEvent } from "./EditorialEventLog.ts";
import type { EditorialEventType } from "./EditorialModel.ts";
import { EditorialConflictError, EditorialNotFoundError } from "./Errors.ts";

export const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

/** The value as a UTC ISO string, or none when it is not a date-time. */
export const parseIso = (value: string): Option.Option<string> =>
  DateTime.make(value).pipe(Option.map(DateTime.formatIso));

/** A UUID generator bound to the Crypto service captured at layer build. */
export const makeNewId = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return crypto.randomUUIDv4().pipe(Effect.orDie);
});

export const requireVideoThread = (
  sql: SqlClient.SqlClient,
  threadId: string,
): Effect.Effect<void, SqlError | EditorialNotFoundError> =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found FROM editorial_video_threads WHERE thread_id = ${threadId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows.length === 0
        ? Effect.fail(new EditorialNotFoundError({ entity: "video_thread", id: threadId }))
        : Effect.void,
    ),
  );

/**
 * True when `operationId` already committed `eventType` on this aggregate, so a
 * retry returns the current state instead of applying twice. The same id on
 * another aggregate or command is a caller bug.
 */
export const operationAlreadyApplied = Effect.fn("editorialOperationAlreadyApplied")(function* (
  sql: SqlClient.SqlClient,
  operation: string,
  operationId: string | undefined,
  aggregateId: string,
  eventType: EditorialEventType,
): Effect.fn.Return<boolean, SqlError | EditorialConflictError> {
  const existing = yield* findOperationEvent(sql, operationId);
  if (Option.isNone(existing)) return false;
  const { aggregateId: appliedTo, type } = existing.value;
  if (appliedTo !== aggregateId || type !== eventType) {
    return yield* new EditorialConflictError({
      operation,
      detail: `operation ${operationId} already recorded ${type} on ${appliedTo}`,
    });
  }
  return true;
});
