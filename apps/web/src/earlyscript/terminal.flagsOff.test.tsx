// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `terminal` hooks. The setup file turns every flag on for upstream suites,
// so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ChatTerminalDrawers as UpstreamChatTerminalDrawers } from "../components/chat/ChatTerminalDrawers";
import { PanelLayoutControls } from "../components/chat/PanelLayoutControls";
import { visibleKeybindings, visibleSurfaceActions } from "./hiddenFeatures";
import { ChatTerminalDrawers, NoTerminalDrawers } from "./terminal";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const readUpstream = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");

const panelControlProps = {
  terminalAvailable: true,
  terminalOpen: false,
  terminalShortcutLabel: null,
  threadPanelOpen: false,
  threadPanelPresentation: "inline",
  threadPanelShortcutLabel: null,
  rightPanelAvailable: true,
  rightPanelOpen: false,
  rightPanelShortcutLabel: null,
  onToggleTerminal: () => undefined,
  onToggleThreadPanel: () => undefined,
  onToggleRightPanel: () => undefined,
} as const;

describe("Earlyscript terminal with the terminal flag at its default", () => {
  it("never mounts the chat terminal drawers", () => {
    expect(ChatTerminalDrawers).toBe(NoTerminalDrawers);
    expect(ChatTerminalDrawers).not.toBe(UpstreamChatTerminalDrawers);
    const chatView = readUpstream("../components/ChatView.tsx");
    expect(chatView).toContain('import { ChatTerminalDrawers } from "../earlyscript/terminal";');
    expect(chatView).not.toContain('from "./chat/ChatTerminalDrawers"');
  });

  it("hides the terminal drawer toggle in the chat header", () => {
    const markup = renderToStaticMarkup(<PanelLayoutControls {...panelControlProps} />);
    expect(markup).not.toContain("Toggle terminal drawer");
    expect(markup).toContain("Toggle right panel");
  });

  it("drops terminal shortcuts from the keybindings every surface reads", () => {
    const keybindings = compileResolvedKeybindingsConfig([
      { key: "mod+j", command: "terminal.toggle" },
      { key: "mod+shift+j", command: "terminal.new" },
      { key: "mod+b", command: "sidebar.toggle" },
    ]);
    expect(visibleKeybindings(keybindings).map((binding) => binding.command)).toEqual([
      "sidebar.toggle",
    ]);
    expect(readUpstream("../state/server.ts")).toContain(
      "visibleKeybindings(mergeWithDefaultKeybindings(",
    );
  });

  it("removes the Terminal action from the right panel surface menus", () => {
    const actions = [{ label: "Browser" }, { label: "Terminal" }, { label: "Files" }] as const;
    expect(visibleSurfaceActions(actions).map((action) => action.label)).toEqual([
      "Browser",
      "Files",
    ]);
    const rightPanelTabs = readUpstream("../components/RightPanelTabs.tsx");
    expect(rightPanelTabs).toContain("const actions = visibleSurfaceActions([");
    expect(rightPanelTabs).toContain("const addSurfaceActions = visibleSurfaceActions([");
  });
});
