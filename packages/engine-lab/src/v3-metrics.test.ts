// @effect-diagnostics globalDate:off - pure metrics on synthetic rows.
import { describe, expect, it } from "vite-plus/test";

import { dayStart, DAY_MS, inclusiveDays, type V3List } from "./v3-data.ts";
import {
  blockDraws,
  captureWindow,
  eligibility,
  type JudgedCut,
  judgedIndex,
  meanU10,
  pairedSupport,
  recallEvaluable,
  recallOf,
  type TakeoffCapture,
  u10,
  u10Contrast,
  validCut,
} from "./v3-metrics.ts";
import { V3_CUTOFFS } from "./v3-oracle.ts";

const row = (
  T: string,
  anticipation: Record<string, number | null>,
  include = 0.7,
): TakeoffCapture => ({
  T,
  topic_id: T,
  include_score: include,
  window: captureWindow(T),
  first: {},
  anticipation,
});

describe("capture window, recall and censoring", () => {
  it("clips the window to 4–30 Oct and declares it", () => {
    expect(captureWindow("2026-10-10")).toEqual({
      from: "2026-10-04",
      to: "2026-10-16",
      clipped: true,
    });
    expect(captureWindow("2026-10-20")).toEqual({
      from: "2026-10-06",
      to: "2026-10-26",
      clipped: false,
    });
    expect(captureWindow("2026-10-24")).toEqual({
      from: "2026-10-10",
      to: "2026-10-30",
      clipped: false,
    });
  });

  it("counts captured, censored, the include subset and the paired difference against R2", () => {
    const rows = [
      row("2026-10-10", { V1: 2, R2: -1 }),
      row("2026-10-11", { V1: -3, R2: null }),
      row("2026-10-12", { V1: null, R2: 0 }, 0.3),
      row("2026-10-13", { V1: 1, R2: 1 }, 0.2),
    ];
    const r = recallOf(rows, "V1");
    expect(r).toMatchObject({
      takeoffs: 4,
      captured: 3,
      censored: 1,
      recall: 0.75,
      takeoffs_inc040: 2,
      captured_inc040: 2,
      recall_inc040: 1,
      on_or_before_T: 2,
      late: 1,
    });
    expect(r.anticipation.median).toBe(1);
    expect(r.paired_vs_R2).toMatchObject({ n: 2, median: 1.5, censored_either: 2 });
  });

  it("is evaluable with 15 takeoffs and a non-zero subset", () => {
    expect(recallEvaluable(15, 1)).toBe(true);
    expect(recallEvaluable(14, 10)).toBe(false);
    expect(recallEvaluable(20, 0)).toBe(false);
  });
});

const card = (topic: string, items: Array<string>, a: number | null, b: number | null) => ({
  topic_id: topic,
  item_ids: items,
  utility_opus: a,
  utility_sol: b,
});
const cut = (
  arm: string,
  cutoff: string,
  cards: JudgedCut["cards"],
  emitted = cards.length,
): JudgedCut => ({ arm, cutoff, emitted, cards });

describe("U@10 validity and paired support", () => {
  it("needs >= 5 cards and both judges on every card", () => {
    const five = Array.from({ length: 5 }, (_, j) => card(`t${j}`, [`i${j}`], 4, 3));
    expect(validCut(cut("V1", "2026-10-04", five))).toBe(true);
    expect(u10(cut("V1", "2026-10-04", five))).toBe(3.5);
    expect(validCut(cut("V1", "2026-10-04", five.slice(0, 4)))).toBe(false);
    expect(
      validCut(cut("V1", "2026-10-04", [...five.slice(0, 4), card("t", ["i"], 4, null)])),
    ).toBe(false);
    expect(validCut(cut("V1", "2026-10-04", five, 6))).toBe(false);
  });

  it("compares only on the cutoffs valid for both arms", () => {
    const five = (u: number) => Array.from({ length: 5 }, (_, j) => card(`t${j}`, [`i${j}`], u, u));
    const index = judgedIndex([
      cut("V1", "2026-10-04", five(4)),
      cut("V1", "2026-10-05", five(4)),
      cut("V1", "2026-10-06", five(2)),
      cut("R4", "2026-10-04", five(3)),
      cut("R4", "2026-10-05", five(3).slice(0, 4)),
      cut("R4", "2026-10-06", five(3)),
    ]);
    expect(pairedSupport(index, ["V1", "R4"])).toEqual(["2026-10-04", "2026-10-06"]);
    const c = u10Contrast(index, "V1", "R4");
    expect(c.support).toBe(2);
    expect(c.diff).toBeCloseTo(
      meanU10(index, "V1", c.support_cutoffs)! - meanU10(index, "R4", c.support_cutoffs)!,
    );
    expect(c.families.estimable).toBe(false);
    expect(c.alpha).toBeCloseTo(0.0125);
  });

  it("estimates the family interval with >= 5 families", () => {
    const cuts: Array<JudgedCut> = [];
    for (const [k, d] of V3_CUTOFFS.entries()) {
      cuts.push(
        cut(
          "V1",
          d,
          Array.from({ length: 5 }, (_, j) =>
            card(`v${j}`, [`f${(k + j) % 7}`], 3 + ((k + j) % 3), 4),
          ),
        ),
      );
      cuts.push(
        cut(
          "R4",
          d,
          Array.from({ length: 5 }, (_, j) => card(`r${j}`, [`g${(k + j) % 6}`], 3, 3)),
        ),
      );
    }
    const c = u10Contrast(judgedIndex(cuts), "V1", "R4");
    expect(c.support).toBe(21);
    expect(c.families.estimable).toBe(true);
    expect(c.families.units).toBeGreaterThanOrEqual(5);
    expect(c.families.low!).toBeLessThanOrEqual(c.diff!);
    expect(c.families.high!).toBeGreaterThanOrEqual(c.diff!);
    expect(c.blocks.estimable).toBe(true);
  });
});

describe("7-day blocks over the 21 cutoffs", () => {
  it("draws 3 windows per replicate with starts from 28 Sep to 24 Oct", () => {
    const starts: Array<Array<number>> = [];
    blockDraws(V3_CUTOFFS, 7, 500, 20261109, starts);
    const first = dayStart("2026-10-04") / DAY_MS;
    const all = starts.flat();
    expect(starts.every((s) => s.length === 3)).toBe(true);
    expect(Math.min(...all)).toBe(first - 6);
    expect(Math.max(...all)).toBe(first + 20);
    expect(new Set(all).size).toBe(27);
  });
});

describe("structural eligibility", () => {
  const list = (
    n: number,
    include: number,
    discards: Record<string, number> | null = { exclude: 2 },
  ): V3List => ({
    cutoff: "x",
    arm: "V1",
    moving: Array.from({ length: n }, (_, j) => ({
      topic_id: `t${j}`,
      item_ids: [],
      include_score: include,
    })),
    discards,
  });
  it("uses the median over the 21 cutoffs, a missing cutoff counting 0", () => {
    const days = V3_CUTOFFS;
    const ok = new Map(days.map((d, k) => [d, k < 11 ? list(8, 0.5) : null]));
    expect(eligibility(ok).eligible).toBe(true);
    const few = new Map(days.map((d, k) => [d, k < 10 ? list(8, 0.5) : null]));
    expect(eligibility(few)).toMatchObject({ median_emitted: 0, eligible: false });
    const low = new Map(days.map((d) => [d, list(10, 0.3)]));
    expect(eligibility(low).eligible).toBe(false);
    const other = new Map(days.map((d) => [d, list(10, 0.5, { item_min: 3 })]));
    expect(eligibility(other)).toMatchObject({
      eligible: false,
      other_discard_reasons: ["item_min"],
    });
    const none = new Map(days.map((d) => [d, list(10, 0.5, null)]));
    expect(eligibility(none)).toMatchObject({
      eligible: false,
      cutoffs_without_discards_field: 21,
    });
    void inclusiveDays;
  });
});
