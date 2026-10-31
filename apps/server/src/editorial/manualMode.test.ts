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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
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

/** The video handlers with the preview manager the browser history listens to. */
const layer = EditorialVideoRpc.layer.pipe(
  Layer.provideMerge(PreviewManager.layer),
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
