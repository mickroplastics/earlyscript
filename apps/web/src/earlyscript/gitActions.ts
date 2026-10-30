// Earlyscript-only: the `changeRequests` hook on the Git actions menu. GitActionsControl imports its
// logic from here; everything but the two functions below is upstream's, re-exported unchanged.
import { earlyscriptFlags, type EarlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

import * as Upstream from "../components/GitActionsControl.logic";

export * from "../components/GitActionsControl.logic";

/** Without `changeRequests` the menu has no "Create PR" item. */
export function buildMenuItems(
  ...args: Parameters<typeof Upstream.buildMenuItems>
): Upstream.GitActionMenuItem[] {
  return menuItemsFor(Upstream.buildMenuItems(...args));
}

/** Without `changeRequests` the primary button commits and pushes but never opens a PR. */
export function resolveQuickAction(
  ...args: Parameters<typeof Upstream.resolveQuickAction>
): Upstream.GitQuickAction {
  return quickActionFor(Upstream.resolveQuickAction(...args), args[0]);
}

function menuItemsFor(
  items: Upstream.GitActionMenuItem[],
  flags: EarlyscriptFlags = earlyscriptFlags,
): Upstream.GitActionMenuItem[] {
  return flags.changeRequests ? items : items.filter((item) => item.id !== "pr");
}

function quickActionFor(
  action: Upstream.GitQuickAction,
  gitStatus: Parameters<typeof Upstream.resolveQuickAction>[0],
  flags: EarlyscriptFlags = earlyscriptFlags,
): Upstream.GitQuickAction {
  if (flags.changeRequests) return action;
  if (action.action === "commit_push_pr") {
    return { ...action, label: "Commit & push", action: "commit_push" };
  }
  if (action.action !== "create_pr") return action;
  if (gitStatus !== null && (gitStatus.aheadCount > 0 || !gitStatus.hasUpstream)) {
    return { label: "Push", disabled: false, kind: "run_action", action: "push" };
  }
  return {
    label: "Commit",
    disabled: true,
    kind: "show_hint",
    hint: "Branch is up to date. No action needed.",
  };
}
