import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { WorkClockService } from "./WorkClockService.ts";

/** The run T3 creates for a message the operator sent; restarts and delegated tasks are not. */
export interface OperatorRun {
  readonly threadId: string;
  readonly restartContinuationOfRunId?: unknown;
  readonly delegatedTaskId?: unknown;
}

export const isOperatorRun = (run: OperatorRun): boolean =>
  run.restartContinuationOfRunId === undefined && run.delegatedTaskId === undefined;

/**
 * In an assisted video thread, Leer ends at the operator's first request to the agent. Only
 * from a Leer the operator did not choose by hand, when Escribir never ran and before the
 * decision, all checked in the stage change's own transaction.
 */
export const onRunCreated = Effect.fn("AssistedWritingStart.onRunCreated")(function* (
  threadId: string,
) {
  const sql = yield* EditorialSql;
  const clocks = yield* WorkClockService;
  const rows = yield* sql<{ readonly mode: string }>`
    SELECT mode FROM editorial_video_threads WHERE thread_id = ${threadId}
  `;
  if (rows[0]?.mode !== "assisted") return;
  yield* clocks
    .changeStage(threadId, "write", {
      actor: "system",
      source: "auto",
      onlyFrom: "read",
      onlyFirst: true,
      unlessChosenByHand: true,
      cause: "agent-request",
      refuseWhenDecided: true,
    })
    .pipe(
      Effect.catchIf(
        (error) => error._tag === "WorkClockStateError" && error.reason === "decided",
        () => Effect.void,
      ),
    );
});

/** Follows T3's domain events for the server's lifetime; absent without the orchestrator. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
    if (Option.isNone(threads)) return;
    const context = yield* Effect.context<EditorialSql | WorkClockService>();
    yield* threads.value.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "run.created"),
      Stream.runForEach((event) =>
        event.type === "run.created" && isOperatorRun(event.payload)
          ? onRunCreated(event.payload.threadId).pipe(
              Effect.provide(context),
              Effect.catch((error) =>
                Effect.logWarning("Editorial: the clock did not move to Escribir", error),
              ),
            )
          : Effect.void,
      ),
      Effect.catch((error) => Effect.logWarning("Editorial: T3 runs not followed", error)),
      Effect.forkScoped,
    );
  }),
);
