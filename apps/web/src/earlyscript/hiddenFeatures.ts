// Earlyscript-only: filters that hide upstream web features behind Earlyscript flags. Upstream files
// call these at one-line hook points listed in docs/upstream-divergence.md.
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  earlyscriptFlags,
  type EarlyscriptFlagName,
  type EarlyscriptFlags,
} from "@t3tools/shared/earlyscriptFlags";

const isOn = (flag: EarlyscriptFlagName | undefined, flags: EarlyscriptFlags): boolean =>
  flag === undefined || flags[flag];

const KEYBINDING_COMMAND_PREFIX_FLAGS: ReadonlyArray<readonly [string, EarlyscriptFlagName]> = [
  ["terminal.", "terminal"],
  ["pullRequest.", "changeRequests"],
];

const keybindingCommandFlag = (command: string): EarlyscriptFlagName | undefined =>
  KEYBINDING_COMMAND_PREFIX_FLAGS.find(([prefix]) => command.startsWith(prefix))?.[1];

/** Drops shortcuts whose command belongs to a hidden feature (`terminal.*`, `pullRequest.*`). */
export function visibleKeybindings(
  keybindings: ResolvedKeybindingsConfig,
  flags: EarlyscriptFlags = earlyscriptFlags,
): ResolvedKeybindingsConfig {
  const visible = keybindings.filter((binding) =>
    isOn(keybindingCommandFlag(binding.command), flags),
  );
  return visible.length === keybindings.length ? keybindings : visible;
}

/** Labels of the right panel "Open a surface" actions in `RightPanelTabs.tsx`. */
const SURFACE_ACTION_FLAGS: Readonly<Record<string, EarlyscriptFlagName>> = {
  Terminal: "terminal",
  "Pull request": "changeRequests",
  "Linked pull requests": "changeRequests",
};

/** Removes right panel surface actions of hidden features instead of showing them disabled. */
export function visibleSurfaceActions<const Action extends { readonly label: string }>(
  actions: ReadonlyArray<Action>,
  flags: EarlyscriptFlags = earlyscriptFlags,
): Array<Action> {
  return actions.filter((action) => isOn(SURFACE_ACTION_FLAGS[action.label], flags));
}

/** Command palette actions (by `value`) that exist only for a hidden feature. */
const COMMAND_PALETTE_ACTION_FLAGS: Readonly<Record<string, EarlyscriptFlagName>> = {
  "action:pull-requests": "changeRequests",
  "action:link-pull-request": "changeRequests",
  "action:open-thread-pull-requests": "changeRequests",
};

export function visibleCommandPaletteActions<const Item extends { readonly value: string }>(
  items: ReadonlyArray<Item>,
  flags: EarlyscriptFlags = earlyscriptFlags,
): Array<Item> {
  return items.filter((item) => isOn(COMMAND_PALETTE_ACTION_FLAGS[item.value], flags));
}
