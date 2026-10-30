// Earlyscript-only: the `telemetry` hook in resolveRelayClientTracingConfig. The setup file turns
// every flag on for upstream suites, so this file replaces the flags with their real defaults.
import { describe, expect, it, vi } from "vite-plus/test";

import type { EarlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

import { resolveRelayClientTracingConfig } from "./publicConfig.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: { ...actual.readEarlyscriptFlags({}) } };
});

const flags = earlyscriptFlags as { -readonly [Name in keyof EarlyscriptFlags]: boolean };

describe("resolveRelayClientTracingConfig with the telemetry flag at its default", () => {
  it("returns no relay tracing config from the environment or the build", () => {
    const env = {
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "dataset",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "token",
    };
    const fallback = {
      tracesUrl: "https://build.example.test/v1/traces",
      tracesDataset: "build-dataset",
      tracesToken: "build-token",
    };
    try {
      expect(resolveRelayClientTracingConfig(env, fallback)).toBeNull();
      expect(resolveRelayClientTracingConfig({}, fallback)).toBeNull();
      // The same config resolves once the flag is on, so the hook is what stops it.
      flags.telemetry = true;
      expect(resolveRelayClientTracingConfig(env, fallback)).not.toBeNull();
    } finally {
      flags.telemetry = false;
    }
  });
});
