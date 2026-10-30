// Earlyscript-only: the `telemetry` hook in resolveSignalEndpoint. The setup file turns every
// flag on for upstream suites, so this file replaces the flags with their real defaults.
import { describe, expect, it, vi } from "vite-plus/test";

import type { EarlyscriptFlags } from "./earlyscriptFlags.ts";
import { earlyscriptFlags } from "./earlyscriptFlags.ts";
import * as OtelEnvironment from "./otelEnvironment.ts";

vi.mock("./earlyscriptFlags.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./earlyscriptFlags.ts")>();
  return { ...actual, earlyscriptFlags: { ...actual.readEarlyscriptFlags({}) } };
});

const flags = earlyscriptFlags as { -readonly [Name in keyof EarlyscriptFlags]: boolean };

const t3Export = { protocol: "http/json", headers: {}, exportIntervalMs: 5_000 } as const;
const fallback = {
  bootstrapUrl: "http://bootstrap:4318/v1/signal",
  settingsUrl: "http://settings:4318/v1/signal",
};
const fromEnvironment = (signal: OtelEnvironment.SignalName) => ({
  ...OtelEnvironment.none,
  [signal]: OtelEnvironment.OtelSignal.Export({
    url: `http://otel:4318/v1/${signal}`,
    variable: `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`,
    protocol: "http/protobuf",
    headers: {},
  }),
});

describe("resolveSignalEndpoint with the telemetry flag at its default", () => {
  it.each(["traces", "metrics", "logs"] as const)(
    "returns no %s endpoint from T3CODE_OTLP_*, OTEL_* or the settings",
    (signal) => {
      flags.telemetry = false;
      const cases = [
        [OtelEnvironment.none, { url: `http://t3:4318/v1/${signal}`, export: t3Export }],
        [fromEnvironment(signal), { url: undefined, export: t3Export }],
        [OtelEnvironment.none, { url: undefined, export: t3Export }],
      ] as const;
      for (const [otel, t3] of cases) {
        expect(OtelEnvironment.resolveSignalEndpoint(otel, signal, t3, fallback)).toBeUndefined();
      }
      // The same inputs export once the flag is on, so the hook is what stops them.
      flags.telemetry = true;
      for (const [otel, t3] of cases) {
        expect(OtelEnvironment.resolveSignalEndpoint(otel, signal, t3, fallback)).toBeDefined();
      }
      flags.telemetry = false;
    },
  );
});
