// @effect-diagnostics nodeBuiltinImport:off - the purge tests check the version copy on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EDITORIAL_VIDEO_WS_METHODS,
  EditorialTrendKey,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type EditorialVideoError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../preview/Manager.ts";
import { BrowserVisitService, visitOfPreviewEvent } from "./BrowserVisitService.ts";
import * as EditorialResultsService from "./EditorialResultsService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { SCRIPT, VIDEO_THREAD_ID, withVideoWorkspace } from "./videoThread.testkit.ts";
import * as EditorialVideoRpc from "./videoRpc.ts";

const MANUAL = ThreadId.make("thread-manual");
const MANUAL_SCRIPT = "videos/manual.md";
const MINUTE = 60_000;

/** Threads a test deleted in T3; the double of ThreadManagementService reports them so. */
const deletedThreads = new Set<string>();

/** T3's domain events as the double publishes them; a test announces a deletion here. */
class T3DomainEvents extends Context.Service<
  T3DomainEvents,
  PubSub.PubSub<{ readonly type: string; readonly threadId: string }>
>()("t3/editorial/manualMode.test/T3DomainEvents") {}

/** Deletes a thread in T3 as the orchestrator does: the shell, then the domain event. */
const deleteInT3 = (threadId: string) =>
  Effect.gen(function* () {
    deletedThreads.add(threadId);
    yield* PubSub.publish(yield* T3DomainEvents, { type: "thread.deleted", threadId });
  });

/** T3 threads that exist unless a test deleted them, and their domain events. */
const layerT3 = Layer.unwrap(
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<{ readonly type: string; readonly threadId: string }>();
    return Layer.merge(
      Layer.succeed(T3DomainEvents, events),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed({
            ...liveThreadShell(threadId),
            deletedAt: deletedThreads.has(threadId)
              ? DateTime.makeUnsafe("2026-10-31T06:00:00.000Z")
              : null,
          }),
        streamDomainEvents: Stream.fromPubSub(events) as never,
      }),
    );
  }),
);

/**
 * The video handlers with the preview manager the browser history listens to, a state
 * directory for version copies, and T3 threads that exist unless a test deleted them.
 */
const layer = EditorialVideoRpc.layer.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(layerT3),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "editorial-manual-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const reasonOf = (error: EditorialVideoError | { readonly _tag: string }) =>
  "reason" in error ? error.reason : error._tag;

/** Registers a manual thread next to the testkit's assisted one, with its clock in Explorar. */
const registerManual = Effect.gen(function* () {
  yield* EditorialThreadService.use((threads) =>
    threads.registerVideoThread({
      operationId: "op-manual",
      environmentId: "env-1",
      threadId: MANUAL,
      mode: "manual",
      scriptPath: MANUAL_SCRIPT,
    }),
  );
  const handlers = yield* EditorialVideoRpc.EditorialVideoRpcHandlers;
  yield* handlers[EDITORIAL_VIDEO_WS_METHODS.clock]({
    threadId: MANUAL,
    command: { _tag: "start", stage: "explore" },
  });
  return handlers;
});

const withManual = <A, E, R>(
  body: (
    handlers: EditorialVideoRpc.EditorialVideoHandlers,
    workspace: Parameters<Parameters<typeof withVideoWorkspace>[0]>[0],
  ) => Effect.Effect<A, E, R>,
) =>
  withVideoWorkspace((workspace) =>
    Effect.gen(function* () {
      deletedThreads.clear();
      const handlers = yield* registerManual;
      return yield* body(handlers, workspace);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );

/**
 * The recorder writes on its own fiber: subscribed before the reports, this waits for its
 * next `count` visits to commit.
 */
const nextVisits = Effect.fn("nextVisits")(function* (count: number) {
  const log = yield* EditorialEventLog;
  const subscription = yield* log.subscribe;
  return <E>(run: Effect.Effect<unknown, E>) =>
    run.pipe(
      Effect.andThen(
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event.type === "browser.visited"),
          Stream.take(count),
          Stream.runDrain,
        ),
      ),
    );
});

describe("manual video thread: stages", () => {
  it.effect("closes Explorar and opens Escribir in one step, and back", () =>
    withManual((handlers) =>
      Effect.gen(function* () {
        const clock = (stage: "explore" | "write") =>
          handlers[EDITORIAL_VIDEO_WS_METHODS.clock]({
            threadId: MANUAL,
            command: { _tag: "stage", stage },
          });
        yield* TestClock.adjust(10 * MINUTE);
        const writing = yield* clock("write");
        assert.deepStrictEqual(
          writing.clock.state._tag === "running" && writing.clock.state.stage,
          "write",
        );
        assert.deepStrictEqual(
          writing.clock.stages.map(({ stage, activeMs }) => [stage, activeMs]),
          [
            ["explore", 10 * MINUTE],
            ["write", 0],
          ],
        );
        yield* TestClock.adjust(5 * MINUTE);
        const back = yield* clock("explore");
        assert.deepStrictEqual(
          back.clock.stages.map(({ stage, activeMs, segments }) => [stage, activeMs, segments]),
          [
            ["explore", 10 * MINUTE, 2],
            ["write", 5 * MINUTE, 1],
          ],
        );

        // One open segment at a time, and each change ends one where the next begins.
        const sql = yield* EditorialSql;
        const rows = yield* sql<{
          readonly stage: string;
          readonly status: string;
          readonly started_at: string;
          readonly ended_at: string | null;
          readonly end_reason: string | null;
        }>`
          SELECT stage, status, started_at, ended_at, end_reason FROM editorial_work_intervals
          WHERE thread_id = ${MANUAL} ORDER BY started_at, rowid
        `;
        assert.deepStrictEqual(
          rows.map((row) => [row.stage, row.status, row.end_reason]),
          [
            ["explore", "closed", "stage_changed"],
            ["write", "closed", "stage_changed"],
            ["explore", "open", null],
          ],
        );
        assert.strictEqual(rows[0]?.ended_at, rows[1]?.started_at);
        assert.strictEqual(rows[1]?.ended_at, rows[2]?.started_at);

        const same = yield* clock("explore").pipe(Effect.flip);
        assert.strictEqual(reasonOf(same), "clock-state");
      }),
    ),
  );
});

describe("manual video thread: captures", () => {
  it.effect("keeps a page with its note, lists it and takes it off the list", () =>
    withManual((handlers) =>
      Effect.gen(function* () {
        const saved = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "https://news.ycombinator.com/item?id=50061",
          title: "Google breaks open a bottleneck in quantum computing",
          note: "mucho debate sobre si es real",
        });
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "https://github.com/trending",
        });
        assert.deepStrictEqual(
          saved.captures.map(({ url, title, note }) => ({ url, title, note })),
          [
            {
              url: "https://news.ycombinator.com/item?id=50061",
              title: "Google breaks open a bottleneck in quantum computing",
              note: "mucho debate sobre si es real",
            },
          ],
        );
        const view = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: MANUAL });
        assert.deepStrictEqual(
          view.video?.captures.map((capture) => [capture.url, capture.note]),
          [
            ["https://news.ycombinator.com/item?id=50061", "mucho debate sobre si es real"],
            ["https://github.com/trending", null],
          ],
        );

        const invalid = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "not a url",
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(invalid), "invalid-input");

        const first = saved.captures[0]!.captureId;
        const removed = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.removeCapture]({
          threadId: MANUAL,
          captureId: first,
        });
        assert.deepStrictEqual(
          removed.captures.map((capture) => capture.url),
          ["https://github.com/trending"],
        );
        // Removing it again changes nothing and writes nothing.
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.removeCapture]({
          threadId: MANUAL,
          captureId: first,
        });
        const types = (yield* (yield* EditorialEventLog).readSince(0))
          .filter((event) => event.aggregateId === MANUAL)
          .map((event) => event.type)
          .filter((type) => type.startsWith("capture."));
        assert.deepStrictEqual(types, ["capture.saved", "capture.saved", "capture.removed"]);

        // A capture of another thread is not this thread's to remove.
        const foreign = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: ThreadId.make(VIDEO_THREAD_ID),
          url: "https://example.com/",
        });
        const notMine = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.removeCapture]({
          threadId: MANUAL,
          captureId: foreign.captures[0]!.captureId,
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(notMine), "not-found");
      }),
    ),
  );
});

describe("manual video thread: browser history", () => {
  it.effect("records each page a manual tab finished loading, from the preview manager", () =>
    withManual((handlers) =>
      Effect.gen(function* () {
        const previews = yield* PreviewManager.PreviewManager;
        const tab = yield* previews.open({ threadId: MANUAL, url: "https://news.ycombinator.com" });
        const report = (url: string, title: string, tag: "Loading" | "Success" = "Success") =>
          previews.reportStatus({
            threadId: MANUAL,
            tabId: tab.tabId,
            navStatus: { _tag: tag, url, title },
            canGoBack: false,
            canGoForward: false,
          });
        const visits = handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: MANUAL }).pipe(
          Effect.map((view) => view.video?.visits ?? []),
        );

        // A load in progress is not a visit; the finished one is, and its title follows.
        yield* (yield* nextVisits(2))(
          Effect.gen(function* () {
            yield* report("https://news.ycombinator.com/", "", "Loading");
            yield* report("https://news.ycombinator.com/", "");
            yield* report("https://news.ycombinator.com/", "Hacker News");
          }),
        );
        // A reload of the same page is not a new visit.
        yield* (yield* nextVisits(1))(
          Effect.gen(function* () {
            yield* report("https://news.ycombinator.com/", "Hacker News");
            yield* report("https://github.com/trending", "Trending repositories on GitHub today");
          }),
        );
        const recorded = yield* visits;
        assert.deepStrictEqual(
          recorded.map(({ tabId, url, title, origin }) => ({ tabId, url, title, origin })),
          [
            {
              tabId: tab.tabId,
              url: "https://github.com/trending",
              title: "Trending repositories on GitHub today",
              origin: "desktop",
            },
            {
              tabId: tab.tabId,
              url: "https://news.ycombinator.com/",
              title: "Hacker News",
              origin: "desktop",
            },
          ],
        );

        // The assisted thread's browser keeps no history. The recorder handles events in
        // order, so the manual visit reported after it settles it.
        const service = yield* BrowserVisitService;
        const assisted = yield* previews.open({ threadId: ThreadId.make(VIDEO_THREAD_ID) });
        yield* (yield* nextVisits(1))(
          Effect.gen(function* () {
            yield* previews.reportStatus({
              threadId: ThreadId.make(VIDEO_THREAD_ID),
              tabId: assisted.tabId,
              navStatus: { _tag: "Success", url: "https://example.com/", title: "Example" },
              canGoBack: false,
              canGoForward: false,
            });
            yield* report("https://lobste.rs/", "Lobsters");
          }),
        );
        assert.strictEqual((yield* visits).length, 3);
        assert.deepStrictEqual(yield* service.list(VIDEO_THREAD_ID), []);
        const view = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({
          threadId: ThreadId.make(VIDEO_THREAD_ID),
        });
        assert.deepStrictEqual(view.video?.visits, []);
      }),
    ),
  );

  it.effect("ignores blank pages, failures, and a decided thread", () =>
    withManual((handlers, { write }) =>
      Effect.gen(function* () {
        const service = yield* BrowserVisitService;
        const visit = (url: string) =>
          service.record({ threadId: MANUAL, tabId: "tab-1", url, title: null, origin: "server" });
        assert.isTrue(Option.isNone(yield* visit("about:blank")));
        assert.isTrue(Option.isSome(yield* visit("https://threads.net/")));
        assert.isNull(
          visitOfPreviewEvent({
            type: "failed",
            threadId: MANUAL,
            tabId: "tab-1",
            createdAt: "2026-10-31T10:00:00.000Z",
            serverEpoch: "epoch",
            revision: 1,
            url: "https://down.example/",
            title: "",
            code: -105,
            description: "NAME_NOT_RESOLVED",
          }),
        );

        yield* write(MANUAL_SCRIPT, SCRIPT);
        const saved = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: MANUAL });
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: MANUAL,
          action: "accept",
          utility: 3,
          scriptVersionHash: saved.script.head?.contentHash ?? null,
          operationId: "decision-manual",
        });
        assert.isTrue(Option.isNone(yield* visit("https://x.com/")));
        const late = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "https://x.com/",
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(late), "decided");
      }),
    ),
  );
});

describe("manual video thread: decision and Results", () => {
  it.effect("records Explorar, Escribir and Decidir, and Results counts it complete", () =>
    withManual((handlers, { write }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust(12 * MINUTE);
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: MANUAL,
          command: { _tag: "stage", stage: "write" },
        });
        yield* write(MANUAL_SCRIPT, SCRIPT);
        // Saving a version while writing leaves the stage where it is.
        const saved = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: MANUAL });
        assert.deepStrictEqual(
          saved.clock.state._tag === "running" && saved.clock.state.stage,
          "write",
        );
        yield* TestClock.adjust(8 * MINUTE);
        const decided = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: MANUAL,
          action: "edit",
          utility: 3,
          reason: "Needs a sharper hook",
          scriptVersionHash: saved.script.head?.contentHash ?? null,
          operationId: "decision-manual",
        });
        assert.deepStrictEqual(decided.decision?.durations, {
          exploreMs: 12 * MINUTE,
          readMs: null,
          writeMs: 8 * MINUTE,
          decideMs: 0,
          totalMs: 20 * MINUTE,
        });
        assert.strictEqual(decided.clock.state._tag, "idle");

        const summary = yield* EditorialResultsService.EditorialResultsService.use(
          (service) => service.summary,
        ).pipe(Effect.provide(EditorialResultsService.layer));
        const manual = summary.modes.find((mode) => mode.mode === "manual");
        assert.strictEqual(manual?.partialCoverage, 0);
        const explore = summary.comparisons.find((comparison) => comparison.key === "explore");
        assert.strictEqual(explore?.manual.n, 1);
        assert.strictEqual(
          summary.comparisons.find((comparison) => comparison.key === "total")?.manual.n,
          1,
        );
      }),
    ),
  );
});

describe("manual video thread: creation", () => {
  it.effect("creates a manual thread with no dossier, its clock in Explorar, once", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
      const launch = Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Ref.update(calls, (current) => [...current, input]).pipe(
            Effect.as({
              threadId: input.threadId as ThreadId,
              projection: {} as ThreadLaunch.ThreadLaunchResult["projection"],
              resumed: false,
            }),
          ),
      });
      yield* withVideoWorkspace(
        () =>
          Effect.gen(function* () {
            const handlers = yield* EditorialVideoRpc.EditorialVideoRpcHandlers;
            const input = {
              operationId: "click-1",
              projectId: ProjectId.make("project:studio"),
              title: "Manual · 31 oct",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
              trendKey: EditorialTrendKey.make("trend:quantum"),
            };
            const created = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.createManual](input);
            assert.isTrue(created.created);
            const again = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.createManual](input);
            assert.deepStrictEqual(again, { threadId: created.threadId, created: false });
            const launched = yield* Ref.get(calls);
            assert.strictEqual(launched.length, 1);
            assert.isUndefined(launched[0]?.initialMessage);

            const view = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({
              threadId: created.threadId,
            });
            assert.strictEqual(view.video?.thread.mode, "manual");
            assert.strictEqual(view.video?.thread.dossierId, null);
            assert.strictEqual(view.video?.thread.trendKey, "trend:quantum");
            assert.deepStrictEqual(
              view.video?.clock.state._tag === "running" && view.video.clock.state.stage,
              "explore",
            );
            // The trend's production link stays for its assisted thread.
            const sql = yield* EditorialSql;
            const linked = yield* sql`
              SELECT 1 FROM editorial_trend_inbox WHERE production_thread_id IS NOT NULL
            `;
            assert.strictEqual(linked.length, 0);
          }).pipe(Effect.provide(layer), Effect.scoped),
        { launch },
      );
    }),
  );
});

describe("manual video thread: deleted in T3", () => {
  it.effect("reads the record of a deleted thread and refuses work on it", () =>
    withManual((handlers) =>
      Effect.gen(function* () {
        const saved = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "https://news.ycombinator.com/",
        });
        assert.strictEqual(saved.thread.deleted, false);
        // A live thread keeps its record: a purge needs the thread deleted first.
        const live = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.purge]({ threadId: MANUAL }).pipe(
          Effect.flip,
        );
        assert.strictEqual(reasonOf(live), "thread-live");

        deletedThreads.add(MANUAL);
        const view = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: MANUAL });
        assert.strictEqual(view.video?.thread.deleted, true);
        const refusals = [
          handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({ threadId: MANUAL, url: "https://x.com/" }),
          handlers[EDITORIAL_VIDEO_WS_METHODS.removeCapture]({
            threadId: MANUAL,
            captureId: saved.captures[0]!.captureId,
          }),
          handlers[EDITORIAL_VIDEO_WS_METHODS.clock]({
            threadId: MANUAL,
            command: { _tag: "stage", stage: "write" },
          }),
          handlers[EDITORIAL_VIDEO_WS_METHODS.clock]({
            threadId: MANUAL,
            command: { _tag: "pause" },
          }),
          handlers[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: MANUAL }),
          handlers[EDITORIAL_VIDEO_WS_METHODS.decide]({
            threadId: MANUAL,
            action: "accept",
            utility: 3,
            scriptVersionHash: null,
            operationId: "decision-deleted",
          }),
          handlers[EDITORIAL_VIDEO_WS_METHODS.saveResult]({
            threadId: MANUAL,
            views: 1,
            observedAt: "2026-10-31T12:00:00.000Z",
          }),
        ];
        for (const refused of refusals) {
          assert.strictEqual(reasonOf(yield* Effect.flip(refused)), "thread-deleted");
        }
        // Nothing moved: the clock still runs Explorar's one segment, the capture is listed.
        const after = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: MANUAL });
        assert.deepStrictEqual(
          after.video?.clock.stages.map(({ stage, segments }) => [stage, segments]),
          [["explore", 1]],
        );
        assert.strictEqual(after.video?.captures.length, 1);
      }),
    ),
  );
});

describe("manual video thread: purge", () => {
  it.effect("deletes every row and copy of a deleted thread, and nothing else", () =>
    withManual((handlers, { write }) =>
      Effect.gen(function* () {
        const sql = yield* EditorialSql;
        const visits = yield* BrowserVisitService;
        yield* visits.record({
          threadId: MANUAL,
          tabId: "tab-1",
          url: "https://news.ycombinator.com/",
          title: "Hacker News",
          origin: "server",
        });
        const kept = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "https://github.com/trending",
          note: "nota del operador",
        });
        // «Quitar» hides a capture; its row stays until the purge.
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.removeCapture]({
          threadId: MANUAL,
          captureId: kept.captures[0]!.captureId,
        });
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "https://x.com/",
        });
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: MANUAL,
          command: { _tag: "stage", stage: "write" },
        });
        yield* write(MANUAL_SCRIPT, SCRIPT);
        const saved = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: MANUAL });
        const hash = saved.script.head!.contentHash;
        const copy = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.openVersion]({
          threadId: MANUAL,
          contentHash: hash,
        });
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: MANUAL,
          action: "accept",
          utility: 4,
          scriptVersionHash: hash,
          operationId: "decision-purge",
        });
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.saveResult]({
          threadId: MANUAL,
          views: 10,
          observedAt: "2026-10-31T12:00:00.000Z",
        });
        yield* sql`
          INSERT INTO editorial_trend_inbox (
            trend_key, production_thread_id, production_linked_at, created_at, updated_at
          )
          VALUES ('trend:quantum', ${MANUAL}, '2026-10-31', '2026-10-31', '2026-10-31')
        `;
        assert.isTrue(NodeFS.existsSync(copy.path));

        yield* deleteInT3(MANUAL);
        const purged = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.purge]({ threadId: MANUAL });
        assert.deepStrictEqual(purged.deleted, {
          visits: 1,
          captures: 2,
          scriptVersions: 1,
          versionFiles: 1,
          decisions: 1,
          results: 1,
          workIntervals: 3,
          events: purged.deleted.events,
        });
        assert.isAbove(purged.deleted.events, 0);
        assert.isFalse(NodeFS.existsSync(copy.path));

        const counts = yield* Effect.forEach(
          [
            "editorial_video_threads",
            "editorial_browser_visits",
            "editorial_captures",
            "editorial_script_versions",
            "editorial_decisions",
            "editorial_video_results",
            "editorial_work_intervals",
          ],
          (table) =>
            sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM ${sql(table)} WHERE thread_id = ${MANUAL}
            `.pipe(Effect.map((rows) => [table, rows[0]?.n] as const)),
        );
        assert.deepStrictEqual(
          counts.filter(([, n]) => n !== 0),
          [],
        );
        // Only the purge itself stays in the log, with counts and no URL or note.
        const left = yield* sql<{ readonly type: string; readonly payload_json: string }>`
          SELECT type, payload_json FROM editorial_events
          WHERE aggregate_kind = 'video_thread' AND aggregate_id = ${MANUAL}
        `;
        assert.deepStrictEqual(
          left.map((row) => row.type),
          ["video-thread.purged"],
        );
        assert.notInclude(left[0]!.payload_json, "http");
        assert.notInclude(left[0]!.payload_json, "nota");
        const link = yield* sql<{ readonly production_thread_id: string | null }>`
          SELECT production_thread_id FROM editorial_trend_inbox WHERE trend_key = 'trend:quantum'
        `;
        assert.strictEqual(link[0]?.production_thread_id, null);
        // The view is that of an ordinary thread now; the other video thread is untouched.
        const view = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: MANUAL });
        assert.strictEqual(view.video, null);
        const other = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({
          threadId: ThreadId.make(VIDEO_THREAD_ID),
        });
        assert.strictEqual(other.video?.thread.mode, "assisted");
      }),
    ),
  );
});

describe("manual video thread: deleted from another client", () => {
  it.effect("tells every open view and stops the clock when T3 deletes the thread", () =>
    withManual((handlers) =>
      Effect.gen(function* () {
        // Two clients with the thread open, as two WebSocket subscriptions.
        const first = yield* Stream.toQueue(
          handlers[EDITORIAL_VIDEO_WS_METHODS.subscribe]({ threadId: MANUAL }),
          { capacity: 16 },
        );
        const second = yield* Stream.toQueue(
          handlers[EDITORIAL_VIDEO_WS_METHODS.subscribe]({ threadId: MANUAL }),
          { capacity: 16 },
        );
        for (const queue of [first, second]) {
          const opened = yield* Queue.take(queue);
          assert.strictEqual(opened.video?.thread.deleted, false);
          assert.strictEqual(opened.video?.clock.state._tag, "running");
        }
        yield* TestClock.adjust(3 * MINUTE);
        // A third client deletes it in T3.
        yield* deleteInT3(MANUAL);
        for (const queue of [first, second]) {
          let view = yield* Queue.take(queue);
          while (view.video?.thread.deleted !== true) view = yield* Queue.take(queue);
          // The deletion reaches every view with the clock already stopped.
          let last = view;
          while (last.video?.clock.state._tag !== "idle") last = yield* Queue.take(queue);
          assert.strictEqual(last.video?.thread.deleted, true);
          assert.deepStrictEqual(
            last.video?.clock.stages.map(({ stage, activeMs }) => [stage, activeMs]),
            [["explore", 3 * MINUTE]],
          );
        }
        // Time after the deletion does not count.
        yield* TestClock.adjust(10 * MINUTE);
        const after = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: MANUAL });
        assert.strictEqual(after.video?.clock.activeMs, 3 * MINUTE);
        const types = (yield* (yield* EditorialEventLog).readSince(0))
          .filter((event) => event.aggregateId === MANUAL)
          .map((event) => event.type);
        assert.includeMembers(types, ["work.stopped", "video-thread.t3-deleted"]);
      }),
    ),
  );
});

describe("manual video thread: purge that fails on disk", () => {
  it.effect("keeps the whole record when a copy cannot be deleted, and purges on retry", () =>
    withManual((handlers, { write }) =>
      Effect.gen(function* () {
        const sql = yield* EditorialSql;
        yield* handlers[EDITORIAL_VIDEO_WS_METHODS.capture]({
          threadId: MANUAL,
          url: "https://news.ycombinator.com/",
          note: "nota",
        });
        yield* write(MANUAL_SCRIPT, SCRIPT);
        const saved = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: MANUAL });
        const copy = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.openVersion]({
          threadId: MANUAL,
          contentHash: saved.script.head!.contentHash,
        });
        yield* deleteInT3(MANUAL);

        const dir = NodePath.dirname(copy.path);
        NodeFS.chmodSync(dir, 0o500);
        const failed = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.purge]({ threadId: MANUAL }).pipe(
          Effect.flip,
          Effect.ensuring(Effect.sync(() => NodeFS.chmodSync(dir, 0o700))),
        );
        assert.strictEqual(reasonOf(failed), "storage");
        // Nothing went: the copy, the record and its events are all there to purge again.
        assert.isTrue(NodeFS.existsSync(copy.path));
        const kept = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: MANUAL });
        assert.strictEqual(kept.video?.captures.length, 1);
        assert.strictEqual(kept.video?.script.versionCount, 1);
        const purgedEvents = yield* sql`
          SELECT 1 FROM editorial_events WHERE type = 'video-thread.purged'
        `;
        assert.strictEqual(purgedEvents.length, 0);

        const retried = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.purge]({ threadId: MANUAL });
        assert.strictEqual(retried.deleted.versionFiles, 1);
        assert.strictEqual(retried.deleted.captures, 1);
        assert.isFalse(NodeFS.existsSync(copy.path));
        const left = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM editorial_video_threads WHERE thread_id = ${MANUAL}
        `;
        assert.strictEqual(left[0]?.n, 0);
      }),
    ),
  );
});
