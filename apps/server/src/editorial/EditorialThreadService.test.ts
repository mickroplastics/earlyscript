import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { EditorialCommandService } from "./EditorialCommandService.ts";
import { defaultScriptPath, EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";
import { WorkClockService } from "./WorkClockService.ts";

const projectId = ProjectId.make("project:studio");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" } as const;

/** Records each launch input; fails while `failing` is set. */
const makeLaunchDouble = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<ThreadLaunch.ThreadLaunchInput>>([]);
  const failing = yield* Ref.make(false);
  const layer = Layer.mock(ThreadLaunch.ThreadLaunchService)({
    launch: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (current) => [...current, input]);
        if (yield* Ref.get(failing)) {
          return yield* new ThreadLaunch.ThreadLaunchError({
            operation: "create-thread",
            commandId: input.commandId,
            projectId: input.projectId,
            cause: "launch double set to fail",
          });
        }
        return {
          threadId: input.threadId as ThreadId,
          projection: {} as ThreadLaunch.ThreadLaunchResult["projection"],
          resumed: false,
        };
      }),
  });
  return { calls, failing, layer };
});

describe("EditorialThreadService", () => {
  it.effect("registers a video thread once per operation id", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const threads = yield* EditorialThreadService;
        const log = yield* EditorialEventLog;

        const first = yield* threads.registerVideoThread({
          operationId: "op-1",
          environmentId: "env-1",
          threadId: "thread-1",
          mode: "assisted",
          trendKey: "trend:a",
          runId: "run-1",
          dossierId: "dossier-1",
          dossierHash: "sha256:abc",
          scriptPath: "videos/a.md",
        });
        assert.isTrue(first.created);
        assert.strictEqual(first.thread.launchState, "pending");

        // A UI retry proposes a fresh ThreadId; the persisted one wins.
        const retry = yield* threads.registerVideoThread({
          operationId: "op-1",
          environmentId: "env-1",
          threadId: "thread-1-retry",
          mode: "assisted",
        });
        assert.isFalse(retry.created);
        assert.deepStrictEqual(retry.thread, first.thread);
        assert.isTrue(Option.isNone(yield* threads.getVideoThread("thread-1-retry")));

        const conflict = yield* Effect.flip(
          threads.registerVideoThread({
            operationId: "op-2",
            environmentId: "env-1",
            threadId: "thread-1",
            mode: "manual",
          }),
        );
        assert.strictEqual(conflict._tag, "EditorialConflictError");

        const stored = yield* threads.getVideoThread("thread-1");
        assert.deepStrictEqual(stored, Option.some(first.thread));
        assert.deepStrictEqual(
          (yield* log.readSince(0)).map((event) => [event.type, event.operationId]),
          [["video-thread.registered", "op-1"]],
        );
      }),
    ),
  );

  it.effect("rejects an empty operation id", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const threads = yield* EditorialThreadService;
        const error = yield* Effect.flip(
          threads.registerVideoThread({
            operationId: " ",
            environmentId: "env-1",
            threadId: "thread-1",
            mode: "manual",
          }),
        );
        assert.strictEqual(error._tag, "EditorialInvalidInputError");
      }),
    ),
  );
});

describe("EditorialThreadService.createVideo", () => {
  it.effect("launches an assisted thread once, without a first message, and starts Leer", () =>
    Effect.gen(function* () {
      const launch = yield* makeLaunchDouble;
      yield* withEditorialDatabase(
        Effect.gen(function* () {
          const threads = yield* EditorialThreadService;
          const commands = yield* EditorialCommandService;
          const input = {
            operationId: "op-create",
            projectId,
            mode: "assisted" as const,
            title: "Computación cuántica: IBM abre su hoja de ruta",
            modelSelection,
            trendKey: "trend:quantum",
            runId: "run-1",
            dossierId: "dossier-1",
            dossierHash: "sha256:abc",
          };
          const created = yield* threads.createVideo(input);
          assert.isTrue(created.created);
          assert.strictEqual(created.thread.launchState, "launched");
          assert.strictEqual(created.thread.environmentId, "environment:editorial-test");
          assert.strictEqual(
            created.thread.scriptPath,
            defaultScriptPath(input.title, created.thread.threadId),
          );
          assert.match(
            created.thread.scriptPath ?? "",
            /^videos\/computacion-cuantica-ibm-abre-su-hoja-de-ruta-[a-z0-9]{8}\.md$/,
          );
          assert.deepStrictEqual(
            created.clock.state._tag === "running" && created.clock.state.stage,
            "read",
          );

          const [call] = yield* Ref.get(launch.calls);
          assert.strictEqual(call?.threadId, created.thread.threadId);
          assert.strictEqual(call?.title, `Video: ${input.title}`);
          assert.strictEqual(call?.commandId, "editorial:create-video:op-create");
          assert.isUndefined(call?.initialMessage);
          assert.deepStrictEqual(call?.workspaceStrategy, { type: "root" });
          assert.strictEqual(call?.createdBy, "user");

          const [inbox] = yield* commands.getInboxState(["trend:quantum"]);
          assert.strictEqual(inbox?.productionThreadId, created.thread.threadId);

          // A UI retry replays: no second launch, no second clock segment.
          const retried = yield* threads.createVideo(input);
          assert.isFalse(retried.created);
          assert.strictEqual(retried.thread.threadId, created.thread.threadId);
          assert.strictEqual((yield* Ref.get(launch.calls)).length, 1);
          assert.strictEqual(retried.clock.stages.length, 1);

          const conflict = yield* Effect.flip(threads.createVideo({ ...input, mode: "manual" }));
          assert.strictEqual(conflict._tag, "EditorialConflictError");
        }),
        { launch: launch.layer },
      );
    }),
  );

  it.effect("marks a failed launch and launches the same thread again on retry", () =>
    Effect.gen(function* () {
      const launch = yield* makeLaunchDouble;
      yield* Ref.set(launch.failing, true);
      yield* withEditorialDatabase(
        Effect.gen(function* () {
          const threads = yield* EditorialThreadService;
          const clock = yield* WorkClockService;
          const log = yield* EditorialEventLog;
          const input = {
            operationId: "op-manual",
            projectId,
            mode: "manual" as const,
            title: "Manual",
            modelSelection,
          };

          const failed = yield* Effect.flip(threads.createVideo(input));
          assert.strictEqual(failed._tag, "EditorialVideoLaunchError");
          const stored = yield* threads.getVideoThread(
            failed._tag === "EditorialVideoLaunchError" ? failed.threadId : "",
          );
          assert.strictEqual(Option.getOrThrow(stored).launchState, "failed");
          assert.strictEqual(
            (yield* clock.summary(Option.getOrThrow(stored).threadId)).state._tag,
            "idle",
          );

          yield* Ref.set(launch.failing, false);
          const created = yield* threads.createVideo(input);
          assert.strictEqual(created.thread.threadId, Option.getOrThrow(stored).threadId);
          assert.strictEqual(created.thread.launchState, "launched");
          assert.deepStrictEqual(
            created.clock.state._tag === "running" && created.clock.state.stage,
            "explore",
          );
          const calls = yield* Ref.get(launch.calls);
          assert.deepStrictEqual(
            calls.map((call) => [String(call.threadId), String(call.commandId)]),
            [
              [created.thread.threadId, "editorial:create-video:op-manual"],
              [created.thread.threadId, "editorial:create-video:op-manual"],
            ],
          );
          assert.deepStrictEqual(
            (yield* log.readSince(0)).map((event) => event.type),
            [
              "video-thread.registered",
              "video-thread.launch-failed",
              "video-thread.launched",
              "work.started",
            ],
          );
        }),
        { launch: launch.layer },
      );
    }),
  );

  it.effect("requires a title and a complete dossier reference", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const threads = yield* EditorialThreadService;
        const base = { operationId: "op-x", projectId, mode: "assisted" as const, modelSelection };
        assert.strictEqual(
          (yield* Effect.flip(threads.createVideo({ ...base, title: " " })))._tag,
          "EditorialInvalidInputError",
        );
        assert.strictEqual(
          (yield* Effect.flip(threads.createVideo({ ...base, title: "T", dossierId: "d" })))._tag,
          "EditorialInvalidInputError",
        );
      }),
    ),
  );
});
