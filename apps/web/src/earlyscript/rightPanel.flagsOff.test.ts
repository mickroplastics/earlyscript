// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `terminal` and `changeRequests` hooks on the right panel. The setup file
// turns every flag on for upstream suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { pullRequestSurface, useRightPanelStore, type RightPanelSurface } from "../rightPanelStore";
import { rightPanelSurfaceVisible } from "./hiddenFeatures";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const readUpstream = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");

const environmentId = "env-1" as EnvironmentId;
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-A"));
const terminal: RightPanelSurface = {
  id: "terminal:term-1",
  kind: "terminal",
  resourceId: "term-1",
  terminalIds: ["term-1"],
  activeTerminalId: "term-1",
};
const pullRequest = pullRequestSurface({
  projectId: "project-a",
  repository: "owner/repo",
  number: 7,
});
const pullRequests: RightPanelSurface = { id: "pull-requests", kind: "pull-requests" };
const diff: RightPanelSurface = { id: "diff", kind: "diff" };

describe("Earlyscript right panel with the terminal and changeRequests flags at their defaults", () => {
  it("does not restore saved terminal and pull request tabs", async () => {
    // Reset first: a state change writes to storage.
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    const { storage, name, version } = useRightPanelStore.persist.getOptions();
    // What an earlier build saved: a terminal open, and pull request tabs next to a diff.
    await storage!.setItem(name!, {
      version: version!,
      state: {
        byThreadKey: {
          [scopedThreadKey(threadRef)]: {
            isOpen: true,
            surfaces: [terminal, pullRequest, pullRequests, diff],
            activeSurfaceId: terminal.id,
          },
        },
        threadPanelVisibilityByThreadKey: {},
      },
    });
    await useRightPanelStore.persist.rehydrate();

    const restored = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];
    expect(restored?.surfaces).toEqual([diff]);
    expect(restored?.activeSurfaceId).toBe(diff.id);
    expect(restored?.isOpen).toBe(true);
  });

  it("closes the panel when only hidden tabs were saved", async () => {
    // Reset first: a state change writes to storage.
    useRightPanelStore.setState(useRightPanelStore.getInitialState());
    const { storage, name, version } = useRightPanelStore.persist.getOptions();
    await storage!.setItem(name!, {
      version: version!,
      state: {
        byThreadKey: {
          [scopedThreadKey(threadRef)]: {
            isOpen: true,
            surfaces: [terminal, pullRequest],
            activeSurfaceId: pullRequest.id,
          },
        },
        threadPanelVisibilityByThreadKey: {},
      },
    });
    await useRightPanelStore.persist.rehydrate();

    const restored = useRightPanelStore.getState().byThreadKey[scopedThreadKey(threadRef)];
    expect(restored).toMatchObject({ isOpen: false, surfaces: [], activeSurfaceId: null });
  });

  it("mounts nothing for a terminal or pull request surface", () => {
    // The renderer returns null for these kinds before its switch (checked below).
    for (const surface of [terminal, pullRequest, pullRequests]) {
      expect(rightPanelSurfaceVisible(surface.kind)).toBe(false);
    }
    for (const kind of ["diff", "preview", "files", "file", "device"] as const) {
      expect(rightPanelSurfaceVisible(kind)).toBe(true);
    }
  });

  it("is what the store and the renderer use", () => {
    expect(readUpstream("../rightPanelStore.ts")).toContain("merge: mergeVisibleRightPanelState,");
    expect(readUpstream("../components/chat/RightPanelSurfaceContent.tsx")).toContain(
      "if (surface === null || !rightPanelSurfaceVisible(surface.kind)) return null;",
    );
  });
});
