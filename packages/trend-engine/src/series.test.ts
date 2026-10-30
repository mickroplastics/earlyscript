import { describe, expect, it } from "vite-plus/test";

import { daysBefore } from "./days.ts";
import {
  classify,
  type CoverageIndex,
  coverageSummary,
  dailyCurve,
  type SeriesItem,
} from "./series.ts";

const CUTOFF_DAY = "2026-10-15";
const DAYS = daysBefore(CUTOFF_DAY, 14);
const STAGE = { context_days: 14, growth_min: 0.69, growing_min_items_7d: 3, fading_max: -0.69 };

function coverage(
  statuses: Partial<Record<string, "complete" | "partial" | "unavailable" | "rate_limited">> = {},
): CoverageIndex {
  return new Map([
    ["hn", new Map(DAYS.map((day) => [day, statuses[`hn/${day}`] ?? "complete"]))],
    ["github", new Map(DAYS.map((day) => [day, statuses[`github/${day}`] ?? "partial"]))],
  ]);
}

const items: Array<SeriesItem> = DAYS.slice(-7).flatMap((day, d) =>
  [0, 1].map((k) => ({
    id: `${day}-${k}`,
    source: "hn" as const,
    day,
    author: `a${d}${k}`,
    entities: [],
  })),
);

describe("coverage", () => {
  it("reports failures as gaps but not a sample source's partial days", () => {
    const { by_source, data_gaps } = coverageSummary(
      coverage({
        [`hn/${DAYS[3]}`]: "unavailable",
        [`hn/${DAYS[4]}`]: "partial",
        [`github/${DAYS[5]}`]: "rate_limited",
      }),
      ["hn", "github"],
      DAYS,
    );
    expect(data_gaps).toEqual([
      { source: "hn", day: DAYS[3], reason: "fetch_failed" },
      { source: "hn", day: DAYS[4], reason: "partial" },
      { source: "github", day: DAYS[5], reason: "rate_limited" },
    ]);
    expect(by_source).toEqual([
      { source: "hn", days_complete: 12, days_partial: 1, days_unavailable: 1 },
      { source: "github", days_complete: 0, days_partial: 13, days_unavailable: 1 },
    ]);
  });

  it("marks a lost day unknown in the curve and keeps the other days' counts", () => {
    const lost = DAYS[10]!;
    const curve = dailyCurve(items, DAYS, coverage({ [`hn/${lost}`]: "unavailable" }), [
      "hn",
      "github",
    ]);
    expect(curve.find((point) => point.day === lost)).toEqual({
      day: lost,
      items: 0,
      sources: 0,
      authors: 0,
      known: false,
    });
    expect(curve.filter((point) => point.known).reduce((sum, point) => sum + point.items, 0)).toBe(
      12,
    );
  });
});

describe("classify", () => {
  it("still classifies with a lost day under per_source and not under all_sources", () => {
    const gap = coverage({ [`github/${DAYS[9]}`]: "unavailable" });
    expect(
      classify(items, CUTOFF_DAY, gap, ["hn", "github"], { ...STAGE, coverage_rule: "per_source" }),
    ).toEqual({
      stage: "growing",
      growth: Math.log(15),
      items_7d: 14,
      items_prev_7d: 0,
      authors_7d: 14,
    });
    expect(
      classify(items, CUTOFF_DAY, gap, ["hn", "github"], { ...STAGE, coverage_rule: "all_sources" })
        .stage,
    ).toBe("unclassified");
  });

  it("leaves a signal unclassified when a whole window is unknown to its sources", () => {
    const blind = coverage(
      Object.fromEntries(DAYS.slice(0, 7).map((day) => [`hn/${day}`, "unavailable" as const])),
    );
    expect(
      classify(items, CUTOFF_DAY, blind, ["hn", "github"], {
        ...STAGE,
        coverage_rule: "per_source",
      }).stage,
    ).toBe("unclassified");
  });
});
