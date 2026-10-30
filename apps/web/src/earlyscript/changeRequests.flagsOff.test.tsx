// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `changeRequests` hooks. The setup file turns every flag on for upstream
// suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import type { VcsStatusResult } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import * as UpstreamGitActions from "../components/GitActionsControl.logic";
import { PullRequestsPage as UpstreamPullRequestsPage } from "../components/pullRequest/PullRequestsPage";
import { PullRequestsPage, PullRequestsPageDisabled } from "./changeRequests";
import { buildMenuItems, resolveQuickAction } from "./gitActions";
import {
  visibleCommandPaletteActions,
  visibleKeybindings,
  visibleSurfaceActions,
} from "./hiddenFeatures";

// The real page pulls in a diff Web Worker that does not load under Node.
vi.mock("../components/pullRequest/PullRequestsPage", () => ({
  PullRequestsPage: function UpstreamPullRequestsPage() {
    return null;
  },
}));

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const readUpstream = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

describe("Earlyscript change requests with the changeRequests flag at its default", () => {
  it("sends /pull-requests home instead of mounting the page", () => {
    expect(PullRequestsPage).toBe(PullRequestsPageDisabled);
    expect(PullRequestsPage).not.toBe(UpstreamPullRequestsPage);
    const route = readUpstream("../routes/_chat.pull-requests.tsx");
    expect(route).toContain('import { PullRequestsPage } from "../earlyscript/changeRequests";');
    expect(route).not.toContain("components/pullRequest/PullRequestsPage");
  });

  it("hides the Pull requests entry in the sidebar", () => {
    expect(readUpstream("../state/environments.ts")).toContain(
      "useAtomValue(environmentSummaries.pullRequestsSupportedAtom) && earlyscriptFlags.changeRequests",
    );
  });

  it("drops pull request actions from the command palette", () => {
    const items = [
      { value: "action:pull-requests" },
      { value: "action:link-pull-request" },
      { value: "action:open-thread-pull-requests" },
      { value: "action:usage" },
    ] as const;
    expect(visibleCommandPaletteActions(items).map((item) => item.value)).toEqual(["action:usage"]);
    const palette = readUpstream("../components/CommandPalette.tsx");
    expect(palette).toContain(
      "const visibleActionItems = visibleCommandPaletteActions(actionItems);",
    );
    expect(palette).toContain("buildRootGroups({ actionItems: visibleActionItems,");
    expect(palette).toContain("buildNestedSearchItems(visibleActionItems, deferredQuery)");
  });

  it("drops pull request surfaces and shortcuts", () => {
    const actions = [
      { label: "Diff" },
      { label: "Pull request" },
      { label: "Linked pull requests" },
    ] as const;
    expect(visibleSurfaceActions(actions).map((action) => action.label)).toEqual(["Diff"]);
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+shift+c", command: "pullRequest.copyNumber" },
      { key: "mod+d", command: "diff.toggle" },
    ]);
    expect(visibleKeybindings(keybindings).map((binding) => binding.command)).toEqual([
      "diff.toggle",
    ]);
  });

  it("keeps commit and push in the Git menu but never offers to open a PR", () => {
    const ahead = status({ aheadCount: 2, aheadOfDefaultCount: 2 });
    expect(UpstreamGitActions.buildMenuItems(ahead, false).map((item) => item.id)).toContain("pr");
    expect(buildMenuItems(ahead, false).map((item) => item.id)).toEqual(["commit", "push"]);

    expect(UpstreamGitActions.resolveQuickAction(ahead, false).action).toBe("create_pr");
    expect(resolveQuickAction(ahead, false)).toEqual({
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "push",
    });

    const dirty = status({ hasWorkingTreeChanges: true });
    expect(UpstreamGitActions.resolveQuickAction(dirty, false).action).toBe("commit_push_pr");
    expect(resolveQuickAction(dirty, false)).toMatchObject({
      label: "Commit & push",
      action: "commit_push",
    });

    const synced = status({ aheadOfDefaultCount: 1 });
    expect(UpstreamGitActions.resolveQuickAction(synced, false).action).toBe("create_pr");
    expect(resolveQuickAction(synced, false)).toMatchObject({ kind: "show_hint", disabled: true });

    expect(readUpstream("../components/GitActionsControl.tsx")).toContain(
      '} from "../earlyscript/gitActions";',
    );
  });
});
