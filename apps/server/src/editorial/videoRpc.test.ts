// @effect-diagnostics nodeBuiltinImport:off - the review tests read the version copy.
import * as NodeFS from "node:fs";

import { checkScript } from "@earlyscript/editorial-script";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EDITORIAL_VIDEO_RPC_REQUIRED_SCOPES,
  EDITORIAL_VIDEO_WS_METHODS,
  EditorialVideoRpcGroup,
  ProjectId,
  ProviderInstanceId,
  RpcScopeAuthorization,
  ThreadId,
  type EditorialVideoError,
  type EditorialVideoView,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
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

/** The handlers, with the Crypto their browser history ids need. */
const videoRpcLayer = EditorialVideoRpc.layer.pipe(Layer.provide(NodeServices.layer));

/** The body runs with the video handlers over the testkit's registered video thread. */
const withVideoRpc = <A, E, R>(
  body: Parameters<typeof withVideoWorkspace<A, E, R>>[0],
): ReturnType<typeof withVideoWorkspace<A, E, R>> =>
  withVideoWorkspace((workspace) =>
    body(workspace).pipe(Effect.provide(videoRpcLayer), Effect.scoped),
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
        // The refusal keeps the snapshot it took: the new version is the head to review.
        assert.strictEqual(current.video?.script.versionCount, 2);

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

describe("editorial video RPC, review of 76967e71c6", () => {
  const handlersWith = (clockLayer?: Layer.Layer<WorkClockService>) =>
    clockLayer === undefined ? videoRpcLayer : videoRpcLayer.pipe(Layer.provide(clockLayer));

  // H2: Sol's reproduction. A start admitted by the RPC before the decision commits must not
  // reopen the clock after it: the guard runs inside the clock's own transaction.
  it.effect("refuses a clock command that reaches the service after the decision", () =>
    withVideoWorkspace(() =>
      Effect.gen(function* () {
        const real = yield* WorkClockService;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const delayed = WorkClockService.of({
          ...real,
          start: (...args) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* real.start(...args);
            }),
        });
        yield* Effect.gen(function* () {
          const handlers = yield* EditorialVideoRpc.EditorialVideoRpcHandlers;
          const racing = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.clock]({
            threadId: THREAD,
            command: { _tag: "start", stage: "read" },
            operationId: "racing-start",
          }).pipe(Effect.flip, Effect.forkScoped);
          yield* Deferred.await(entered);
          const decided = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.decide]({
            threadId: THREAD,
            action: "accept",
            utility: 4,
            scriptVersionHash: null,
            operationId: "decision",
          });
          assert.strictEqual(decided.decision?.clockDefinitive, true);
          yield* Deferred.succeed(release, undefined);
          const refused = yield* Fiber.join(racing);
          assert.strictEqual(reasonOf(refused), "decided");
          const after = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
          assert.strictEqual(after.video?.clock.state._tag, "idle");
        }).pipe(
          Effect.provide(handlersWith(Layer.succeed(WorkClockService, delayed))),
          Effect.scoped,
        );
      }),
    ),
  );

  // H2, the read to write change: a save after the decision snapshots but leaves the clock.
  it.effect("keeps a decided clock stopped when the script is saved again", () =>
    withVideoRpc(({ write }) =>
      Effect.gen(function* () {
        const client = yield* operator;
        yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        });
        yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "reject",
          utility: 2,
          reason: "No angle",
          scriptVersionHash: null,
          operationId: "decision",
        });
        yield* write(SCRIPT_PATH, SCRIPT);
        const saved = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        assert.strictEqual(saved.script.versionCount, 1);
        assert.strictEqual(saved.clock.state._tag, "idle");
      }),
    ),
  );

  // H3: a decision sent from Escribir still records Decidir, with the zero it actually ran,
  // so Results counts the thread as complete.
  it.effect("opens Decidir when the decision is sent from another stage", () =>
    withVideoRpc(({ write }) =>
      Effect.gen(function* () {
        const client = yield* operator;
        yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        });
        yield* TestClock.adjust(MINUTE);
        yield* write(SCRIPT_PATH, SCRIPT);
        const saved = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        yield* TestClock.adjust(2 * MINUTE);
        const decided = yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "accept",
          utility: 4,
          scriptVersionHash: saved.script.head?.contentHash ?? null,
          operationId: "decision",
        });
        assert.deepStrictEqual(decided.decision?.durations, {
          exploreMs: null,
          readMs: MINUTE,
          writeMs: 2 * MINUTE,
          decideMs: 0,
          totalMs: 3 * MINUTE,
        });
        const summary = yield* EditorialResultsService.EditorialResultsService.use(
          (service) => service.summary,
        ).pipe(Effect.provide(EditorialResultsService.layer));
        const assisted = summary.modes.find((mode) => mode.mode === "assisted");
        assert.strictEqual(assisted?.partialCoverage, 0);
        assert.strictEqual(
          summary.comparisons.find((comparison) => comparison.key === "total")?.assisted.n,
          1,
        );
      }),
    ),
  );

  // H4: the decided version opens as a read-only copy outside the workspace.
  it.effect("writes the decided version to a read-only file outside the workspace", () =>
    withVideoWorkspace(({ write, workspace }) =>
      Effect.gen(function* () {
        const handlers = yield* EditorialVideoRpc.EditorialVideoRpcHandlers;
        yield* write(SCRIPT_PATH, SCRIPT);
        const saved = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        const hash = saved.script.head!.contentHash;
        yield* write(SCRIPT_PATH, `${SCRIPT}\nEdited after.\n`);
        const opened = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.openVersion]({
          threadId: THREAD,
          contentHash: hash,
        });
        assert.isTrue(opened.path.endsWith("quantum.md"));
        assert.isFalse(opened.path.startsWith(workspace));
        assert.strictEqual(NodeFS.readFileSync(opened.path, "utf8"), SCRIPT);
        assert.strictEqual(NodeFS.statSync(opened.path).mode & 0o222, 0);
        // Opening it again reuses the copy.
        const again = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.openVersion]({
          threadId: THREAD,
          contentHash: hash,
        });
        assert.strictEqual(again.path, opened.path);
        const unknown = yield* handlers[EDITORIAL_VIDEO_WS_METHODS.openVersion]({
          threadId: THREAD,
          contentHash: "missing",
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(unknown), "not-found");
      }).pipe(
        Effect.provide(
          videoRpcLayer.pipe(
            Layer.provide(
              ServerConfig.ServerConfig.layerTest(process.cwd(), {
                prefix: "editorial-video-version-",
              }).pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
        ),
        Effect.scoped,
      ),
    ),
  );

  // H5 and H6: resolving is idempotent per operation, and a decision waits for it.
  it.effect("asks to resolve before deciding, and replays a repeated resolve", () =>
    withVideoRpc(() =>
      Effect.gen(function* () {
        const client = yield* operator;
        yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        });
        yield* TestClock.adjust(10 * MINUTE);
        yield* WorkClockService.use((clock) => clock.recoverOpenIntervals());
        const pending = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
        const intervalId = pending.video!.clock.unresolved[0]!.intervalId;

        const early = yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "accept",
          utility: 4,
          scriptVersionHash: null,
          operationId: "decision-early",
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(early), "clock-unresolved");
        assert.strictEqual(
          "message" in early ? early.message : "",
          "Resuelve el tramo abierto antes de decidir.",
        );

        const resolve = {
          threadId: THREAD,
          command: {
            _tag: "resolve" as const,
            intervalId,
            endedAt: "1970-01-01T00:05:00.000Z",
          },
          operationId: "resolve-1",
        };
        const first = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock](resolve);
        const repeated = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock](resolve);
        assert.strictEqual(first.clock.activeMs, 5 * MINUTE);
        assert.deepStrictEqual(repeated.clock, first.clock);
        const resolvedEvents = (yield* (yield* EditorialEventLog).readSince(0)).filter(
          (event) => event.type === "work.resolved",
        );
        assert.deepStrictEqual(
          resolvedEvents.map((event) => event.operationId),
          ["resolve-1"],
        );
        // Another operation on a resolved segment is still refused.
        const other = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          ...resolve,
          operationId: "resolve-2",
        }).pipe(Effect.flip);
        assert.strictEqual(reasonOf(other), "clock-state");

        const decided = yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "accept",
          utility: 4,
          scriptVersionHash: null,
          operationId: "decision",
        });
        assert.strictEqual(decided.decision?.clockDefinitive, true);
        assert.strictEqual(decided.decision?.durations.readMs, 5 * MINUTE);
      }),
    ),
  );

  // H3-R, Sol's fifth adversarial test inverted: a clock left idle by a recovery and its
  // resolution still records Decidir, as the zero it ran, so the thread counts as complete.
  it.effect("records Decidir when deciding from a clock a recovery left stopped", () =>
    withVideoRpc(({ write }) =>
      Effect.gen(function* () {
        const client = yield* operator;
        yield* write(SCRIPT_PATH, SCRIPT);
        yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "start", stage: "read" },
        });
        yield* TestClock.adjust(MINUTE);
        const saved = yield* client[EDITORIAL_VIDEO_WS_METHODS.saveScript]({ threadId: THREAD });
        yield* TestClock.adjust(MINUTE);
        yield* WorkClockService.use((clock) => clock.recoverOpenIntervals());
        const pending = yield* client[EDITORIAL_VIDEO_WS_METHODS.get]({ threadId: THREAD });
        const intervalId = pending.video!.clock.unresolved[0]!.intervalId;
        const resolved = yield* client[EDITORIAL_VIDEO_WS_METHODS.clock]({
          threadId: THREAD,
          command: { _tag: "resolve", intervalId, endedAt: "1970-01-01T00:02:00.000Z" },
          operationId: "resolved",
        });
        assert.strictEqual(resolved.clock.state._tag, "idle");

        const decided = yield* client[EDITORIAL_VIDEO_WS_METHODS.decide]({
          threadId: THREAD,
          action: "accept",
          utility: 4,
          scriptVersionHash: saved.script.head?.contentHash ?? null,
          operationId: "decision",
        });
        assert.deepStrictEqual(decided.decision?.durations, {
          exploreMs: null,
          readMs: MINUTE,
          writeMs: MINUTE,
          decideMs: 0,
          totalMs: 2 * MINUTE,
        });
        assert.strictEqual(decided.decision?.clockDefinitive, true);
        assert.strictEqual(decided.clock.state._tag, "idle");
        const summary = yield* EditorialResultsService.EditorialResultsService.use(
          (service) => service.summary,
        ).pipe(Effect.provide(EditorialResultsService.layer));
        assert.strictEqual(
          summary.modes.find((mode) => mode.mode === "assisted")?.partialCoverage,
          0,
        );
        assert.strictEqual(
          summary.comparisons.find((comparison) => comparison.key === "total")?.assisted.n,
          1,
        );
      }),
    ),
  );
});

describe("editorial video RPC, creation errors", () => {
  /** A launcher that fails as upstream's does when the project is gone. */
  const layerProjectGone = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Effect.fail(
        new ThreadLaunch.ThreadLaunchError({
          operation: "resolve-project",
          commandId: input.commandId,
          projectId: input.projectId,
          cause: "Project not found.",
        }),
      ),
  });

  it.effect("keeps a launch failure's Spanish text, not a storage error", () =>
    withVideoWorkspace(
      () =>
        Effect.gen(function* () {
          const client = yield* operator;
          const error = yield* Effect.flip(
            client[EDITORIAL_VIDEO_WS_METHODS.createManual]({
              operationId: "gone",
              projectId: ProjectId.make("project:gone"),
              title: "Manual",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            }),
          );
          assert.strictEqual(reasonOf(error), "launch");
          assert.strictEqual(
            "message" in error ? error.message : undefined,
            "El proyecto del hilo ya no existe en T3.",
          );
        }).pipe(Effect.provide(videoRpcLayer), Effect.scoped),
      { launch: layerProjectGone },
    ),
  );
});
