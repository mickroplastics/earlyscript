import {
  EditorialCommandError,
  type EditorialCreateVideoInput,
  type EditorialCreateVideoResult,
  type EditorialDismissInput,
  type EditorialMarkReadInput,
  type EditorialSnoozeInput,
  type EditorialTrendKey,
  type EditorialTrendKeyInput,
  type EditorialTrendStateResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import type { SnoozeReturnCondition } from "./persistence/EditorialModel.ts";
import {
  isReadableRun,
  selectDossier,
  selectLatestRun,
  selectRun,
  selectTrendDossier,
  snoozeMetricValue,
} from "./runIndex.ts";

/**
 * Default "keep watching" threshold: the trend comes back when its items of the last 7 days
 * reach 1.5 times the value it had when snoozed, and at least 3 more items. One more item on
 * a quiet trend is noise; half again as much activity is the smallest change worth a look.
 */
const SNOOZE_GROWTH_FACTOR = 1.5;
const SNOOZE_GROWTH_MIN_DELTA = 3;

export const defaultGrowthTarget = (baseline: number) =>
  Math.max(baseline + SNOOZE_GROWTH_MIN_DELTA, Math.ceil(baseline * SNOOZE_GROWTH_FACTOR));

/** The authenticated session behind a request. The actor comes from here, never the payload. */
export interface EditorialSession {
  readonly sessionId: string;
}

type Result = Effect.Effect<EditorialTrendStateResult, EditorialCommandError>;

export interface EditorialInboxCommandsShape {
  readonly markRead: (session: EditorialSession, input: EditorialMarkReadInput) => Result;
  readonly snooze: (session: EditorialSession, input: EditorialSnoozeInput) => Result;
  readonly unsnooze: (session: EditorialSession, input: EditorialTrendKeyInput) => Result;
  readonly dismiss: (session: EditorialSession, input: EditorialDismissInput) => Result;
  readonly reopen: (session: EditorialSession, input: EditorialTrendKeyInput) => Result;
  /**
   * One assisted video thread per trend: a trend already in production resumes its thread's
   * operation, and a retry of the same dossier replays it; either finishes a step left undone.
   */
  readonly createVideo: (
    session: EditorialSession,
    input: EditorialCreateVideoInput,
  ) => Effect.Effect<EditorialCreateVideoResult, EditorialCommandError>;
}

/**
 * The inbox commands a person issues from the editorial space. Each resolves run cutoffs,
 * snooze baselines and dossier hashes from the run index, so the client cannot reorder runs,
 * move a baseline or attach another dossier, and records the session as the operator. Reached only through the WebSocket RPC, behind
 * `orchestration:operate`; no MCP tool or orchestration command calls it.
 */
export class EditorialInboxCommands extends Context.Service<
  EditorialInboxCommands,
  EditorialInboxCommandsShape
>()("t3/editorial/EditorialInboxCommands") {}

const commandError =
  (reason: EditorialCommandError["reason"], message: string) =>
  (cause?: unknown): EditorialCommandError =>
    new EditorialCommandError({
      reason,
      message:
        cause !== null && typeof cause === "object" && "message" in cause
          ? `${message}: ${String(cause.message)}`
          : message,
    });

/** Storage, validation and launch errors of the editorial services, in the contract's terms. */
const fromCommandFailure = (cause: {
  readonly _tag: string;
  readonly message: string;
}): EditorialCommandError =>
  new EditorialCommandError({
    reason:
      cause._tag === "EditorialInvalidInputError" || cause._tag === "EditorialConflictError"
        ? "invalid-input"
        : cause._tag === "EditorialNotFoundError"
          ? "not-found"
          : cause._tag === "EditorialVideoLaunchError"
            ? "launch-failed"
            : "storage",
    message: cause.message,
  });

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const commands = yield* EditorialCommandService;
  const read = yield* EditorialReadService;
  const threads = yield* EditorialThreadService;

  const operator = (session: EditorialSession) =>
    ({ actor: "operator", actorSessionId: session.sessionId }) as const;

  const respond = (trendKey: EditorialTrendKey) =>
    read.getTrendState(trendKey).pipe(
      Effect.map(({ state }) => ({ trendKey, state })),
      Effect.mapError(commandError("storage", "Cannot read the trend state")),
    );

  /** The indexed run and dossier the operator acted on, which must belong to the trend. */
  const requireTrendDossier = Effect.fn("EditorialInboxCommands.requireTrendDossier")(function* (
    input: EditorialMarkReadInput,
  ) {
    const run = yield* selectRun(sql, input.runId).pipe(
      Effect.mapError(commandError("storage", "Cannot read the run index")),
    );
    if (Option.isNone(run)) {
      return yield* commandError("not-found", `Run ${input.runId} has not been imported`)();
    }
    if (!isReadableRun(run.value)) {
      return yield* commandError("not-found", `Run ${input.runId} is invalid`)();
    }
    const dossier = yield* selectDossier(sql, input.runId, input.dossierId).pipe(
      Effect.mapError(commandError("storage", "Cannot read the dossier index")),
    );
    if (Option.isNone(dossier) || dossier.value.trend_key !== input.trendKey) {
      return yield* commandError(
        "not-found",
        `Dossier ${input.dossierId} of run ${input.runId} is not trend ${input.trendKey}`,
      )();
    }
    return { run: run.value, dossier: dossier.value };
  });

  const markRead: EditorialInboxCommandsShape["markRead"] = Effect.fn(
    "EditorialInboxCommands.markRead",
  )(function* (session, input) {
    const { run } = yield* requireTrendDossier(input);
    yield* commands
      .markRead({
        ...operator(session),
        trendKey: input.trendKey,
        runId: input.runId,
        runCutoffAt: run.cutoff_at,
        dossierId: input.dossierId,
      })
      .pipe(Effect.mapError(fromCommandFailure));
    return yield* respond(input.trendKey);
  });

  const snooze: EditorialInboxCommandsShape["snooze"] = Effect.fn("EditorialInboxCommands.snooze")(
    function* (session, input) {
      const latest = yield* selectLatestRun(sql).pipe(
        Effect.mapError(commandError("storage", "Cannot read the run index")),
      );
      const dossier = Option.isNone(latest)
        ? Option.none()
        : yield* selectTrendDossier(sql, latest.value.run_id, input.trendKey).pipe(
            Effect.mapError(commandError("storage", "Cannot read the dossier index")),
          );
      const metric = input.returnWhen?.metric ?? "items7d";
      const baseline = Option.match(dossier, {
        onNone: () => 0,
        onSome: (row) => snoozeMetricValue(row, metric) ?? 0,
      });
      let returnWhen: SnoozeReturnCondition | undefined;
      if (input.returnWhen !== undefined) {
        if (input.returnWhen.atLeast <= baseline) {
          return yield* commandError(
            "invalid-input",
            `returnWhen.atLeast must exceed the current ${metric} (${baseline})`,
          )();
        }
        returnWhen = { metric, baseline, atLeast: input.returnWhen.atLeast };
      } else if (input.until === undefined) {
        returnWhen = { metric, baseline, atLeast: defaultGrowthTarget(baseline) };
      }
      yield* commands
        .snooze({
          ...operator(session),
          trendKey: input.trendKey,
          until: input.until,
          returnWhen,
        })
        .pipe(Effect.mapError(fromCommandFailure));
      return yield* respond(input.trendKey);
    },
  );

  const unsnooze: EditorialInboxCommandsShape["unsnooze"] = Effect.fn(
    "EditorialInboxCommands.unsnooze",
  )(function* (session, input) {
    yield* commands
      .unsnooze({ ...operator(session), trendKey: input.trendKey, cause: "operator" })
      .pipe(Effect.mapError(fromCommandFailure));
    return yield* respond(input.trendKey);
  });

  const dismiss: EditorialInboxCommandsShape["dismiss"] = Effect.fn(
    "EditorialInboxCommands.dismiss",
  )(function* (session, input) {
    yield* commands
      .dismiss({ ...operator(session), trendKey: input.trendKey, reason: input.reason })
      .pipe(Effect.mapError(fromCommandFailure));
    return yield* respond(input.trendKey);
  });

  const reopen: EditorialInboxCommandsShape["reopen"] = Effect.fn("EditorialInboxCommands.reopen")(
    function* (session, input) {
      yield* commands
        .reopen({ ...operator(session), trendKey: input.trendKey })
        .pipe(Effect.mapError(fromCommandFailure));
      return yield* respond(input.trendKey);
    },
  );

  const createVideo: EditorialInboxCommandsShape["createVideo"] = Effect.fn(
    "EditorialInboxCommands.createVideo",
  )(function* (_session, input) {
    const { dossier } = yield* requireTrendDossier(input);
    const before = yield* respond(input.trendKey);
    // A production link does not prove the operation finished (the clock may not have
    // started): a trend's thread resumes its own operation, which replays the steps done.
    const linked =
      before.state.production === null
        ? Option.none()
        : yield* threads
            .getVideoThread(before.state.production.threadId)
            .pipe(Effect.mapError(fromCommandFailure));
    const operation = Option.match(linked, {
      onNone: () => ({
        // Derived from the dossier, so a double click or a retry replays the same operation.
        operationId: `editorial:trend-video:${input.runId}:${input.dossierId}`,
        mode: "assisted" as const,
        runId: input.runId,
        dossierId: input.dossierId,
        dossierHash: dossier.content_hash,
      }),
      onSome: (thread) => ({
        operationId: thread.operationId,
        mode: thread.mode,
        runId: thread.runId ?? undefined,
        dossierId: thread.dossierId ?? undefined,
        dossierHash: thread.dossierHash ?? undefined,
      }),
    });
    const shown = yield* read
      .getDossier({ runId: input.runId, dossierId: input.dossierId, evidenceLimit: 1 })
      .pipe(Effect.mapError(commandError("not-found", "Cannot read the dossier")));
    const created = yield* threads
      .createVideo({
        ...operation,
        projectId: input.projectId,
        title: shown.trend.presentation?.title ?? shown.trend.label,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        creationSource: "web",
        trendKey: input.trendKey,
      })
      .pipe(Effect.mapError(fromCommandFailure));
    const { state } = yield* respond(input.trendKey);
    return {
      trendKey: input.trendKey,
      threadId: ThreadId.make(created.thread.threadId),
      created: created.created,
      state,
    };
  });

  return EditorialInboxCommands.of({ markRead, snooze, unsnooze, dismiss, reopen, createVideo });
});

export const layer = Layer.effect(EditorialInboxCommands, make);
