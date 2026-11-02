// Earlyscript-only: filters that hide upstream web features behind Earlyscript flags. Upstream files
// call these at one-line hook points listed in docs/upstream-divergence.md.
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  earlyscriptFlags,
  type EarlyscriptFlagName,
  type EarlyscriptFlags,
} from "@t3tools/shared/earlyscriptFlags";

import type { RightPanelKind, ThreadRightPanelState } from "../rightPanelStore";

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

/** Settings pages that exist only for a hidden feature. */
const SETTINGS_PATH_FLAGS: Readonly<Record<string, EarlyscriptFlagName>> = {
  "/settings/connections": "remoteAccess",
  "/settings/access": "remoteAccess",
};

/** Settings rows (searchable ids) that exist only for a hidden feature. */
const SETTINGS_ITEM_FLAGS: Readonly<Record<string, EarlyscriptFlagName>> = {
  "linked-environments-beta": "remoteAccess",
  "guest-links": "relay",
  // Upstream's policy row is replaced by PrivacySettingsRow; Editorial has its own entry.
  "privacy-policy": "marketing",
};

function settingsPathVisible(path: string, flags: EarlyscriptFlags = earlyscriptFlags): boolean {
  return isOn(SETTINGS_PATH_FLAGS[path], flags);
}

export function visibleSettingsNavGroups<Path extends string>(
  groups: ReadonlyArray<{ readonly heading: string | null; readonly paths: ReadonlyArray<Path> }>,
  flags: EarlyscriptFlags = earlyscriptFlags,
): Array<{ readonly heading: string | null; readonly paths: ReadonlyArray<Path> }> {
  return groups
    .map((group) => ({
      ...group,
      paths: group.paths.filter((path) => settingsPathVisible(path, flags)),
    }))
    .filter((group) => group.paths.length > 0);
}

export function settingsSearchItemVisible(
  item: { readonly id: string; readonly to: string },
  flags: EarlyscriptFlags = earlyscriptFlags,
): boolean {
  return settingsPathVisible(item.to, flags) && isOn(SETTINGS_ITEM_FLAGS[item.id], flags);
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

/** Right panel surfaces that exist only for a hidden feature. */
const SURFACE_KIND_FLAGS: Partial<Record<RightPanelKind, EarlyscriptFlagName>> = {
  terminal: "terminal",
  "pull-request": "changeRequests",
  "pull-requests": "changeRequests",
};

/** Whether the right panel may mount a surface of `kind`; hidden kinds render nothing. */
export function rightPanelSurfaceVisible(
  kind: RightPanelKind,
  flags: EarlyscriptFlags = earlyscriptFlags,
): boolean {
  return isOn(SURFACE_KIND_FLAGS[kind], flags);
}

function visibleThreadRightPanelState(
  state: ThreadRightPanelState,
  flags: EarlyscriptFlags,
): ThreadRightPanelState {
  const surfaces = state.surfaces.filter((surface) =>
    rightPanelSurfaceVisible(surface.kind, flags),
  );
  if (surfaces.length === state.surfaces.length) return state;
  const activeSurfaceId = surfaces.some((surface) => surface.id === state.activeSurfaceId)
    ? state.activeSurfaceId
    : (surfaces[0]?.id ?? null);
  return { ...state, surfaces, activeSurfaceId, isOpen: state.isOpen && surfaces.length > 0 };
}

/**
 * The right panel store's `merge` on every rehydration: drops saved terminal and pull request
 * surfaces of hidden features, so a tab saved by an earlier build is never restored.
 */
export function mergeVisibleRightPanelState<
  State extends { readonly byThreadKey: Record<string, ThreadRightPanelState> },
>(persisted: unknown, current: State, flags: EarlyscriptFlags = earlyscriptFlags): State {
  // zustand's default merge.
  const merged = { ...current, ...(persisted as Partial<State> | undefined) };
  if (!merged.byThreadKey || typeof merged.byThreadKey !== "object") return merged;
  return {
    ...merged,
    byThreadKey: Object.fromEntries(
      Object.entries(merged.byThreadKey).map(([threadKey, state]) => [
        threadKey,
        Array.isArray(state?.surfaces) ? visibleThreadRightPanelState(state, flags) : state,
      ]),
    ),
  };
}
