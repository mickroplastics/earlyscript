// Earlyscript-only: the `updateChecks` hook. The setup file turns every flag on for upstream
// suites, so this file replaces the flags with their real defaults.
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";

import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

describe("DesktopUpdates with the updateChecks flag at its default", () => {
  it.effect("never checks the feed and names Earlyscript as the reason", () => {
    // A packaged build with a feed, where upstream would check for updates.
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.equal(state.enabled, false);
        assert.equal(state.status, "disabled");
        assert.equal(
          state.message,
          "Automatic updates are turned off in Earlyscript (updateChecks flag).",
        );
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });
});
