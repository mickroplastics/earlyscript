import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { nowIso } from "./persistence/support.ts";
import { WorkClockService } from "./WorkClockService.ts";

/**
 * A video thread deleted in T3, as the orchestrator announces it: its clock stops, and one
 * editorial event on the thread makes every open view of it read again, so another client's
 * workspace learns of the deletion without a reload. The record stays until a purge.
 */
const onThreadDeleted = Effect.fn("VideoThreadDeletion.onThreadDeleted")(function* (
  threadId: string,
) {
  const sql = yield* EditorialSql;
  const log = yield* EditorialEventLog;
  const clocks = yield* WorkClockService;
  const rows = yield* sql`SELECT 1 FROM editorial_video_threads WHERE thread_id = ${threadId}`;
  if (rows.length === 0) return;
  yield* clocks.stop(threadId, { actor: "system" });
  yield* log.transact(
    "editorial.videoThreadDeleted",
    Effect.gen(function* () {
      const event = yield* appendEvent(sql, {
        type: "video-thread.t3-deleted",
        aggregateKind: "video_thread",
        aggregateId: threadId,
        actor: "system",
        payload: {},
        createdAt: yield* nowIso,
      });
      return { result: undefined, events: [event] };
    }),
  );
});

/** Follows T3's domain events for the server's lifetime; absent without the orchestrator. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
    if (Option.isNone(threads)) return;
    const context = yield* Effect.context<EditorialSql | EditorialEventLog | WorkClockService>();
    yield* threads.value.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "thread.deleted"),
      Stream.runForEach((event) =>
        onThreadDeleted(event.threadId).pipe(
          Effect.provide(context),
          Effect.catch((error) =>
            Effect.logWarning("Editorial: a deleted video thread was not marked", error),
          ),
        ),
      ),
      Effect.catch((error) => Effect.logWarning("Editorial: T3 deletions not followed", error)),
      Effect.forkScoped,
    );
  }),
);
