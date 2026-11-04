import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { isOperatorRun, onRunCreated } from "./AssistedWritingStart.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";
import { WorkClockService } from "./WorkClockService.ts";

const register = (threadId: string, mode: "assisted" | "manual") =>
  Effect.gen(function* () {
    const threads = yield* EditorialThreadService;
    yield* threads.registerVideoThread({
      operationId: `op-${threadId}`,
      environmentId: "env-1",
      threadId,
      mode,
    });
  });

const stageOf = (threadId: string) =>
  Effect.gen(function* () {
    const summary = yield* (yield* WorkClockService).summary(threadId);
    return summary.state._tag === "idle" ? "idle" : summary.state.stage;
  });

describe("AssistedWritingStart", () => {
  it("counts only the runs of a message the operator sent", () => {
    assert.isTrue(isOperatorRun({ threadId: "t" }));
    assert.isFalse(isOperatorRun({ threadId: "t", restartContinuationOfRunId: "run-1" }));
    assert.isFalse(isOperatorRun({ threadId: "t", delegatedTaskId: "node-1" }));
  });

  it.effect("moves an assisted thread from Leer to Escribir at the first request", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* register("assisted", "assisted");
        yield* clock.start("assisted", "read");
        yield* TestClock.adjust(Duration.minutes(3));

        yield* onRunCreated("assisted");
        assert.strictEqual(yield* stageOf("assisted"), "write");
        // A second request changes nothing.
        yield* onRunCreated("assisted");
        assert.strictEqual(yield* stageOf("assisted"), "write");
      }),
    ),
  );

  it.effect("leaves manual threads, other stages and decided threads alone", () =>
    withEditorialDatabase(
      Effect.gen(function* () {
        const clock = yield* WorkClockService;
        yield* register("manual", "manual");
        yield* clock.start("manual", "explore");
        yield* onRunCreated("manual");
        assert.strictEqual(yield* stageOf("manual"), "explore");

        // The operator already moved to Decidir by hand.
        yield* register("deciding", "assisted");
        yield* clock.start("deciding", "read");
        yield* clock.changeStage("deciding", "decide");
        yield* onRunCreated("deciding");
        assert.strictEqual(yield* stageOf("deciding"), "decide");

        // An ordinary T3 thread has no editorial row.
        yield* onRunCreated("not-a-video-thread");
      }),
    ),
  );
});
