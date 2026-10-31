import { checkScript } from "@earlyscript/editorial-script";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EDITORIAL_VIDEO_RPC_REQUIRED_SCOPES,
  EDITORIAL_VIDEO_WS_METHODS,
  EditorialVideoRpcGroup,
  RpcScopeAuthorization,
  ThreadId,
  type EditorialVideoError,
  type EditorialVideoView,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as EditorialResultsService from "./EditorialResultsService.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { WorkClockService } from "./WorkClockService.ts";
import { SCRIPT, SCRIPT_PATH, VIDEO_THREAD_ID, withVideoWorkspace } from "./videoThread.testkit.ts";
import * as EditorialVideoRpc from "./videoRpc.ts";

const THREAD = ThreadId.make(VIDEO_THREAD_ID);
const MINUTE = 60_000;
const group = EditorialVideoRpcGroup.middleware(RpcScopeAuthorization);

/** A typed in-memory client over the video group, behind the server's scope middleware. */
const clientWith = (scopes: Parameters<typeof RpcAuthorization.layer>[0]) =>
  Effect.gen(function* () {
    const handlers = yield* EditorialVideoRpc.EditorialVideoRpcHandlers;
    return yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(group.toLayer(handlers), RpcAuthorization.layer(scopes))),
    );
  });

const operator = clientWith([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);

/** The body runs with the video handlers over the testkit's registered video thread. */
const withVideoRpc = <A, E, R>(
  body: Parameters<typeof withVideoWorkspace<A, E, R>>[0],
): ReturnType<typeof withVideoWorkspace<A, E, R>> =>
  withVideoWorkspace((workspace) =>
    body(workspace).pipe(Effect.provide(EditorialVideoRpc.layer), Effect.scoped),
  ) as ReturnType<typeof withVideoWorkspace<A, E, R>>;

const reasonOf = (error: EditorialVideoError | { readonly _tag: string }) =>
  "reason" in error ? error.reason : error._tag;

describe("editorial video RPC authorization", () => {
  it("reads with orchestration:read and commands with orchestration:operate", () => {
    for (const method of [EDITORIAL_VIDEO_WS_METHODS.get, EDITORIAL_VIDEO_WS_METHODS.subscribe]) {
      assert.strictEqual(EDITORIAL_VIDEO_RPC_REQUIRED_SCOPES[method], AuthOrchestrationReadScope);
      assert.strictEqual(RpcAuthorization.requiredScopeForRpcMethod(method), "orchestration:read");
    }
    for (const method of [
      EDITORIAL_VIDEO_WS_METHODS.clock,
      EDITORIAL_VIDEO_WS_METHODS.saveScript,
      EDITORIAL_VIDEO_WS_METHODS.decide,
      EDITORIAL_VIDEO_WS_METHODS.saveResult,
    ]) {
      assert.strictEqual(
        RpcAuthorization.requiredScopeForRpcMethod(method),
        AuthOrchestrationOperateScope,
      );
    }
  });

  it.effect("refuses a clock command from a read-only session", () =>
    withVideoRpc(() =>
      Effect.gen(function* () {
        const client = yield* clientWith([AuthOrchestrationReadScope]);
        const view = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
        assert.strictEqual(view.video?.clock.state._tag, "idle");
        const error = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "EnvironmentAuthorizationError");
      }),
    ),
  );
});

describe("editorial video RPC", () => {
  it.effect("answers null for an ordinary thread and the association for a video thread", () =>
    withVideoRpc(({ write }) =>
      Effect.gen(function* () {
        const client = yield* operator;
        const plain = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({
          threadId: ThreadId.make("thread-plain"),
        });
        assert.deepStrictEqual(plain, { threadId: "thread-plain", video: null });

        const before = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
        assert.strictEqual(before.video?.thread.mode, "assisted");
        assert.strictEqual(before.video?.thread.dossierId, "dossier-1");
        // No run directory is mounted here, so no title; the dossier id still links.
        assert.strictEqual(before.video?.thread.trendTitle, null);
        assert.deepStrictEqual(before.video?.script, {
          path: SCRIPT_PATH,
          exists: false,
          head: null,
          versionCount: 0,
        });
        assert.strictEqual(before.video?.decision, null);

        yield* write(SCRIPT_PATH, SCRIPT);
        const after = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
        assert.strictEqual(after.video?.script.exists, true);

        const missing = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({
          threadId: ThreadId.make("thread-plain"),
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(missing), "not-found");
      }),
    ),
  );

  it.effect("runs the clock: start, pause with a reason, resume, read to write on save", () =>
    withVideoRpc(({ write }) =>
      Effect.gen(function* () {
        const client = yield* operator;
        const clock = (
          command: Parameters<(typeof client)["editorial.video.clock"]>[0]["command"],
        ) => client[EDITORIAL_VIDEO_WS_METHODS.clock]({ threadId: THREAD, command });

        const started = yield* clock({ _tag: "start", stage: "read" });
        assert.deepStrictEqual(started.clock.state, {
          _tag: "running",
          stage: "read",
          since: started.clock.asOf,
        });
        yield* TestClock.adjust(4 * MINUTE);
        const paused = yield* clock({ _tag: "pause", reason: "phone call" });
        assert.strictEqual(paused.clock.state._tag, "paused");
        assert.strictEqual(paused.clock.activeMs, 4 * MINUTE);
        yield* TestClock.adjust(10 * MINUTE);
        const again = yield* clock({ _tag: "pause" }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(again), "clock-state");
        const resumed = yield* clock({ _tag: "resume" });
        assert.strictEqual(resumed.clock.state._tag, "running");
        assert.strictEqual(resumed.clock.pausedMs, 10 * MINUTE);
        yield* TestClock.adjust(MINUTE);

        yield* write(SCRIPT_PATH, SCRIPT);
        const saved = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        assert.deepStrictEqual(
          saved.clock.state._tag === "running" ? saved.clock.state.stage : saved.clock.state._tag,
          "write",
        );
        assert.deepStrictEqual(
          saved.clock.stages.map(({ stage, activeMs }) => [stage, activeMs]),
          [
            ["read", 5 * MINUTE],
            ["write", 0],
          ],
        );
        const counts = checkScript(SCRIPT).counts;
        assert.strictEqual(saved.script.versionCount, 1);
        assert.strictEqual(saved.script.head?.claims, counts.claims);
        assert.strictEqual(saved.script.head?.cited, counts.cited);

        // A later save while writing keeps the stage; the stage control moves it by hand.
        yield* write(SCRIPT_PATH, `${SCRIPT}\nOne more line [hn:1].\n`);
        const second = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        assert.strictEqual(second.script.versionCount, 2);
        const deciding = yield* clock({ _tag: "stage", stage: "decide" });
        assert.deepStrictEqual(
          deciding.clock.stages.map(({ stage }) => stage),
          ["read", "write", "decide"],
        );
      }),
    ),
  );

  it.effect("refuses a decision on a stale version, then records it on the new one", () =>
    withVideoRpc(({ write }) =>
      Effect.gen(function* () {
        const client = yield* operator;
        yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        });
        yield* write(SCRIPT_PATH, SCRIPT);
        const first = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        const read = first.script.head?.contentHash ?? null;
        yield* TestClock.adjust(3 * MINUTE);

        // The agent edits the file after the operator read version 1.
        yield* write(SCRIPT_PATH, `${SCRIPT}\nAn agent edit.\n`);
        const stale = yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "accept",
          utility: 4,
          scriptVersionHash: read,
          operationId: "decision-1",
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(stale), "version-changed");

        const current = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
        const head = current.video?.script.head?.contentHash ?? null;
        assert.notStrictEqual(head, read);
        assert.strictEqual(current.video?.decision, null);
        assert.strictEqual(current.video?.clock.state._tag, "running");

        const decided = yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "edit",
          utility: 4,
          reason: "Needs a critical voice",
          scriptVersionHash: head,
          operationId: "decision-2",
        });
        assert.strictEqual(decided.decision?.scriptVersionHash, head);
        assert.strictEqual(decided.decision?.utility, 4);
        assert.strictEqual(decided.decision?.durations.writeMs, 3 * MINUTE);
        assert.strictEqual(decided.decision?.clockDefinitive, true);
        assert.strictEqual(decided.clock.state._tag, "idle");

        // The clock is final once decided.
        const restart = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "write" },
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(restart), "decided");

        // Results reads the decision this thread wrote.
        const results = yield* EditorialResultsService.EditorialResultsService.use(
          (service) => service.summary,
        ).pipe(Effect.provide(EditorialResultsService.layer));
        assert.strictEqual(results.decisionCount, 1);
      }),
    ),
  );

  it.effect("saves a video result only on a decided thread", () =>
    withVideoRpc(({ write }) =>
      Effect.gen(function* () {
        const client = yield* operator;
        const result = {
          threadId: THREAD,
          views: 1200,
          clicks: 40,
          observedAt: "2026-11-02T12:00:00.000Z",
        };
        const early = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveResult](result).pipe(
          Effect.flip,
        );
        assert.strictEqual(reasonOf(early), "not-decided");

        yield* write(SCRIPT_PATH, SCRIPT);
        const saved = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "accept",
          utility: 5,
          scriptVersionHash: saved.script.head?.contentHash ?? null,
          operationId: "decision-1",
        });
        const recorded = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveResult](result);
        assert.strictEqual(recorded.results.length, 1);
        assert.strictEqual(recorded.results[0]?.views, 1200);
        assert.strictEqual(recorded.results[0]?.subscribers, null);
      }),
    ),
  );

  it.effect("asks the operator to resolve a segment left open by a crash", () =>
    withVideoRpc(() =>
      Effect.gen(function* () {
        const client = yield* operator;
        const started = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        });
        yield* TestClock.adjust(20 * MINUTE);
        // What the storage layer does at startup.
        yield* WorkClockService.use((clock) => clock.recoverOpenIntervals());

        const recovered = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
        const unresolved = recovered.video?.clock.unresolved ?? [];
        assert.strictEqual(unresolved.length, 1);
        assert.strictEqual(recovered.video?.clock.definitive, false);
        assert.strictEqual(recovered.video?.clock.state._tag, "idle");

        const foreign = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "resolve", intervalId: "other", endedAt: started.clock.asOf },
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(foreign), "not-found");

        // Five minutes after the start, before the recovery twenty minutes in.
        const endedAt = "1970-01-01T00:05:00.000Z";
        assert.strictEqual(started.clock.asOf, "1970-01-01T00:00:00.000Z");
        const resolved = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "resolve", intervalId: unresolved[0]!.intervalId, endedAt },
        });
        assert.strictEqual(resolved.clock.definitive, true);
        assert.strictEqual(resolved.clock.activeMs, 5 * MINUTE);
      }),
    ),
  );

  it.effect("streams the view, then a new one after each command on the thread", () =>
    withVideoRpc(() =>
      Effect.gen(function* () {
        const client = yield* operator;
        const views = yield* Queue.unbounded<EditorialVideoView>();
        const fiber = yield* client[EDITORIAL_VIDEO_WS_METHODS.subscribe]({
          threadId: THREAD,
        }).pipe(
          Stream.runForEach((view) => Queue.offer(views, view)),
          Effect.forkScoped,
        );
        const first = yield* Queue.take(views);
        assert.strictEqual(first.video?.clock.state._tag, "idle");

        yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        });
        const next = yield* Queue.take(views);
        assert.strictEqual(next.video?.clock.state._tag, "running");

        // Events of another aggregate do not wake this stream.
        const log = yield* EditorialEventLog;
        assert.isAbove(yield* log.latestSeq, 0);
        assert.strictEqual(yield* Queue.size(views), 0);
        yield* Fiber.interrupt(fiber);
      }),
    ),
  );
});
