import * as Effect from "effect/Effect";

import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import type { VideoThread } from "./persistence/EditorialModel.ts";
import { nowIso } from "./persistence/support.ts";

/**
 * The database half of `editorial.video.purge`, run once the version copies are off the disk:
 * every row of the thread, its events and its registration in one transaction, the trend's
 * production link cleared, and one `video-thread.purged` event with counts and no content.
 */
export const purgeVideoRecord = Effect.fn("EditorialPurge.purgeVideoRecord")(function* (
  thread: Pick<VideoThread, "threadId" | "operationId" | "mode">,
  versionFiles: number,
) {
  const sql = yield* EditorialSql;
  const log = yield* EditorialEventLog;
  const { threadId } = thread;
  const deleteRows = (table: string) =>
    sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ${sql(table)} WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.n ?? 0),
      Effect.tap(() => sql`DELETE FROM ${sql(table)} WHERE thread_id = ${threadId}`),
    );
  return yield* log.transact(
    "editorial.purgeVideoThread",
    Effect.gen(function* () {
      // Decisions name a version, so they go before the versions they reference.
      const counts = {
        visits: yield* deleteRows("editorial_browser_visits"),
        captures: yield* deleteRows("editorial_captures"),
        decisions: yield* deleteRows("editorial_decisions"),
        results: yield* deleteRows("editorial_video_results"),
        workIntervals: yield* deleteRows("editorial_work_intervals"),
        scriptVersions: yield* deleteRows("editorial_script_versions"),
      };
      const events = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM editorial_events
        WHERE aggregate_kind = 'video_thread' AND aggregate_id = ${threadId}
      `.pipe(Effect.map((rows) => rows[0]?.n ?? 0));
      yield* sql`
        DELETE FROM editorial_events
        WHERE aggregate_kind = 'video_thread' AND aggregate_id = ${threadId}
      `;
      const at = yield* nowIso;
      yield* sql`
        UPDATE editorial_trend_inbox
        SET production_thread_id = NULL, production_linked_at = NULL, updated_at = ${at}
        WHERE production_thread_id = ${threadId}
      `;
      yield* sql`DELETE FROM editorial_video_threads WHERE thread_id = ${threadId}`;
      const result = { ...counts, versionFiles, events };
      // Counts only: the record of the purge keeps no URL, note or script.
      const event = yield* appendEvent(sql, {
        type: "video-thread.purged",
        aggregateKind: "video_thread",
        aggregateId: threadId,
        actor: "operator",
        payload: { operationId: thread.operationId, mode: thread.mode, ...result },
        createdAt: at,
      });
      return { result, events: [event] };
    }),
  );
});
