// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `t3Connect` hooks. The setup file turns every flag on for upstream suites,
// so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as CloudHttp from "../cloud/http.ts";
import * as EarlyscriptConnectHttp from "./connectHttp.ts";
import { cloudPublicConfigAvailable, t3ConnectEnabled } from "./t3Connect.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const source = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");

describe("Earlyscript T3 Connect with the t3Connect flag at its default", () => {
  it("reports no T3 Connect public config even when the environment has all of it", async () => {
    expect(t3ConnectEnabled).toBe(false);
    expect(cloudPublicConfigAvailable(true)).toBe(false);
    vi.stubEnv("T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("T3CODE_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA");
    vi.stubEnv("T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", "client");
    vi.resetModules();
    try {
      const publicConfig = await import("../cloud/publicConfig.ts");
      expect(publicConfig.hasCloudPublicConfig).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("serves the connect routes from the disabled group, which answers 404", () => {
    expect(EarlyscriptConnectHttp.layerConnectHttp).toBe(
      EarlyscriptConnectHttp.layerConnectHttpDisabled,
    );
    expect(EarlyscriptConnectHttp.layerConnectHttp).not.toBe(CloudHttp.layer);
    const server = source("../server.ts");
    expect(server).toContain("Layer.provide(EarlyscriptConnectHttp.layerConnectHttp),");
    expect(server).not.toContain("Layer.provide(CloudHttp.layer)");
  });
});
