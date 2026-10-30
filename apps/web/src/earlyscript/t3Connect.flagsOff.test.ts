// Earlyscript-only: the `t3Connect` hook in the browser's cloud public config. The setup file turns
// every flag on for upstream suites, so this file replaces the flags with their real defaults.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { EarlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

import { hasCloudPublicConfig } from "../cloud/publicConfig";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: { ...actual.readEarlyscriptFlags({}) } };
});

const flags = earlyscriptFlags as { -readonly [Name in keyof EarlyscriptFlags]: boolean };

describe("T3 Connect in the browser with the t3Connect flag at its default", () => {
  beforeEach(() => {
    // A build with everything T3 Connect needs, where upstream would offer it.
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  });

  afterEach(() => {
    flags.relay = false;
    flags.t3Connect = false;
    vi.unstubAllEnvs();
  });

  it("reports no T3 Connect config, so Clerk, sign-in and Connect onboarding never mount", () => {
    expect(hasCloudPublicConfig()).toBe(false);
    // With the relay on, the t3Connect flag alone keeps T3 Connect off.
    flags.relay = true;
    expect(hasCloudPublicConfig()).toBe(false);
    // T3 Connect also needs the relay.
    flags.relay = false;
    flags.t3Connect = true;
    expect(hasCloudPublicConfig()).toBe(false);
    flags.relay = true;
    expect(hasCloudPublicConfig()).toBe(true);
  });
});
