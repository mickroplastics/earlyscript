// Earlyscript-only: the `changeRequests` hook. The setup file turns every flag on for upstream
// suites, so this file replaces the flags with their real defaults.
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

describe("buildRuntimeInstructions with the changeRequests flag at its default", () => {
  it("does not ask agents to link or watch pull requests", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    assert.include(instructions, "<runtime_info>");
    assert.notInclude(instructions, "pull_request_linking");
    assert.notInclude(instructions, "link_pull_request");
    assert.notInclude(instructions, "watch_pull_request");
    assert.isTrue(instructions.endsWith("</runtime_info>"));
  });
});
