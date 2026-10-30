// Earlyscript-only: the `telemetry` hook in resolveRelayTracingConfig. The setup file turns every
// flag on for upstream suites, so this file replaces the flags with their real defaults.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EarlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

import { resolveRelayTracingConfig } from "./publicConfig";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: { ...actual.readEarlyscriptFlags({}) } };
});

const flags = earlyscriptFlags as { -readonly [Name in keyof EarlyscriptFlags]: boolean };

describe("resolveRelayTracingConfig with the telemetry flag at its default", () => {
  afterEach(() => {
    flags.telemetry = false;
    vi.unstubAllEnvs();
  });

  it("builds no relay exporter even with a complete relay tracing config", () => {
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://relay.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "dataset");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "token");

    expect(resolveRelayTracingConfig()).toBeNull();
    // The same config builds one once the flag is on, so the hook is what stops it.
    flags.telemetry = true;
    expect(resolveRelayTracingConfig()).not.toBeNull();
  });
});
