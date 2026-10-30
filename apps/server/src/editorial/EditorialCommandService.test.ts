import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { WorkClockService } from "./WorkClockService.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";

const TREND = "trend:quantum-computing";
const THREAD = "thread-video";
const CUTOFF_1 = "2026-10-29T00:00:00.000Z";
const CUTOFF_2 = "2026-10-30T00:00:00.000Z";

const registerThread = Effect.gen(function* () {
  const threads = yield* EditorialThreadService;
  yield* threads.registerVideoThread({
    operationId: "op-register",
    environmentId: "env-1",
    threadId: THREAD,
    mode: "assisted",
    trendKey: TREND,
    runId: "run-1",
  });
});

const events = Effect.gen(function* () {
  const log = yield* EditorialEventLog;
  return yield* log.readSince(0);
});

describe("EditorialCommandService inbox", () => {
  it.effect("marks read once per run and records each change as an event", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const read = yield* commands.markRead({
          trendKey: TREND,
          runId: "run-1",
          runCutoffAt: CUTOFF_1,
          dossierId: "d-1",
        });
        assert.strictEqual(read.seenRunId, "run-1");
        assert.strictEqual(read.seenDossierId, "d-1");
        yield* commands.markRead({
          trendKey: TREND,
          runId: "run-1",
          runCutoffAt: CUTOFF_1,
          dossierId: "d-1",
        });
        yield* commands.markRead({
          trendKey: TREND,
          runId: "run-2",
          runCutoffAt: CUTOFF_2,
          dossierId: "d-2",
        });

        const log = yield* events;
        assert.deepStrictEqual(
          log.map((event) => [event.type, event.aggregateId]),
          [
            ["trend.read", TREND],
            ["trend.read", TREND],
          ],
        );
        assert.deepStrictEqual(log[1]!.payload, {
          runId: "run-2",
          runCutoffAt: CUTOFF_2,
          dossierId: "d-2",
        });
      }),
    ),
  );

  it.effect("ignores a read of an older run that arrives after a newer one", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        yield* commands.markRead({
          trendKey: TREND,
          runId: "run_20261030",
          runCutoffAt: CUTOFF_2,
        });
        const late = yield* commands.markRead({
          trendKey: TREND,
          runId: "run_20261029",
          runCutoffAt: CUTOFF_1,
        });
        assert.strictEqual(late.seenRunId, "run_20261030");
        assert.strictEqual(late.seenRunCutoffAt, CUTOFF_2);
        assert.lengthOf(yield* events, 1);

        const badCutoff = yield* Effect.flip(
          commands.markRead({ trendKey: TREND, runId: "run-x", runCutoffAt: "yesterday" }),
        );
        assert.strictEqual(badCutoff._tag, "EditorialInvalidInputError");
      }),
    ),
  );

  it.effect("snoozes with a return condition and unsnoozes", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const missing = yield* Effect.flip(commands.snooze({ trendKey: TREND }));
        assert.strictEqual(missing._tag, "EditorialInvalidInputError");

        const returnWhen = { metric: "items_7d", baseline: 12, atLeast: 18 };
        const snoozed = yield* commands.snooze({
          trendKey: TREND,
          until: "2026-11-06T12:00:00-05:00",
          returnWhen,
        });
        assert.strictEqual(snoozed.snoozedUntil, "2026-11-06T17:00:00.000Z");
        assert.deepStrictEqual(snoozed.snoozeReturn, returnWhen);

        const woken = yield* commands.unsnooze({ trendKey: TREND, cause: "growth" });
        assert.isNull(woken.snoozedAt);
        assert.isNull(woken.snoozeReturn);
        // Unsnoozing twice changes nothing.
        yield* commands.unsnooze({ trendKey: TREND, cause: "operator" });

        const log = yield* events;
        assert.deepStrictEqual(
          log.map((event) => event.type),
          ["trend.snoozed", "trend.unsnoozed"],
        );
        assert.deepStrictEqual(log[1]!.payload, { cause: "growth" });
      }),
    ),
  );

  it.effect("dismisses with a reason, reopens, and keeps states independent", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const noReason = yield* Effect.flip(commands.dismiss({ trendKey: TREND, reason: "  " }));
        assert.strictEqual(noReason._tag, "EditorialInvalidInputError");

        yield* commands.markRead({ trendKey: TREND, runId: "run-1", runCutoffAt: CUTOFF_1 });
        const dismissed = yield* commands.dismiss({ trendKey: TREND, reason: "off-topic" });
        assert.strictEqual(dismissed.dismissedReason, "off-topic");
        assert.strictEqual(dismissed.seenRunId, "run-1");

        const reopened = yield* commands.reopen({ trendKey: TREND });
        assert.isNull(reopened.dismissedAt);
        assert.isNull(reopened.dismissedReason);
        assert.strictEqual(reopened.seenRunId, "run-1");

        const log = yield* events;
        assert.deepStrictEqual(
          log.map((event) => event.type),
          ["trend.read", "trend.dismissed", "trend.reopened"],
        );
        assert.deepStrictEqual(log[2]!.payload, { previousReason: "off-topic" });
      }),
    ),
  );

  it.effect("links production only to a registered video thread", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const unknown = yield* Effect.flip(
          commands.linkProduction({ trendKey: TREND, threadId: THREAD }),
        );
        assert.strictEqual(unknown._tag, "EditorialNotFoundError");

        yield* registerThread;
        const linked = yield* commands.linkProduction({ trendKey: TREND, threadId: THREAD });
        assert.strictEqual(linked.productionThreadId, THREAD);

        const [state, untouched] = yield* commands.getInboxState([TREND, "trend:other"]);
        assert.strictEqual(state!.productionThreadId, THREAD);
        assert.strictEqual(untouched!.trendKey, "trend:other");
        assert.isNull(untouched!.seenRunId);

        assert.deepStrictEqual(
          (yield* events).map((event) => event.type),
          ["video-thread.registered", "trend.production-linked"],
        );
      }),
    ),
  );

  it.effect("publishes events after commit and nothing for a rolled back command", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const log = yield* EditorialEventLog;
        const collected = yield* log.changes.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* Effect.flip(commands.linkProduction({ trendKey: TREND, threadId: "missing" }));
        yield* commands.markRead({ trendKey: TREND, runId: "run-1", runCutoffAt: CUTOFF_1 });

        const published = yield* Fiber.join(collected);
        assert.deepStrictEqual(
          Array.from(published, (event) => event.type),
          ["trend.read"],
        );
        assert.strictEqual(yield* log.latestSeq, 1);
      }),
    ),
  );
});

describe("EditorialCommandService thread records", () => {
  it.effect("records a decision with stage durations and stops the clock", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const clock = yield* WorkClockService;
        yield* registerThread;

        yield* clock.start(THREAD, "read");
        yield* TestClock.adjust(Duration.minutes(5));
        yield* clock.changeStage(THREAD, "write");
        yield* TestClock.adjust(Duration.minutes(15));
        const version = yield* commands.saveScriptVersion({
          threadId: THREAD,
          content: "# Hook\n\nQuantum computing [hn:1]\n",
          scriptPath: "videos/quantum.md",
        });
        const same = yield* commands.saveScriptVersion({
          threadId: THREAD,
          content: "# Hook\n\nQuantum computing [hn:1]\n",
        });
        assert.strictEqual(same.versionId, version.versionId);
        assert.match(version.contentHash, /^[0-9a-f]{64}$/);

        const rejectWithoutReason = yield* Effect.flip(
          commands.recordDecision({ threadId: THREAD, action: "reject", utility: 2 }),
        );
        assert.strictEqual(rejectWithoutReason._tag, "EditorialInvalidInputError");
        const badUtility = yield* Effect.flip(
          commands.recordDecision({ threadId: THREAD, action: "accept", utility: 6 }),
        );
        assert.strictEqual(badUtility._tag, "EditorialInvalidInputError");
        const unknownVersion = yield* Effect.flip(
          commands.recordDecision({
            threadId: THREAD,
            action: "accept",
            utility: 4,
            scriptVersionHash: "0".repeat(64),
          }),
        );
        assert.strictEqual(unknownVersion._tag, "EditorialNotFoundError");

        const decision = yield* commands.recordDecision({
          threadId: THREAD,
          action: "accept",
          utility: 4,
          scriptVersionHash: version.contentHash,
          operationId: "op-decide",
        });
        assert.deepStrictEqual(decision.durations, {
          exploreMs: null,
          readMs: Duration.toMillis(Duration.minutes(5)),
          writeMs: Duration.toMillis(Duration.minutes(15)),
          decideMs: null,
          totalMs: Duration.toMillis(Duration.minutes(20)),
        });
        assert.isTrue(decision.clockDefinitive);
        assert.strictEqual(decision.scriptVersionHash, version.contentHash);
        assert.strictEqual((yield* clock.summary(THREAD)).state._tag, "idle");

        const replay = yield* commands.recordDecision({
          threadId: THREAD,
          action: "accept",
          utility: 4,
          operationId: "op-decide",
        });
        assert.strictEqual(replay.decisionId, decision.decisionId);

        assert.deepStrictEqual(
          (yield* events).map((event) => event.type),
          [
            "video-thread.registered",
            "work.started",
            "work.stage-changed",
            "script.version-saved",
            "work.stopped",
            "decision.recorded",
          ],
        );
      }),
    ),
  );

  it.effect("keeps the pause length when deciding while paused", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const clock = yield* WorkClockService;
        yield* registerThread;

        yield* clock.start(THREAD, "write");
        yield* TestClock.adjust(Duration.seconds(1));
        yield* clock.pause(THREAD);
        yield* TestClock.adjust(Duration.seconds(5));
        const decision = yield* commands.recordDecision({
          threadId: THREAD,
          action: "accept",
          utility: 4,
        });
        assert.strictEqual(decision.durations.totalMs, 1000);

        yield* TestClock.adjust(Duration.minutes(10));
        const summary = yield* clock.summary(THREAD);
        assert.strictEqual(summary.state._tag, "idle");
        assert.strictEqual(summary.activeMs, 1000);
        assert.strictEqual(summary.pausedMs, 5000);
      }),
    ),
  );

  it.effect("saves captures and results with their events", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        yield* registerThread;

        const badUrl = yield* Effect.flip(commands.saveCapture({ threadId: THREAD, url: "nope" }));
        assert.strictEqual(badUrl._tag, "EditorialInvalidInputError");
        const capture = yield* commands.saveCapture({
          threadId: THREAD,
          url: "https://news.ycombinator.com/item?id=1",
          title: "IBM quantum roadmap",
          note: "  ",
        });
        assert.strictEqual(capture.title, "IBM quantum roadmap");
        assert.isNull(capture.note);

        const empty = yield* Effect.flip(
          commands.saveResult({ threadId: THREAD, observedAt: "2026-11-10T00:00:00Z" }),
        );
        assert.strictEqual(empty._tag, "EditorialInvalidInputError");
        const negative = yield* Effect.flip(
          commands.saveResult({ threadId: THREAD, views: -1, observedAt: "2026-11-10T00:00:00Z" }),
        );
        assert.strictEqual(negative._tag, "EditorialInvalidInputError");
        const result = yield* commands.saveResult({
          threadId: THREAD,
          views: 1200,
          subscribers: 14,
          observedAt: "2026-11-10T00:00:00Z",
        });
        assert.strictEqual(result.views, 1200);
        assert.isNull(result.clicks);
        assert.strictEqual(result.observedAt, "2026-11-10T00:00:00.000Z");

        const missing = yield* Effect.flip(
          commands.saveCapture({ threadId: "missing", url: "https://example.com" }),
        );
        assert.strictEqual(missing._tag, "EditorialNotFoundError");

        assert.deepStrictEqual(
          (yield* events).map((event) => event.type),
          ["video-thread.registered", "capture.saved", "result.saved"],
        );
      }),
    ),
  );
});
