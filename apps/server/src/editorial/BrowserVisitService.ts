import type { EditorialVideoBrowserVisit, PreviewEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as PreviewManager from "../preview/Manager.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import type { VideoThreadMode } from "./persistence/EditorialModel.ts";
import { type EditorialPersistenceError, toPersistenceError } from "./persistence/Errors.ts";
import { makeNewId, nowIso } from "./persistence/support.ts";

export type BrowserVisitOrigin = EditorialVideoBrowserVisit["origin"];

export interface RecordVisitInput {
  readonly threadId: string;
  readonly tabId: string;
  readonly url: string;
  readonly title: string | null;
  readonly origin: BrowserVisitOrigin;
}

/** Most recent first; the view of a thread shows at most this many. */
const VISITS_LIMIT = 200;

/**
 * Pages a manual thread's tabs finished loading, from the preview manager both browser
 * runtimes report to, so the record survives a client reload. Loads in progress, failures,
 * reloads, and assisted, ordinary or decided threads record nothing.
 */
export class BrowserVisitService extends Context.Service<
  BrowserVisitService,
  {
    /** The visit recorded, or none when the event is not a new visit of an open manual thread. */
    readonly record: (
      input: RecordVisitInput,
    ) => Effect.Effect<Option.Option<EditorialVideoBrowserVisit>, EditorialPersistenceError>;
    readonly list: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<EditorialVideoBrowserVisit>, EditorialPersistenceError>;
  }
>()("t3/editorial/BrowserVisitService") {}

interface VisitRow {
  readonly visit_id: string;
  readonly tab_id: string;
  readonly url: string;
  readonly title: string | null;
  readonly origin: BrowserVisitOrigin;
  readonly visited_at: string;
}

const toVisit = (row: VisitRow): EditorialVideoBrowserVisit => ({
  visitId: row.visit_id,
  tabId: row.tab_id,
  url: row.url,
  title: row.title,
  origin: row.origin,
  visitedAt: row.visited_at,
});

/** Pages a person reads; the preview's blank and internal pages are not part of the record. */
const isRecordableUrl = (url: string) => /^https?:\/\//i.test(url);

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const eventLog = yield* EditorialEventLog;
  const newId = yield* makeNewId;

  const record: BrowserVisitService["Service"]["record"] = Effect.fn("BrowserVisitService.record")(
    function* (input) {
      if (!isRecordableUrl(input.url)) return Option.none();
      const title = input.title?.trim() || null;
      return yield* eventLog.transact(
        "editorial.recordBrowserVisit",
        Effect.gen(function* () {
          const thread = yield* sql<{ readonly mode: VideoThreadMode; readonly decided: number }>`
            SELECT
              mode,
              EXISTS (SELECT 1 FROM editorial_decisions d WHERE d.thread_id = t.thread_id)
                AS decided
            FROM editorial_video_threads t
            WHERE thread_id = ${input.threadId}
          `;
          const row = thread[0];
          if (row === undefined || row.mode !== "manual" || row.decided === 1) {
            return { result: Option.none(), events: [] };
          }
          const previous = yield* sql<VisitRow>`
            SELECT visit_id, tab_id, url, title, origin, visited_at
            FROM editorial_browser_visits
            WHERE thread_id = ${input.threadId} AND tab_id = ${input.tabId}
            ORDER BY visited_at DESC, rowid DESC
            LIMIT 1
          `;
          const last = previous[0];
          const at = yield* nowIso;
          if (last !== undefined && last.url === input.url) {
            // The same page again: a reload, or its title arriving after the load.
            if (title === null || last.title !== null) return { result: Option.none(), events: [] };
            yield* sql`
              UPDATE editorial_browser_visits SET title = ${title} WHERE visit_id = ${last.visit_id}
            `;
            const event = yield* appendEvent(sql, {
              type: "browser.visited",
              aggregateKind: "video_thread",
              aggregateId: input.threadId,
              actor: "system",
              payload: { visitId: last.visit_id, url: last.url, title, titleOnly: true },
              createdAt: at,
            });
            return { result: Option.some(toVisit({ ...last, title })), events: [event] };
          }
          const visit: VisitRow = {
            visit_id: yield* newId,
            tab_id: input.tabId,
            url: input.url,
            title,
            origin: input.origin,
            visited_at: at,
          };
          yield* sql`
            INSERT INTO editorial_browser_visits (
              visit_id, thread_id, tab_id, url, title, origin, visited_at
            )
            VALUES (
              ${visit.visit_id}, ${input.threadId}, ${visit.tab_id}, ${visit.url}, ${visit.title},
              ${visit.origin}, ${visit.visited_at}
            )
          `;
          const event = yield* appendEvent(sql, {
            type: "browser.visited",
            aggregateKind: "video_thread",
            aggregateId: input.threadId,
            actor: "system",
            payload: {
              visitId: visit.visit_id,
              tabId: visit.tab_id,
              url: visit.url,
              title,
              origin: visit.origin,
            },
            createdAt: at,
          });
          return { result: Option.some(toVisit(visit)), events: [event] };
        }),
      );
    },
  );

  const list: BrowserVisitService["Service"]["list"] = (threadId) =>
    sql<VisitRow>`
      SELECT visit_id, tab_id, url, title, origin, visited_at
      FROM editorial_browser_visits
      WHERE thread_id = ${threadId}
      ORDER BY visited_at DESC, rowid DESC
      LIMIT ${VISITS_LIMIT}
    `.pipe(
      Effect.map((rows) => rows.map(toVisit)),
      Effect.mapError(toPersistenceError("editorial.listBrowserVisits")),
    );

  return BrowserVisitService.of({ record, list });
});

/** What a preview event says about a visit: only a load that finished on a page. */
export const visitOfPreviewEvent = (event: PreviewEvent): RecordVisitInput | null => {
  if (event.type !== "navigated") return null;
  const { snapshot } = event;
  if (snapshot.navStatus._tag !== "Success") return null;
  return {
    threadId: event.threadId,
    tabId: event.tabId,
    url: snapshot.navStatus.url,
    title: snapshot.navStatus.title,
    origin:
      snapshot.automationOwner !== undefined
        ? "automation"
        : snapshot.runtime === "server"
          ? "server"
          : "desktop",
  };
};

/**
 * Follows the preview manager for the server's lifetime and records the visits of manual
 * threads. Taken from the context when present, so a server or a test without previews still
 * builds; a failed write is logged and the next event is recorded.
 */
const recorder = Effect.gen(function* () {
  const previews = yield* Effect.serviceOption(PreviewManager.PreviewManager);
  if (Option.isNone(previews)) return;
  const visits = yield* BrowserVisitService;
  const subscription = yield* previews.value.subscribeEvents;
  yield* Stream.fromSubscription(subscription).pipe(
    Stream.runForEach((event) => {
      const visit = visitOfPreviewEvent(event);
      return visit === null
        ? Effect.void
        : visits
            .record(visit)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Editorial browser visit not recorded", error),
              ),
            );
    }),
    Effect.forkScoped,
  );
});

/** The service, and the recorder over it once the layer is built. */
export const layer = Layer.effectDiscard(recorder).pipe(
  Layer.provideMerge(Layer.effect(BrowserVisitService, make)),
);
