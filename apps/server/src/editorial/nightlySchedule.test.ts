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
  nextUsefulOccurrence,
  sha256,
  upcomingOccurrences,
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

  it("skips the scheduled times whose cutoff already has its job", () => {
    const zone = "America/Guayaquil";
    const next = (nowIso: string, covered: ReadonlyArray<string>, timeOfDay = "03:00") =>
      nextUsefulOccurrence(
        upcomingOccurrences(timeOfDay, zone, Date.parse(nowIso), 7),
        Date.parse("2026-10-30T00:00:00.000Z"),
        new Set(covered),
      );
    // Ejecutar ahora at 01:18Z on 1 Nov (20:18 on 31 Oct in Guayaquil) took the cutoff of
    // 1 Nov, so 03:00 on 1 Nov would run nothing; the next useful one is 03:00 on 2 Nov.
    expect(next("2026-11-01T01:18:00.000Z", ["2026-11-01T00:00:00.000Z"])).toBe(
      Date.parse("2026-11-02T08:00:00.000Z"),
    );
    // No job yet: the next scheduled time itself.
    expect(next("2026-11-01T01:18:00.000Z", [])).toBe(Date.parse("2026-11-01T08:00:00.000Z"));
    // 22:00 in Guayaquil is 03:00Z of the next UTC day: the job of the local day leaves
    // tonight's run free, the job of the next UTC day takes it.
    expect(next("2026-10-31T12:00:00.000Z", ["2026-10-31T00:00:00.000Z"], "22:00")).toBe(
      Date.parse("2026-11-01T03:00:00.000Z"),
    );
    expect(next("2026-10-31T12:00:00.000Z", ["2026-11-01T00:00:00.000Z"], "22:00")).toBe(
      Date.parse("2026-11-02T03:00:00.000Z"),
    );
    // Before the run was switched on, a time does not count either.
    expect(
      nextUsefulOccurrence(
        upcomingOccurrences("03:00", zone, Date.parse("2026-11-01T01:18:00.000Z"), 7),
        Date.parse("2026-11-01T09:00:00.000Z"),
        new Set(),
      ),
    ).toBe(Date.parse("2026-11-02T08:00:00.000Z"));
    // Every time in the window covered: the last one looked at, never null while enabled.
    const all = upcomingOccurrences("03:00", zone, Date.parse("2026-11-01T01:18:00.000Z"), 7);
    expect(all).toHaveLength(7);
    expect(next("2026-11-01T01:18:00.000Z", all.map(cutoffOf))).toBe(all[6]);
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
