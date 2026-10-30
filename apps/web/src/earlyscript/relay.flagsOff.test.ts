// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `relay` web hooks. The setup file turns every flag on for upstream suites,
// so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EarlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

import { resolveCloudPublicConfig } from "../cloud/publicConfig";
import { settingsSearchItemVisible } from "./hiddenFeatures";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: { ...actual.readEarlyscriptFlags({}) } };
});

const flags = earlyscriptFlags as { -readonly [Name in keyof EarlyscriptFlags]: boolean };

describe("Earlyscript relay in the browser with the relay flag at its default", () => {
  afterEach(() => {
    flags.relay = false;
    vi.unstubAllEnvs();
  });

  it("knows no relay URL, so nothing in the browser reaches the relay", () => {
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    expect(resolveCloudPublicConfig().relayUrl).toBeNull();
    flags.relay = true;
    expect(resolveCloudPublicConfig().relayUrl).toBe("https://relay.example.test");
  });

  it("drops the Labs guest links row, which rides on the relay", () => {
    expect(settingsSearchItemVisible({ id: "guest-links", to: "/settings/labs" })).toBe(false);
    const labs = NodeFS.readFileSync(
      new URL("../components/settings/LabsSettingsPanel.tsx", import.meta.url),
      "utf8",
    );
    expect(labs).toContain("{earlyscriptFlags.relay &&");
  });
});
