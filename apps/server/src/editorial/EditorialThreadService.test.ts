import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";

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
