// @effect-diagnostics nodeBuiltinImport:off - reads the engine's configuration file.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CONFIG_PATH, loadConfig } from "@earlyscript/trend-engine/run";

import { SINGULARIDEV_PROFILE_V1 } from "./channelProfile.ts";
import {
  canonicalJson,
  collectWindow,
  cutoffOf,
  lastOccurrence,
  nextOccurrence,
  sha256,
} from "./nightlySchedule.ts";

describe("nightly schedule", () => {
  it("reads the time of day in the stored zone and keys the job by the UTC day", () => {
    // 03:00 in Guayaquil (UTC-5) is 08:00Z.
    const now = Date.parse("2026-10-31T09:00:00.000Z");
    const last = lastOccurrence("03:00", "America/Guayaquil", now);
    expect(last).toBe(Date.parse("2026-10-31T08:00:00.000Z"));
    expect(cutoffOf(last ?? 0)).toBe("2026-10-31T00:00:00.000Z");
    // At 20:00 local the UTC day is already the next one, but the latest occurrence is
    // still this morning's: one job per occurrence, not per UTC midnight.
    const evening = Date.parse("2026-11-01T01:00:00.000Z");
    expect(cutoffOf(lastOccurrence("03:00", "America/Guayaquil", evening) ?? 0)).toBe(
      "2026-10-31T00:00:00.000Z",
    );
    expect(nextOccurrence("03:00", "America/Guayaquil", now)).toBe(
      Date.parse("2026-11-01T08:00:00.000Z"),
    );
  });

  it("captures from the last corpus day to yesterday and names the days without a run", () => {
    expect(
      collectWindow({ corpusToDay: "2026-10-31", cutoffDay: "2026-10-31", initialDays: 28 }),
    ).toEqual({ fromDay: "2026-10-30", toDay: "2026-10-31", missedDays: [] });
    expect(
      collectWindow({ corpusToDay: "2026-10-28", cutoffDay: "2026-10-31", initialDays: 28 }),
    ).toEqual({
      fromDay: "2026-10-27",
      toDay: "2026-10-31",
      missedDays: ["2026-10-28", "2026-10-29"],
    });
    expect(collectWindow({ corpusToDay: null, cutoffDay: "2026-10-31", initialDays: 28 })).toEqual({
      fromDay: "2026-10-03",
      toDay: "2026-10-31",
      missedDays: [],
    });
    expect(
      collectWindow({ corpusToDay: "2026-11-01", cutoffDay: "2026-10-31", initialDays: 28 }),
    ).toBeNull();
  });

  it("hashes the configuration and the profile as the engine does", () => {
    const raw = JSON.parse(NodeFS.readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    expect(sha256(canonicalJson({ ...raw, sources: raw["sources"] }))).toBe(
      loadConfig(DEFAULT_CONFIG_PATH).hash,
    );
    // The bytes of profiles/singularidev.v1.json that the reference runs were scored with.
    expect(sha256(SINGULARIDEV_PROFILE_V1)).toBe(
      "sha256:db510e303cb7f3cff7099230a00d36b1918f28a0e6aa6b8be01727649b8bb80d",
    );
  });
});
