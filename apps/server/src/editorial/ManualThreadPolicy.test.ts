import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import {
  assertEffectAllowed,
  assertPlanAllowed,
  EFFECT_WORK,
  isManualThreadRefusal,
  ManualThreadPolicy,
  threadsWithAgentWork,
} from "./ManualThreadPolicy.ts";
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

  it.effect("blocks a thread right after it is registered as manual", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const policy = yield* ManualThreadPolicy;
        yield* policy.assertAgentAllowed("thread-late");
        yield* register("thread-late", "manual");
        // No clock adjustment: "not registered" is never cached.
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
          { threadId: "f", request: { type: "runtime-request.respond" } },
          { threadId: "g", request: { type: "provider-turn.interrupt" } },
          { threadId: "h", request: { type: "checkpoint.capture" } },
        ],
      }),
      ["b", "c", "d", "e", "f"],
    );
  });

  it("classifies every effect type", () => {
    assert.deepStrictEqual(
      Object.entries(EFFECT_WORK)
        .filter(([, work]) => work === "agent")
        .map(([type]) => type)
        .toSorted(),
      [
        "provider-runtime.continue",
        "provider-turn.restart",
        "provider-turn.start",
        "provider-turn.steer",
        "runtime-request.respond",
        "thread-title.generate",
      ],
    );
  });

  it.effect("refuses answers and title generation planned for a manual thread only", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const policy = yield* ManualThreadPolicy;
        yield* register("thread-manual", "manual");
        yield* register("thread-assisted", "assisted");
        const plan = (
          threadId: string,
          type: "runtime-request.respond" | "thread-title.generate",
        ) => assertPlanAllowed(policy, { events: [], effects: [{ threadId, request: { type } }] });

        for (const type of ["runtime-request.respond", "thread-title.generate"] as const) {
          const blocked = yield* Effect.flip(plan("thread-manual", type));
          assert.strictEqual(blocked.reason, "manual-thread");
          yield* plan("thread-assisted", type);
        }
        // Stopping and cleaning up a manual thread stays possible.
        yield* assertPlanAllowed(policy, {
          events: [],
          effects: [{ threadId: "thread-manual", request: { type: "provider-turn.interrupt" } }],
        });
      }),
    ),
  );

  it.effect("checks outbox effects before they run, except the turn start", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const policy = yield* ManualThreadPolicy;
        yield* register("thread-manual", "manual");
        const effect = (
          type: "runtime-request.respond" | "provider-turn.start" | "terminal.cleanup",
        ) => assertEffectAllowed(policy, { threadId: "thread-manual", request: { type } });

        const blocked = yield* Effect.flip(effect("runtime-request.respond"));
        assert.isTrue(isManualThreadRefusal(blocked));
        // The provider turn start settles the run itself.
        yield* effect("provider-turn.start");
        yield* effect("terminal.cleanup");
      }),
    ),
  );
});
