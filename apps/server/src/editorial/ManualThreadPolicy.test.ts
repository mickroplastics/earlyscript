import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { ManualThreadPolicy, threadsWithAgentWork } from "./ManualThreadPolicy.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";

const register = (threadId: string, mode: "manual" | "assisted") =>
  EditorialThreadService.use((threads) =>
    threads.registerVideoThread({
      operationId: `op:${threadId}`,
      environmentId: "env-1",
      threadId,
      mode,
    }),
  );

describe("ManualThreadPolicy", () => {
  it.effect("blocks agents in manual video threads only", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const policy = yield* ManualThreadPolicy;
        yield* register("thread-manual", "manual");
        yield* register("thread-assisted", "assisted");

        const blocked = yield* Effect.flip(policy.assertAgentAllowed("thread-manual"));
        assert.strictEqual(blocked._tag, "ManualThreadAgentBlockedError");
        assert.strictEqual(blocked.reason, "manual-thread");
        yield* policy.assertAgentAllowed("thread-assisted");
        // Upstream threads, never registered, are not affected.
        yield* policy.assertAgentAllowed("thread-upstream");
      }),
    ),
  );

  it.effect("asks again about an unregistered thread after a short while", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const policy = yield* ManualThreadPolicy;
        yield* policy.assertAgentAllowed("thread-late");
        yield* register("thread-late", "manual");
        // Cached as unregistered for two seconds.
        yield* policy.assertAgentAllowed("thread-late");
        yield* TestClock.adjust(Duration.seconds(3));
        const blocked = yield* Effect.flip(policy.assertAgentAllowed("thread-late"));
        assert.strictEqual(blocked.reason, "manual-thread");
      }),
    ),
  );

  it.effect("blocks unknown threads while the editorial database cannot be read", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const policy = yield* ManualThreadPolicy;
        const sql = yield* EditorialSql;
        yield* register("thread-assisted", "assisted");
        yield* policy.assertAgentAllowed("thread-assisted");

        yield* sql`ALTER TABLE editorial_video_threads RENAME TO editorial_video_threads_away`;
        const blocked = yield* Effect.flip(policy.assertAgentAllowed("thread-upstream"));
        assert.strictEqual(blocked.reason, "policy-unavailable");
        // A mode already read stays known.
        yield* policy.assertAgentAllowed("thread-assisted");

        yield* sql`ALTER TABLE editorial_video_threads_away RENAME TO editorial_video_threads`;
        yield* policy.assertAgentAllowed("thread-upstream");
      }),
    ),
  );

  it("finds agent work in a command plan", () => {
    assert.deepStrictEqual(
      threadsWithAgentWork({
        events: [
          { type: "thread.created", threadId: "a" },
          { type: "run.created", threadId: "b" },
          { type: "run.created", threadId: "b" },
        ],
        effects: [
          { threadId: "c", request: { type: "provider-turn.start" } },
          { threadId: "d", request: { type: "thread-title.generate" } },
          { threadId: "e", request: { type: "provider-runtime.continue" } },
        ],
      }),
      ["b", "c", "e"],
    );
  });
});
