import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { EditorialSql } from "./EditorialDatabase.ts";
import type {
  EditorialActor,
  EditorialAggregateKind,
  EditorialEvent,
  EditorialEventType,
} from "./EditorialModel.ts";
import { EditorialPersistenceError, toPersistenceError } from "./Errors.ts";

const MAX_EVENTS_PER_READ = 500;

interface EventRow {
  readonly seq: number;
  readonly type: EditorialEventType;
  readonly aggregate_kind: EditorialAggregateKind;
  readonly aggregate_id: string;
  readonly operation_id: string | null;
  readonly actor: EditorialActor;
  readonly actor_session_id: string | null;
  readonly payload_json: string;
  readonly created_at: string;
}

const toEvent = (row: EventRow): EditorialEvent => ({
  seq: row.seq,
  type: row.type,
  aggregateKind: row.aggregate_kind,
  aggregateId: row.aggregate_id,
  operationId: row.operation_id,
  actor: row.actor,
  actorSessionId: row.actor_session_id,
  payload: JSON.parse(row.payload_json),
  createdAt: row.created_at,
});

export interface AppendEventInput {
  readonly type: EditorialEventType;
  readonly aggregateKind: EditorialAggregateKind;
  readonly aggregateId: string;
  readonly operationId?: string | undefined;
  readonly actor: EditorialActor;
  readonly actorSessionId?: string | undefined;
  readonly payload: unknown;
  readonly createdAt: string;
}

/** Appends one event; call it inside the transaction that applies the change. */
export const appendEvent = (
  sql: SqlClient.SqlClient,
  input: AppendEventInput,
): Effect.Effect<EditorialEvent, SqlError> =>
  sql<EventRow>`
    INSERT INTO editorial_events (
      type, aggregate_kind, aggregate_id, operation_id, actor, actor_session_id, payload_json,
      created_at
    )
    VALUES (
      ${input.type},
      ${input.aggregateKind},
      ${input.aggregateId},
      ${input.operationId ?? null},
      ${input.actor},
      ${input.actorSessionId ?? null},
      ${JSON.stringify(input.payload ?? null)},
      ${input.createdAt}
    )
    RETURNING
      seq, type, aggregate_kind, aggregate_id, operation_id, actor, actor_session_id,
      payload_json, created_at
  `.pipe(Effect.map((rows) => toEvent(rows[0]!)));

/** The event that recorded `operationId`, if a previous attempt already committed it. */
export const findOperationEvent = (
  sql: SqlClient.SqlClient,
  operationId: string | undefined,
): Effect.Effect<Option.Option<EditorialEvent>, SqlError> =>
  operationId === undefined
    ? Effect.succeedNone
    : sql<EventRow>`
        SELECT
          seq, type, aggregate_kind, aggregate_id, operation_id, actor, actor_session_id,
          payload_json, created_at
        FROM editorial_events
        WHERE operation_id = ${operationId}
      `.pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toEvent)));

/** What a transaction body returns: its result and the events it appended. */
export interface Committed<A> {
  readonly result: A;
  readonly events: ReadonlyArray<EditorialEvent>;
}

export class EditorialEventLog extends Context.Service<
  EditorialEventLog,
  {
    readonly latestSeq: Effect.Effect<number, EditorialPersistenceError>;
    /** Events with `seq > afterSeq`, oldest first, at most MAX_EVENTS_PER_READ. */
    readonly readSince: (
      afterSeq: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<EditorialEvent>, EditorialPersistenceError>;
    /** Events as they commit. Pair with readSince to fill gaps after a reconnect. */
    readonly changes: Stream.Stream<EditorialEvent>;
    /**
     * A subscription that buffers from the moment it is taken. Take it before reading a
     * snapshot so no event committed in between is lost.
     */
    readonly subscribe: Effect.Effect<PubSub.Subscription<EditorialEvent>, never, Scope.Scope>;
    /**
     * Runs `body` in one editorial transaction, then publishes its events.
     * Nothing is published when the transaction rolls back.
     */
    readonly transact: <A, E>(
      operation: string,
      body: Effect.Effect<Committed<A>, E | SqlError>,
    ) => Effect.Effect<A, Exclude<E, SqlError> | EditorialPersistenceError>;
  }
>()("t3/editorial/persistence/EditorialEventLog") {}

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const pubsub = yield* PubSub.unbounded<EditorialEvent>();

  const transact = <A, E>(operation: string, body: Effect.Effect<Committed<A>, E | SqlError>) =>
    sql.withTransaction(body).pipe(
      Effect.catchIf(
        (cause: E | SqlError): cause is SqlError => isSqlError(cause),
        (cause) => Effect.fail(new EditorialPersistenceError({ operation, cause })),
      ),
      Effect.tap(({ events }) =>
        events.length === 0 ? Effect.void : PubSub.publishAll(pubsub, events),
      ),
      Effect.map(({ result }) => result),
      Effect.withSpan(`EditorialEventLog.transact.${operation}`),
    );

  return EditorialEventLog.of({
    latestSeq: sql<{ readonly seq: number | null }>`
      SELECT MAX(seq) AS seq FROM editorial_events
    `.pipe(
      Effect.map((rows) => rows[0]?.seq ?? 0),
      Effect.mapError(toPersistenceError("latestEditorialSeq")),
    ),
    readSince: Effect.fn("EditorialEventLog.readSince")(function* (afterSeq, limit) {
      const bounded = Math.max(1, Math.min(limit ?? MAX_EVENTS_PER_READ, MAX_EVENTS_PER_READ));
      const rows = yield* sql<EventRow>`
        SELECT
          seq, type, aggregate_kind, aggregate_id, operation_id, actor, actor_session_id,
          payload_json, created_at
        FROM editorial_events
        WHERE seq > ${afterSeq}
        ORDER BY seq
        LIMIT ${bounded}
      `.pipe(Effect.mapError(toPersistenceError("readEditorialEvents")));
      return rows.map(toEvent);
    }),
    changes: Stream.fromPubSub(pubsub),
    subscribe: PubSub.subscribe(pubsub),
    transact,
  });
});

export const layer = Layer.effect(EditorialEventLog, make);
