// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `changeRequests` hooks. The setup file turns every flag on for upstream
// suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as EarlyscriptChangeRequests from "./changeRequests.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const source = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");

describe("Earlyscript change requests with the changeRequests flag at its default", () => {
  it.effect("never starts a pull request worker", () =>
    Effect.gen(function* () {
      let started = false;
      yield* EarlyscriptChangeRequests.startPullRequestWorker(
        Effect.sync(() => {
          started = true;
        }),
      );
      expect(started).toBe(false);
    }),
  );

  it("guards the sync reactor, the watch reactor and the one-minute PR sweep", () => {
    const server = source("../server.ts");
    expect(
      server.match(/EarlyscriptChangeRequests\.startPullRequestWorker\(service\.start\(\)\)/g),
    ).toHaveLength(3);
    for (const reactor of ["PullRequestSyncReactor", "PullRequestWatchReactor"]) {
      expect(server).not.toContain(`yield* ${reactor}.${reactor};\n      yield* service.start();`);
    }
    expect(server).not.toContain(
      "ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start()))",
    );
  });

  it("does not advertise the pull request MCP tools", () => {
    const toolkit = Layer.effectDiscard(Effect.void);
    expect(EarlyscriptChangeRequests.pullRequestsToolkit(toolkit)).toBe(Layer.empty);
    const mcp = source("../mcp/McpHttpServer.ts");
    expect(mcp).toContain(
      "EarlyscriptChangeRequests.pullRequestsToolkit(layerPullRequestsToolkit),",
    );
    expect(mcp).not.toMatch(/^ {2}layerPullRequestsToolkit,$/m);
  });
});
