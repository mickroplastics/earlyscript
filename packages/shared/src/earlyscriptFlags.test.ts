import { describe, expect, it } from "vite-plus/test";

import {
  EARLYSCRIPT_FLAG_DEFAULTS,
  earlyscriptFlagEnvName,
  pickEarlyscriptFlagEnv,
  readEarlyscriptFlags,
} from "./earlyscriptFlags.ts";

describe("earlyscript flags", () => {
  it("defaults every flag off, so nothing leaves the machine unless asked", () => {
    expect(readEarlyscriptFlags({})).toEqual({
      telemetry: false,
      videoDeveloperTools: false,
      thirdPartyAnalytics: false,
      updateChecks: false,
      relay: false,
      t3Connect: false,
      marketing: false,
      terminal: false,
      changeRequests: false,
      sourceControlHosts: false,
      remoteAccess: false,
    });
    expect(Object.values(EARLYSCRIPT_FLAG_DEFAULTS).every((value) => value === false)).toBe(true);
  });

  it("names each variable in upper snake case", () => {
    expect(earlyscriptFlagEnvName("telemetry")).toBe("EARLYSCRIPT_FLAG_TELEMETRY");
    expect(earlyscriptFlagEnvName("thirdPartyAnalytics")).toBe(
      "EARLYSCRIPT_FLAG_THIRD_PARTY_ANALYTICS",
    );
    expect(earlyscriptFlagEnvName("t3Connect")).toBe("EARLYSCRIPT_FLAG_T3_CONNECT");
    expect(earlyscriptFlagEnvName("sourceControlHosts")).toBe(
      "EARLYSCRIPT_FLAG_SOURCE_CONTROL_HOSTS",
    );
  });

  it("reads 1, 0, true and false and ignores anything else", () => {
    const flags = readEarlyscriptFlags({
      EARLYSCRIPT_FLAG_TELEMETRY: "1",
      EARLYSCRIPT_FLAG_THIRD_PARTY_ANALYTICS: " TRUE ",
      EARLYSCRIPT_FLAG_UPDATE_CHECKS: "yes",
      EARLYSCRIPT_FLAG_RELAY: "0",
      EARLYSCRIPT_FLAG_MARKETING: "",
    });
    expect(flags.telemetry).toBe(true);
    expect(flags.thirdPartyAnalytics).toBe(true);
    expect(flags.updateChecks).toBe(false);
    expect(flags.relay).toBe(false);
    expect(flags.marketing).toBe(false);
    // T3CODE_TELEMETRY_ENABLED belongs to upstream and must not turn a flag on.
    expect(readEarlyscriptFlags({ T3CODE_TELEMETRY_ENABLED: "1" }).telemetry).toBe(false);
  });

  it("returns a frozen object", () => {
    expect(Object.isFrozen(readEarlyscriptFlags({}))).toBe(true);
  });

  it("keeps only flag variables for the browser bundle", () => {
    expect(
      pickEarlyscriptFlagEnv({
        EARLYSCRIPT_FLAG_TELEMETRY: "1",
        T3CODE_POSTHOG_KEY: "secret",
        EARLYSCRIPT_FLAG_RELAY: undefined,
      }),
    ).toEqual({ EARLYSCRIPT_FLAG_TELEMETRY: "1" });
  });
});
