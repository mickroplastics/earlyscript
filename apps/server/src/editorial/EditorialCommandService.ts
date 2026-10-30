// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import {
  type Capture,
  type Decision,
  type DecisionAction,
  type EditorialActor,
  type EditorialEvent,
  type EditorialEventType,
  type ScriptVersion,
  SnoozeReturnCondition,
  type TrendInboxState,
  type UnsnoozeCause,
  type VideoResult,
} from "./persistence/EditorialModel.ts";
import {
  type EditorialConflictError,
  EditorialInvalidInputError,
  EditorialNotFoundError,
  type EditorialPersistenceError,
  toPersistenceError,
} from "./persistence/Errors.ts";
import {
  makeNewId,
  nowIso,
  operationAlreadyApplied,
  parseIso,
  requireVideoThread,
} from "./persistence/support.ts";
import { loadIntervals, stopClock, summarize } from "./persistence/workIntervals.ts";

const MAX_INBOX_KEYS_PER_READ = 500;
const MAX_SCRIPT_SNAPSHOT_BYTES = 1024 * 1024;

export interface ActorOption {
  readonly actor?: EditorialActor | undefined;
}

export interface MarkReadInput extends ActorOption {
  readonly trendKey: string;
  readonly runId: string;
  readonly dossierId?: string | undefined;
}

/** At least one of `until` and `returnWhen`. */
export interface SnoozeInput extends ActorOption {
  readonly trendKey: string;
  readonly until?: string | undefined;
  readonly returnWhen?: SnoozeReturnCondition | undefined;
}

export interface UnsnoozeInput extends ActorOption {
  readonly trendKey: string;
  readonly cause: UnsnoozeCause;
}

export interface DismissInput extends ActorOption {
  readonly trendKey: string;
  readonly reason: string;
}

export interface LinkProductionInput extends ActorOption {
  readonly trendKey: string;
  readonly threadId: string;
}

export interface RecordDecisionInput extends ActorOption {
  readonly threadId: string;
  readonly action: DecisionAction;
  readonly utility: number;
  /** Required for edit and reject. */
  readonly reason?: string | undefined;
  /** A version saved with saveScriptVersion for this thread. */
  readonly scriptVersionHash?: string | undefined;
  /** A retry with the same id returns the decision already recorded. */
  readonly operationId?: string | undefined;
}

export interface SaveScriptVersionInput extends ActorOption {
  readonly threadId: string;
  readonly content: string;
  readonly scriptPath?: string | undefined;
}

export interface SaveCaptureInput extends ActorOption {
  readonly threadId: string;
  readonly url: string;
  readonly title?: string | undefined;
  readonly note?: string | undefined;
}

export interface SaveResultInput extends ActorOption {
  readonly threadId: string;
  readonly views?: number | undefined;
  readonly subscribers?: number | undefined;
  readonly clicks?: number | undefined;
  readonly comments?: number | undefined;
  readonly observedAt: string;
}

type InboxError = EditorialPersistenceError | EditorialInvalidInputError;
type ThreadCommandError =
  | EditorialPersistenceError
  | EditorialInvalidInputError
  | EditorialNotFoundError;

/**
 * Human editorial commands. Each mutation writes its row and its event in one
 * transaction; a command that changes nothing writes no event. None of these
 * are exposed to the chat agent.
 */
export class EditorialCommandService extends Context.Service<
  EditorialCommandService,
  {
    readonly markRead: (input: MarkReadInput) => Effect.Effect<TrendInboxState, InboxError>;
    readonly snooze: (input: SnoozeInput) => Effect.Effect<TrendInboxState, InboxError>;
    readonly unsnooze: (input: UnsnoozeInput) => Effect.Effect<TrendInboxState, InboxError>;
    readonly dismiss: (input: DismissInput) => Effect.Effect<TrendInboxState, InboxError>;
    /** Clears a dismissal; the reason stays in the event history. */
    readonly reopen: (
      input: { readonly trendKey: string } & ActorOption,
    ) => Effect.Effect<TrendInboxState, InboxError>;
    /** The thread must be registered as a video thread first. */
    readonly linkProduction: (
      input: LinkProductionInput,
    ) => Effect.Effect<TrendInboxState, InboxError | EditorialNotFoundError>;
    /** One state per key, in request order; keys never touched get an empty state. */
    readonly getInboxState: (
      trendKeys: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<TrendInboxState>, InboxError>;
    /** Stops the work clock and stores the stage durations with the decision. */
    readonly recordDecision: (
      input: RecordDecisionInput,
    ) => Effect.Effect<Decision, ThreadCommandError | EditorialConflictError>;
    /** Content-addressed: saving the same content twice returns the first version. */
    readonly saveScriptVersion: (
      input: SaveScriptVersionInput,
    ) => Effect.Effect<ScriptVersion, ThreadCommandError>;
    readonly saveCapture: (input: SaveCaptureInput) => Effect.Effect<Capture, ThreadCommandError>;
    readonly saveResult: (input: SaveResultInput) => Effect.Effect<VideoResult, ThreadCommandError>;
  }
>()("t3/editorial/EditorialCommandService") {}

interface InboxRow {
  readonly trend_key: string;
  readonly seen_run_id: string | null;
  readonly seen_dossier_id: string | null;
  readonly seen_at: string | null;
  readonly snoozed_at: string | null;
  readonly snoozed_until: string | null;
  readonly snooze_return_json: string | null;
  readonly dismissed_at: string | null;
  readonly dismissed_reason: string | null;
  readonly production_thread_id: string | null;
  readonly production_linked_at: string | null;
  readonly updated_at: string | null;
}

const emptyInboxState = (trendKey: string): TrendInboxState => ({
  trendKey,
  seenRunId: null,
  seenDossierId: null,
  seenAt: null,
  snoozedAt: null,
  snoozedUntil: null,
  snoozeReturn: null,
  dismissedAt: null,
  dismissedReason: null,
  productionThreadId: null,
  productionLinkedAt: null,
  updatedAt: null,
});

const toInboxState = (row: InboxRow): TrendInboxState => ({
  trendKey: row.trend_key,
  seenRunId: row.seen_run_id,
  seenDossierId: row.seen_dossier_id,
  seenAt: row.seen_at,
  snoozedAt: row.snoozed_at,
  snoozedUntil: row.snoozed_until,
  snoozeReturn: row.snooze_return_json === null ? null : decodeSnoozeReturn(row.snooze_return_json),
  dismissedAt: row.dismissed_at,
  dismissedReason: row.dismissed_reason,
  productionThreadId: row.production_thread_id,
  productionLinkedAt: row.production_linked_at,
  updatedAt: row.updated_at,
});

const selectInbox = (sql: SqlClient.SqlClient, trendKey: string) =>
  sql<InboxRow>`
    SELECT
      trend_key, seen_run_id, seen_dossier_id, seen_at, snoozed_at, snoozed_until,
      snooze_return_json, dismissed_at, dismissed_reason, production_thread_id,
      production_linked_at, updated_at
    FROM editorial_trend_inbox
    WHERE trend_key = ${trendKey}
  `.pipe(
    Effect.map((rows) =>
      rows[0] === undefined ? emptyInboxState(trendKey) : toInboxState(rows[0]),
    ),
  );

const ensureInboxRow = (sql: SqlClient.SqlClient, trendKey: string, at: string) =>
  sql`
    INSERT INTO editorial_trend_inbox (trend_key, created_at, updated_at)
    VALUES (${trendKey}, ${at}, ${at})
    ON CONFLICT (trend_key) DO NOTHING
  `;

const invalid = (operation: string, detail: string) =>
  new EditorialInvalidInputError({ operation, detail });

const requireText = (operation: string, field: string, value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0
    ? Effect.fail(invalid(operation, `${field} is required`))
    : Effect.succeed(trimmed);
};

const optionalText = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

const requireIso = (operation: string, field: string, value: string) =>
  Effect.fromOption(parseIso(value)).pipe(
    Effect.mapError(() => invalid(operation, `${field} must be an ISO date-time`)),
  );

const SnoozeReturnJson = Schema.fromJsonString(SnoozeReturnCondition);
const encodeSnoozeReturn = Schema.encodeSync(SnoozeReturnJson);
const decodeSnoozeReturn = Schema.decodeUnknownSync(SnoozeReturnJson);

const sha256Hex = (content: string) =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const eventLog = yield* EditorialEventLog;
  const newId = yield* makeNewId;

  /**
   * Shell of the inbox commands: create the row if needed, let `apply` decide
   * whether anything changes, and return the state after the transaction.
   */
  const inboxCommand = Effect.fn("EditorialCommandService.inboxCommand")(function* <E>(
    operation: string,
    trendKey: string,
    actor: EditorialActor,
    apply: (
      current: TrendInboxState,
      at: string,
    ) => Effect.Effect<
      { readonly type: EditorialEventType; readonly payload: unknown } | undefined,
      E | SqlError
    >,
  ) {
    if (trendKey.trim().length === 0) return yield* invalid(operation, "trendKey is required");
    return yield* eventLog.transact(
      operation,
      Effect.gen(function* () {
        const at = yield* nowIso;
        const current = yield* selectInbox(sql, trendKey);
        const change = yield* apply(current, at);
        if (change === undefined) return { result: current, events: [] };
        const event = yield* appendEvent(sql, {
          type: change.type,
          aggregateKind: "trend",
          aggregateId: trendKey,
          actor,
          payload: change.payload,
          createdAt: at,
        });
        return { result: yield* selectInbox(sql, trendKey), events: [event] };
      }),
    );
  });

  const markRead: EditorialCommandService["Service"]["markRead"] = (input) =>
    inboxCommand("editorial.markRead", input.trendKey, input.actor ?? "operator", (current, at) =>
      Effect.gen(function* () {
        const runId = yield* requireText("editorial.markRead", "runId", input.runId);
        const dossierId = optionalText(input.dossierId);
        if (current.seenRunId === runId && current.seenDossierId === dossierId) return undefined;
        yield* ensureInboxRow(sql, input.trendKey, at);
        yield* sql`
          UPDATE editorial_trend_inbox
          SET seen_run_id = ${runId}, seen_dossier_id = ${dossierId}, seen_at = ${at},
            updated_at = ${at}
          WHERE trend_key = ${input.trendKey}
        `;
        return { type: "trend.read" as const, payload: { runId, dossierId } };
      }),
    );

  const snooze: EditorialCommandService["Service"]["snooze"] = (input) =>
    inboxCommand("editorial.snooze", input.trendKey, input.actor ?? "operator", (_current, at) =>
      Effect.gen(function* () {
        if (input.until === undefined && input.returnWhen === undefined) {
          return yield* invalid("editorial.snooze", "until or returnWhen is required");
        }
        const until =
          input.until === undefined
            ? null
            : yield* requireIso("editorial.snooze", "until", input.until);
        const returnWhen = input.returnWhen ?? null;
        if (
          returnWhen !== null &&
          (!Number.isFinite(returnWhen.baseline) ||
            !Number.isFinite(returnWhen.atLeast) ||
            returnWhen.metric.trim().length === 0)
        ) {
          return yield* invalid("editorial.snooze", "returnWhen needs a metric and finite numbers");
        }
        yield* ensureInboxRow(sql, input.trendKey, at);
        yield* sql`
          UPDATE editorial_trend_inbox
          SET snoozed_at = ${at}, snoozed_until = ${until},
            snooze_return_json = ${returnWhen === null ? null : encodeSnoozeReturn(returnWhen)},
            updated_at = ${at}
          WHERE trend_key = ${input.trendKey}
        `;
        return { type: "trend.snoozed" as const, payload: { until, returnWhen } };
      }),
    );

  const unsnooze: EditorialCommandService["Service"]["unsnooze"] = (input) =>
    inboxCommand("editorial.unsnooze", input.trendKey, input.actor ?? "operator", (current, at) =>
      Effect.gen(function* () {
        if (current.snoozedAt === null) return undefined;
        yield* sql`
          UPDATE editorial_trend_inbox
          SET snoozed_at = NULL, snoozed_until = NULL, snooze_return_json = NULL,
            updated_at = ${at}
          WHERE trend_key = ${input.trendKey}
        `;
        return { type: "trend.unsnoozed" as const, payload: { cause: input.cause } };
      }),
    );

  const dismiss: EditorialCommandService["Service"]["dismiss"] = (input) =>
    inboxCommand("editorial.dismiss", input.trendKey, input.actor ?? "operator", (current, at) =>
      Effect.gen(function* () {
        const reason = yield* requireText("editorial.dismiss", "reason", input.reason);
        if (current.dismissedAt !== null && current.dismissedReason === reason) return undefined;
        yield* ensureInboxRow(sql, input.trendKey, at);
        yield* sql`
          UPDATE editorial_trend_inbox
          SET dismissed_at = ${at}, dismissed_reason = ${reason}, updated_at = ${at}
          WHERE trend_key = ${input.trendKey}
        `;
        return { type: "trend.dismissed" as const, payload: { reason } };
      }),
    );

  const reopen: EditorialCommandService["Service"]["reopen"] = (input) =>
    inboxCommand("editorial.reopen", input.trendKey, input.actor ?? "operator", (current, at) =>
      Effect.gen(function* () {
        if (current.dismissedAt === null) return undefined;
        yield* sql`
          UPDATE editorial_trend_inbox
          SET dismissed_at = NULL, dismissed_reason = NULL, updated_at = ${at}
          WHERE trend_key = ${input.trendKey}
        `;
        return {
          type: "trend.reopened" as const,
          payload: { previousReason: current.dismissedReason },
        };
      }),
    );

  const linkProduction: EditorialCommandService["Service"]["linkProduction"] = (input) =>
    inboxCommand(
      "editorial.linkProduction",
      input.trendKey,
      input.actor ?? "operator",
      (current, at) =>
        Effect.gen(function* () {
          yield* requireVideoThread(sql, input.threadId);
          if (current.productionThreadId === input.threadId) return undefined;
          yield* ensureInboxRow(sql, input.trendKey, at);
          yield* sql`
            UPDATE editorial_trend_inbox
            SET production_thread_id = ${input.threadId}, production_linked_at = ${at},
              updated_at = ${at}
            WHERE trend_key = ${input.trendKey}
          `;
          return {
            type: "trend.production-linked" as const,
            payload: { threadId: input.threadId, previousThreadId: current.productionThreadId },
          };
        }),
    );

  const getInboxState: EditorialCommandService["Service"]["getInboxState"] = Effect.fn(
    "EditorialCommandService.getInboxState",
  )(function* (trendKeys) {
    if (trendKeys.length > MAX_INBOX_KEYS_PER_READ) {
      return yield* invalid(
        "editorial.getInboxState",
        `at most ${MAX_INBOX_KEYS_PER_READ} keys per read`,
      );
    }
    if (trendKeys.length === 0) return [];
    const rows = yield* sql<InboxRow>`
      SELECT
        trend_key, seen_run_id, seen_dossier_id, seen_at, snoozed_at, snoozed_until,
        snooze_return_json, dismissed_at, dismissed_reason, production_thread_id,
        production_linked_at, updated_at
      FROM editorial_trend_inbox
      WHERE trend_key IN ${sql.in([...new Set(trendKeys)])}
    `.pipe(Effect.mapError(toPersistenceError("editorial.getInboxState")));
    const byKey = new Map(rows.map((row) => [row.trend_key, toInboxState(row)]));
    return trendKeys.map((key) => byKey.get(key) ?? emptyInboxState(key));
  });

  const threadCommand = <A, E>(
    operation: string,
    threadId: string,
    body: (
      at: string,
    ) => Effect.Effect<
      { readonly result: A; readonly events: ReadonlyArray<EditorialEvent> },
      E | SqlError
    >,
  ) =>
    eventLog.transact(
      operation,
      Effect.gen(function* () {
        yield* requireVideoThread(sql, threadId);
        return yield* body(yield* nowIso);
      }),
    );

  const recordDecision: EditorialCommandService["Service"]["recordDecision"] = Effect.fn(
    "EditorialCommandService.recordDecision",
  )(function* (input) {
    const operation = "editorial.recordDecision";
    if (!Number.isInteger(input.utility) || input.utility < 1 || input.utility > 5) {
      return yield* invalid(operation, "utility must be an integer from 1 to 5");
    }
    const reason =
      input.action === "accept"
        ? optionalText(input.reason)
        : yield* requireText(operation, "reason", input.reason);
    const actor = input.actor ?? "operator";
    return yield* threadCommand(operation, input.threadId, (at) =>
      Effect.gen(function* () {
        if (
          yield* operationAlreadyApplied(
            sql,
            operation,
            input.operationId,
            input.threadId,
            "decision.recorded",
          )
        ) {
          const existing = yield* sql<DecisionRow>`
              SELECT * FROM editorial_decisions
              WHERE decision_id = (
                SELECT json_extract(payload_json, '$.decisionId') FROM editorial_events
                WHERE operation_id = ${input.operationId ?? null}
              )
            `;
          return { result: toDecision(existing[0]!), events: [] };
        }
        const hash = optionalText(input.scriptVersionHash);
        if (hash !== null) {
          const versions = yield* sql`
              SELECT 1 FROM editorial_script_versions
              WHERE thread_id = ${input.threadId} AND content_hash = ${hash}
            `;
          if (versions.length === 0) {
            return yield* new EditorialNotFoundError({ entity: "script_version", id: hash });
          }
        }
        const clockEvents = yield* stopClock(sql, {
          threadId: input.threadId,
          at,
          reason: "decided",
          actor,
        });
        const summary = summarize(input.threadId, yield* loadIntervals(sql, input.threadId), at);
        const stageMs = (stage: string) =>
          summary.stages.find((entry) => entry.stage === stage)?.activeMs ?? null;
        const decisionId = yield* newId;
        const totalMs = summary.stages.length === 0 ? null : summary.activeMs;
        yield* sql`
            INSERT INTO editorial_decisions (
              decision_id, thread_id, action, utility, reason, script_version_hash,
              explore_ms, read_ms, write_ms, decide_ms, total_ms, clock_definitive, actor,
              decided_at
            )
            VALUES (
              ${decisionId}, ${input.threadId}, ${input.action}, ${input.utility}, ${reason},
              ${hash}, ${stageMs("explore")}, ${stageMs("read")}, ${stageMs("write")},
              ${stageMs("decide")}, ${totalMs}, ${summary.definitive ? 1 : 0}, ${actor}, ${at}
            )
          `;
        const decisionEvent = yield* appendEvent(sql, {
          type: "decision.recorded",
          aggregateKind: "video_thread",
          aggregateId: input.threadId,
          operationId: input.operationId,
          actor,
          payload: {
            decisionId,
            action: input.action,
            utility: input.utility,
            scriptVersionHash: hash,
            clockDefinitive: summary.definitive,
          },
          createdAt: at,
        });
        const rows = yield* sql<DecisionRow>`
            SELECT * FROM editorial_decisions WHERE decision_id = ${decisionId}
          `;
        return { result: toDecision(rows[0]!), events: [...clockEvents, decisionEvent] };
      }),
    );
  });

  const saveScriptVersion: EditorialCommandService["Service"]["saveScriptVersion"] = Effect.fn(
    "EditorialCommandService.saveScriptVersion",
  )(function* (input) {
    const operation = "editorial.saveScriptVersion";
    if (Buffer.byteLength(input.content, "utf8") > MAX_SCRIPT_SNAPSHOT_BYTES) {
      return yield* invalid(operation, `script exceeds ${MAX_SCRIPT_SNAPSHOT_BYTES} bytes`);
    }
    const contentHash = sha256Hex(input.content);
    const scriptPath = optionalText(input.scriptPath);
    const actor = input.actor ?? "operator";
    return yield* threadCommand(operation, input.threadId, (at) =>
      Effect.gen(function* () {
        const existing = yield* selectScriptVersion(sql, input.threadId, contentHash);
        if (existing !== undefined) return { result: existing, events: [] };
        const versionId = yield* newId;
        yield* sql`
            INSERT INTO editorial_script_versions (
              version_id, thread_id, content_hash, snapshot, script_path, actor, saved_at
            )
            VALUES (
              ${versionId}, ${input.threadId}, ${contentHash}, ${input.content}, ${scriptPath},
              ${actor}, ${at}
            )
          `;
        const event = yield* appendEvent(sql, {
          type: "script.version-saved",
          aggregateKind: "video_thread",
          aggregateId: input.threadId,
          actor,
          payload: {
            versionId,
            contentHash,
            scriptPath,
            bytes: Buffer.byteLength(input.content, "utf8"),
          },
          createdAt: at,
        });
        const saved: ScriptVersion = {
          versionId,
          threadId: input.threadId,
          contentHash,
          scriptPath,
          savedAt: at,
        };
        return { result: saved, events: [event] };
      }),
    );
  });

  const saveCapture: EditorialCommandService["Service"]["saveCapture"] = Effect.fn(
    "EditorialCommandService.saveCapture",
  )(function* (input) {
    const operation = "editorial.saveCapture";
    const url = yield* requireText(operation, "url", input.url);
    if (!URL.canParse(url)) return yield* invalid(operation, "url is not a valid URL");
    const title = optionalText(input.title);
    const note = optionalText(input.note);
    const actor = input.actor ?? "operator";
    return yield* threadCommand(operation, input.threadId, (at) =>
      Effect.gen(function* () {
        const captureId = yield* newId;
        yield* sql`
            INSERT INTO editorial_captures (
              capture_id, thread_id, url, title, note, actor, captured_at
            )
            VALUES (${captureId}, ${input.threadId}, ${url}, ${title}, ${note}, ${actor}, ${at})
          `;
        const event = yield* appendEvent(sql, {
          type: "capture.saved",
          aggregateKind: "video_thread",
          aggregateId: input.threadId,
          actor,
          payload: { captureId, url, title },
          createdAt: at,
        });
        const capture: Capture = {
          captureId,
          threadId: input.threadId,
          url,
          title,
          note,
          capturedAt: at,
        };
        return { result: capture, events: [event] };
      }),
    );
  });

  const saveResult: EditorialCommandService["Service"]["saveResult"] = Effect.fn(
    "EditorialCommandService.saveResult",
  )(function* (input) {
    const operation = "editorial.saveResult";
    const metrics = {
      views: input.views ?? null,
      subscribers: input.subscribers ?? null,
      clicks: input.clicks ?? null,
      comments: input.comments ?? null,
    };
    const values = Object.values(metrics);
    if (values.every((value) => value === null)) {
      return yield* invalid(operation, "at least one metric is required");
    }
    if (values.some((value) => value !== null && (!Number.isInteger(value) || value < 0))) {
      return yield* invalid(operation, "metrics must be non-negative integers");
    }
    const observedAt = yield* requireIso(operation, "observedAt", input.observedAt);
    const actor = input.actor ?? "operator";
    return yield* threadCommand(operation, input.threadId, (at) =>
      Effect.gen(function* () {
        const resultId = yield* newId;
        yield* sql`
            INSERT INTO editorial_video_results (
              result_id, thread_id, views, subscribers, clicks, comments, observed_at, actor,
              recorded_at
            )
            VALUES (
              ${resultId}, ${input.threadId}, ${metrics.views}, ${metrics.subscribers},
              ${metrics.clicks}, ${metrics.comments}, ${observedAt}, ${actor}, ${at}
            )
          `;
        const event = yield* appendEvent(sql, {
          type: "result.saved",
          aggregateKind: "video_thread",
          aggregateId: input.threadId,
          actor,
          payload: { resultId, ...metrics, observedAt },
          createdAt: at,
        });
        const result: VideoResult = {
          resultId,
          threadId: input.threadId,
          ...metrics,
          observedAt,
          recordedAt: at,
        };
        return { result, events: [event] };
      }),
    );
  });

  return EditorialCommandService.of({
    markRead,
    snooze,
    unsnooze,
    dismiss,
    reopen,
    linkProduction,
    getInboxState,
    recordDecision,
    saveScriptVersion,
    saveCapture,
    saveResult,
  });
});

interface DecisionRow {
  readonly decision_id: string;
  readonly thread_id: string;
  readonly action: DecisionAction;
  readonly utility: number;
  readonly reason: string | null;
  readonly script_version_hash: string | null;
  readonly explore_ms: number | null;
  readonly read_ms: number | null;
  readonly write_ms: number | null;
  readonly decide_ms: number | null;
  readonly total_ms: number | null;
  readonly clock_definitive: number;
  readonly actor: EditorialActor;
  readonly decided_at: string;
}

const toDecision = (row: DecisionRow): Decision => ({
  decisionId: row.decision_id,
  threadId: row.thread_id,
  action: row.action,
  utility: row.utility,
  reason: row.reason,
  scriptVersionHash: row.script_version_hash,
  durations: {
    exploreMs: row.explore_ms,
    readMs: row.read_ms,
    writeMs: row.write_ms,
    decideMs: row.decide_ms,
    totalMs: row.total_ms,
  },
  clockDefinitive: row.clock_definitive === 1,
  actor: row.actor,
  decidedAt: row.decided_at,
});

const selectScriptVersion = (sql: SqlClient.SqlClient, threadId: string, contentHash: string) =>
  sql<{
    readonly version_id: string;
    readonly script_path: string | null;
    readonly saved_at: string;
  }>`
    SELECT version_id, script_path, saved_at FROM editorial_script_versions
    WHERE thread_id = ${threadId} AND content_hash = ${contentHash}
  `.pipe(
    Effect.map((rows): ScriptVersion | undefined =>
      rows[0] === undefined
        ? undefined
        : {
            versionId: rows[0].version_id,
            threadId,
            contentHash,
            scriptPath: rows[0].script_path,
            savedAt: rows[0].saved_at,
          },
    ),
  );

export const layer = Layer.effect(EditorialCommandService, make);
