// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `remoteAccess` web hooks. The setup file turns every flag on for upstream
// suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";

import { ConnectionsSettings as UpstreamConnectionsSettings } from "../components/settings/ConnectionsSettings";
import {
  filterAvailableSettingsSearchItems,
  SETTINGS_NAV_GROUPS,
} from "../components/settings/settingsSearch";
import { ConnectionsSettings, ConnectionsSettingsDisabled } from "./remoteAccess";

// The real page pulls in desktop and cloud modules that do not load under Node.
vi.mock("../components/settings/ConnectionsSettings", () => ({
  ConnectionsSettings: function UpstreamConnectionsSettings() {
    return null;
  },
}));

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const readUpstream = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");

const HIDDEN_PATHS = ["/settings/connections", "/settings/access"];

describe("Earlyscript remote access with the remoteAccess flag at its default", () => {
  it("sends Settings > Connections and Settings > Access to General", () => {
    expect(ConnectionsSettings).toBe(ConnectionsSettingsDisabled);
    expect(ConnectionsSettings).not.toBe(UpstreamConnectionsSettings);
    for (const route of ["_chat.settings.connections.tsx", "_chat.settings.access.tsx"]) {
      const source = readUpstream(`../routes/${route}`);
      expect(source).toContain(
        'import { ConnectionsSettings } from "../earlyscript/remoteAccess";',
      );
      expect(source).not.toContain("components/settings/ConnectionsSettings");
    }
  });

  it("leaves both pages out of the settings sidebar and settings search", () => {
    const navPaths: ReadonlyArray<string> = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);
    expect(navPaths).toContain("/settings/general");
    for (const path of HIDDEN_PATHS) expect(navPaths).not.toContain(path);

    const items = filterAvailableSettingsSearchItems({
      hasCloudPublicConfig: true,
      hasEnvironment: true,
      hasProviderSettingsEnvironment: true,
      hasMacProviderSettingsEnvironment: true,
      canManageLocalBackend: true,
      localEnvironmentDisabled: false,
      isWslSettingsRowVisible: true,
      hasThreadAutoSettlement: true,
      managedTunnelActive: true,
      hasPeerLinkHost: true,
    });
    expect(items.some((item) => item.to === "/settings/general")).toBe(true);
    for (const path of HIDDEN_PATHS) expect(items.some((item) => item.to === path)).toBe(false);
    expect(items.some((item) => item.id === "linked-environments-beta")).toBe(false);
  });

  it("drops the Linked environments row from Labs", () => {
    const labs = readUpstream("../components/settings/LabsSettingsPanel.tsx");
    expect(labs).toContain("{earlyscriptFlags.remoteAccess && <LinkedEnvironmentsRow />}");
  });
});
