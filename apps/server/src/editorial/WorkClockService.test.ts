// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";

import { EditorialThreadService } from "./EditorialThreadService.ts";
import { WorkClockService } from "./WorkClockService.ts";
import { EditorialSql, EDITORIAL_DATABASE_FILENAME } from "./persistence/EditorialDatabase.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import {
  layerAt,
  makeTempDir,
  removeDir,
  withEditorialDatabase,
} from "./persistence/EditorialDatabase.testkit.ts";

const THREAD = "thread-clock";

const registerThread = Effect.gen(function* () {
  const threads = yield* EditorialThreadService;
  yield* threads.registerVideoThread({
    operationId: "op-register",
    environmentId: "env-1",
    threadId: THREAD,
    mode: "manual",
  });
});

const advance = (minutes: number) => TestClock.adjust(Duration.minutes(minutes));

const eventTypes = Effect.gen(function* () {
  const log = yield* EditorialEventLog;
  return (yield* log.readSince(0)).map((event) => event.type);
});

const stageMs = (
  summary: {
    readonly stages: ReadonlyArray<{ readonly stage: string; readonly activeMs: number }>;
  },
  stage: string,
) => summary.stages.find((entry) => entry.stage === stage)?.activeMs;

describe("WorkClockService", () => {
  it.effect("excludes pauses and splits time by stage", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* registerThread;

        yield* clock.start(THREAD, "explore");
        yield* advance(10);
        const paused = yield* clock.pause(THREAD, { reason: "coffee" });
        assert.strictEqual(paused.state._tag, "paused");
        yield* advance(5);
        yield* clock.resume(THREAD);
        yield* advance(3);
        const changed = yield* clock.changeStage(THREAD, "write");
        assert.deepInclude(changed.state, { _tag: "running", stage: "write" });
        yield* advance(20);
        const stopped = yield* clock.stop(THREAD);

        assert.strictEqual(stopped.state._tag, "idle");
        assert.strictEqual(stageMs(stopped, "explore"), Duration.toMillis(Duration.minutes(13)));
        assert.strictEqual(stageMs(stopped, "write"), Duration.toMillis(Duration.minutes(20)));
        assert.strictEqual(stopped.activeMs, Duration.toMillis(Duration.minutes(33)));
        assert.strictEqual(stopped.pausedMs, Duration.toMillis(Duration.minutes(5)));
        assert.isTrue(stopped.definitive);
        assert.deepStrictEqual(yield* eventTypes, [
          "video-thread.registered",
          "work.started",
          "work.paused",
          "work.resumed",
          "work.stage-changed",
          "work.stopped",
        ]);

        // Stopping an idle clock is a no-op and records nothing.
        yield* clock.stop(THREAD);
        assert.lengthOf(yield* eventTypes, 6);
      }),
    ),
  );

  it.effect("rejects a second start while a stage is open or paused", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* registerThread;
        yield* clock.start(THREAD, "explore");

        const twice = yield* Effect.flip(clock.start(THREAD, "explore"));
        assert.strictEqual(twice._tag, "WorkClockStateError");
        assert.strictEqual(twice._tag === "WorkClockStateError" && twice.reason, "already-running");
        const other = yield* Effect.flip(clock.start(THREAD, "write"));
        assert.strictEqual(other._tag === "WorkClockStateError" && other.reason, "already-running");
        const same = yield* Effect.flip(clock.changeStage(THREAD, "explore"));
        assert.strictEqual(same._tag === "WorkClockStateError" && same.reason, "same-stage");

        yield* clock.pause(THREAD);
        const whilePaused = yield* Effect.flip(clock.start(THREAD, "explore"));
        assert.strictEqual(
          whilePaused._tag === "WorkClockStateError" && whilePaused.reason,
          "paused",
        );
        const pausedTwice = yield* Effect.flip(clock.pause(THREAD));
        assert.strictEqual(
          pausedTwice._tag === "WorkClockStateError" && pausedTwice.reason,
          "not-running",
        );

        // The partial unique index enforces one open segment even past the service.
        const sql = yield* EditorialSql;
        yield* clock.resume(THREAD);
        const raw = yield* Effect.exit(sql`
          INSERT INTO editorial_work_intervals (
            interval_id, thread_id, stage, status, started_at, actor
          ) VALUES ('rogue', ${THREAD}, 'explore', 'open', '2026-10-30T00:00:00.000Z', 'operator')
        `);
        assert.isTrue(Exit.isFailure(raw));
      }),
    ),
  );

  it.effect("changes stage from a pause without counting the pause", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* registerThread;
        yield* clock.start(THREAD, "explore");
        yield* advance(4);
        yield* clock.pause(THREAD);
        yield* advance(30);
        yield* clock.changeStage(THREAD, "write");
        yield* advance(6);
        const summary = yield* clock.summary(THREAD);

        assert.deepInclude(summary.state, { _tag: "running", stage: "write" });
        assert.strictEqual(stageMs(summary, "explore"), Duration.toMillis(Duration.minutes(4)));
        assert.strictEqual(stageMs(summary, "write"), Duration.toMillis(Duration.minutes(6)));
        assert.strictEqual(summary.pausedMs, Duration.toMillis(Duration.minutes(30)));
      }),
    ),
  );

  it.effect("keeps the pause length when stopping while paused, across a reopen", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, EDITORIAL_DATABASE_FILENAME);
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* registerThread;
        yield* clock.start(THREAD, "explore");
        yield* TestClock.adjust(Duration.seconds(1));
        yield* clock.pause(THREAD);
        yield* TestClock.adjust(Duration.seconds(5));
        const stopped = yield* clock.stop(THREAD);
        assert.strictEqual(stopped.state._tag, "idle");
        assert.strictEqual(stopped.activeMs, 1000);
        assert.strictEqual(stopped.pausedMs, 5000);
      }).pipe(Effect.provide(layerAt(dbPath)));

      yield* advance(30);

      yield* Effect.gen(function* () {
        const clock = yield* WorkClockService;
        const summary = yield* clock.summary(THREAD);
        assert.strictEqual(summary.state._tag, "idle");
        assert.strictEqual(summary.activeMs, 1000);
        assert.strictEqual(summary.pausedMs, 5000);
        assert.isTrue(summary.definitive);
      }).pipe(Effect.provide(layerAt(dbPath)));
    }).pipe(Effect.ensuring(removeDir(dir)));
  });

  it.effect("replays a command with the same operation id", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* registerThread;
        yield* clock.start(THREAD, "read", { operationId: "op-start" });
        const replay = yield* clock.start(THREAD, "read", { operationId: "op-start" });
        assert.deepInclude(replay.state, { _tag: "running", stage: "read" });
        assert.deepStrictEqual(yield* eventTypes, ["video-thread.registered", "work.started"]);

        const reused = yield* Effect.flip(clock.pause(THREAD, { operationId: "op-start" }));
        assert.strictEqual(reused._tag, "EditorialConflictError");
        assert.lengthOf(yield* eventTypes, 2);
      }),
    ),
  );

  it.effect("fails for a thread that is not registered", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        const error = yield* Effect.flip(clock.start("missing", "explore"));
        assert.strictEqual(error._tag, "EditorialNotFoundError");
      }),
    ),
  );

  it.effect("flags segments left open by a crash and lets the operator resolve them", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, EDITORIAL_DATABASE_FILENAME);
    return Effect.gen(function* () {
      // First process: work starts and the process dies with the segment open.
      yield* Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* registerThread;
        yield* clock.start(THREAD, "write");
      }).pipe(Effect.provide(layerAt(dbPath)));

      yield* advance(45);

      // Second process: the layer recovers at startup.
      yield* Effect.gen(function* () {
        const clock = yield* WorkClockService;
        const summary = yield* clock.summary(THREAD);
        assert.strictEqual(summary.state._tag, "idle");
        assert.isFalse(summary.definitive);
        assert.lengthOf(summary.unresolved, 1);
        assert.strictEqual(summary.activeMs, 0);
        const unresolved = summary.unresolved[0]!;
        assert.strictEqual(unresolved.stage, "write");

        // Nothing is open after recovery, so a second pass finds nothing.
        assert.deepStrictEqual(yield* clock.recoverOpenIntervals(), []);

        const late = yield* Effect.flip(
          clock.resolveInterval({
            intervalId: unresolved.intervalId,
            endedAt: "2099-01-01T00:00:00Z",
          }),
        );
        assert.strictEqual(late._tag, "EditorialInvalidInputError");

        const resolved = yield* clock.resolveInterval({
          intervalId: unresolved.intervalId,
          endedAt: DateTime.formatIso(DateTime.makeUnsafe(Duration.toMillis(Duration.minutes(25)))),
        });
        assert.isTrue(resolved.definitive);
        assert.strictEqual(stageMs(resolved, "write"), Duration.toMillis(Duration.minutes(25)));

        const again = yield* Effect.flip(
          clock.resolveInterval({
            intervalId: unresolved.intervalId,
            endedAt: unresolved.startedAt,
          }),
        );
        assert.strictEqual(again._tag === "WorkClockStateError" && again.reason, "not-unresolved");
        assert.includeMembers(yield* eventTypes, ["work.recovery-needed", "work.resolved"]);
      }).pipe(Effect.provide(layerAt(dbPath)));
    }).pipe(Effect.ensuring(removeDir(dir)));
  });

  it.effect("moves automatically only from the named stage and only the first time", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* registerThread;
        const auto = { onlyFrom: "read", onlyFirst: true, cause: "agent-request" } as const;

        yield* clock.start(THREAD, "read");
        yield* advance(4);
        const first = yield* clock.changeStage(THREAD, "write", auto);
        assert.deepInclude(first.state, { _tag: "running", stage: "write" });
        yield* advance(6);
        // The operator goes back to Leer by hand: a later automatic change leaves it there.
        yield* clock.changeStage(THREAD, "read");
        yield* advance(2);
        const kept = yield* clock.changeStage(THREAD, "write", auto);
        assert.deepInclude(kept.state, { _tag: "running", stage: "read" });
        assert.strictEqual(stageMs(kept, "read"), Duration.toMillis(Duration.minutes(6)));
        assert.strictEqual(stageMs(kept, "write"), Duration.toMillis(Duration.minutes(6)));

        const log = yield* EditorialEventLog;
        const changes = (yield* log.readSince(0)).filter(
          (event) => event.type === "work.stage-changed",
        );
        assert.strictEqual(changes.length, 2);
        assert.deepInclude(changes[0]!.payload as object, { to: "write", cause: "agent-request" });
        assert.notProperty(changes[1]!.payload as object, "cause");
      }),
    ),
  );
});
