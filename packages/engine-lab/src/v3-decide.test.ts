import { describe, expect, it } from "vite-plus/test";

import { decide, type DecideInput, TABLE_5D } from "./v3-decide.ts";

const variant = (eligible: boolean, u10: number | null, recall: number | null) => ({
  eligible,
  u10,
  recall_inc040: recall,
});
const r4 = (diff: number, low: number | null, high: number | null, estimable = true) => ({
  diff,
  low,
  high,
  estimable,
  support: 21,
});

const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  premanifest_late: false,
  judge: { failed: false, kappa: 0.7, agreement: 0.93, selection_support: 18 },
  recall: { takeoffs: 26, inc040_denominator: 20 },
  variants: {
    V1: variant(true, 3.6, 0.5),
    V2: variant(true, 3.8, 0.6),
    V3: variant(true, 3.4, 0.6),
    V4: variant(false, null, 0.7),
  },
  r4: { V1: r4(0.1, -0.1, 0.3), V2: r4(0.1, -0.1, 0.3), V3: r4(0.1, -0.1, 0.3), V4: null },
  ...over,
});

describe("table 5d, one test per row", () => {
  it("has 18 rows with distinct ids", () => {
    expect(new Set(TABLE_5D.map((r) => r.id)).size).toBe(18);
  });

  it("J1: a failed diagnosis, low κ or low agreement leaves the judge uncalibrated", () => {
    for (const judge of [
      { failed: true, kappa: 0.9, agreement: 0.95, selection_support: 21 },
      { failed: false, kappa: 0.59, agreement: 0.95, selection_support: 21 },
      { failed: false, kappa: 0.7, agreement: 0.916, selection_support: 21 },
    ]) {
      const d = decide(base({ judge }));
      expect(d.rows).toContain("J1");
      expect(d.judge_calibrated).toBe(false);
      expect(d.selection_path).toBe("S2");
    }
  });

  it("J2: a calibrated judge with < 15 common valid cutoffs (judge down) counts as uncalibrated", () => {
    const d = decide(
      base({ judge: { failed: false, kappa: 0.7, agreement: 0.93, selection_support: 14 } }),
    );
    expect(d.rows).toContain("J2");
    expect(d.judge_calibrated).toBe(false);
    expect(d.selection_path).toBe("S2");
  });

  it("U1 and S1: with a calibrated judge, the highest U@10; a tie under 0,05 goes to fewer parameters", () => {
    const d = decide(base());
    expect(d.rows).toEqual(expect.arrayContaining(["U1", "E1", "S1", "P1", "P3"]));
    expect(d.chosen).toBe("V2");
    const tie = decide(base({ variants: { ...base().variants, V3: variant(true, 3.76, 0.1) } }));
    expect(tie.chosen).toBe("V3");
    const orderTie = decide(
      base({
        variants: {
          V1: variant(true, 3.8, 0),
          V2: variant(true, 3.79, 0),
          V3: variant(false, null, 0),
          V4: variant(true, 3.78, 0),
        },
      }),
    );
    expect(orderTie.chosen).toBe("V1");
  });

  it("R1: fewer than 15 takeoffs or an empty subset is not evaluable", () => {
    const uncal = { failed: true, kappa: null, agreement: null, selection_support: 0 };
    const few = decide(base({ judge: uncal, recall: { takeoffs: 14, inc040_denominator: 10 } }));
    expect(few.rows).toEqual(expect.arrayContaining(["J1", "R1", "S3"]));
    expect(few.recall_evaluable).toBe(false);
    expect(
      decide(base({ judge: uncal, recall: { takeoffs: 30, inc040_denominator: 0 } })).rows,
    ).toContain("R1");
  });

  it("E1 and S2: the uncalibrated path takes the highest recall, ties by V1 > V2 > V3 > V4", () => {
    const d = decide(
      base({ judge: { failed: true, kappa: null, agreement: null, selection_support: 0 } }),
    );
    expect(d.rows).toEqual(expect.arrayContaining(["E1", "S2"]));
    expect(d.eligible).toEqual(["V1", "V2", "V3"]);
    expect(d.chosen).toBe("V2");
  });

  it("S3: uncalibrated and recall not evaluable: the first eligible variant", () => {
    const d = decide(
      base({
        judge: { failed: true, kappa: null, agreement: null, selection_support: 0 },
        recall: { takeoffs: 3, inc040_denominator: 1 },
        variants: { ...base().variants, V1: variant(false, null, 1) },
      }),
    );
    expect(d.selection_path).toBe("S3");
    expect(d.chosen).toBe("V2");
  });

  it("P0: no eligible variant stops, pairs with engine.v1", () => {
    const d = decide(
      base({
        variants: {
          V1: variant(false, null, 1),
          V2: variant(false, null, 1),
          V3: variant(false, null, 1),
          V4: variant(false, null, 1),
        },
      }),
    );
    expect(d.rows).toContain("P0");
    expect(d).toMatchObject({
      stop: true,
      promote: false,
      pairs_engine: "engine.v1",
      chosen: null,
    });
  });

  it("P1: stops only with diff <= −0,05 and the family interval wholly below 0", () => {
    const stop = decide(base({ r4: { ...base().r4, V2: r4(-0.06, -0.2, -0.01) } }));
    expect(stop.rows).toContain("P1");
    expect(stop).toMatchObject({ stop: true, promote: false, pairs_engine: "engine.v1" });
    const crosses = decide(base({ r4: { ...base().r4, V2: r4(-0.06, -0.2, 0.02) } }));
    expect(crosses).toMatchObject({ stop: false, promote: true, pairs_engine: "v3" });
    const small = decide(base({ r4: { ...base().r4, V2: r4(-0.04, -0.2, -0.01) } }));
    expect(small).toMatchObject({ stop: false, promote: true });
  });

  it("P2: interval not estimable, no promotion at diff <= −0,05, continues above", () => {
    const low = decide(base({ r4: { ...base().r4, V2: r4(-0.05, null, null, false) } }));
    expect(low.rows).toContain("P2");
    expect(low).toMatchObject({ stop: false, promote: false, pairs_engine: "engine.v1" });
    const ok = decide(base({ r4: { ...base().r4, V2: r4(-0.049, null, null, false) } }));
    expect(ok).toMatchObject({ promote: true, pairs_engine: "v3" });
    expect(ok.notes.join(" ")).toMatch(/no estimable/);
  });

  it("P3: R2, R5, engine.v1 and engine.v2 are reported and never decide", () => {
    expect(decide(base()).rows).toContain("P3");
  });

  it("T1: a late pre-manifest makes development exploratory and the judge uncalibrated", () => {
    const d = decide(base({ premanifest_late: true }));
    expect(d.rows).toEqual(expect.arrayContaining(["T1", "S2"]));
    expect(d).toMatchObject({ exploratory: true, judge_calibrated: false });
    expect(d.rows).not.toContain("P1");
  });

  it("F1: no deployed freeze when Miguel orders the pairs: engine.v1", () => {
    const d = decide(
      base({
        pairs_phase: { freeze_deployed_at_order: false, hash_ok: true, completed: 0, planned: 6 },
      }),
    );
    expect(d.rows).toContain("F1");
    expect(d.pairs_engine).toBe("engine.v1");
  });

  it("H1: the logical hash fails, one retry, then engine.v1", () => {
    const retried = decide(
      base({
        pairs_phase: {
          freeze_deployed_at_order: true,
          hash_ok: false,
          hash_retry_ok: true,
          completed: 6,
          planned: 6,
        },
      }),
    );
    expect(retried.rows).toContain("H1");
    expect(retried.pairs_engine).toBe("v3");
    const failed = decide(
      base({
        pairs_phase: {
          freeze_deployed_at_order: true,
          hash_ok: false,
          hash_retry_ok: false,
          completed: 0,
          planned: 6,
        },
      }),
    );
    expect(failed.pairs_engine).toBe("engine.v1");
  });

  it("C1: incomplete pairs are reported, not replaced", () => {
    const d = decide(
      base({
        pairs_phase: { freeze_deployed_at_order: true, hash_ok: true, completed: 4, planned: 6 },
      }),
    );
    expect(d.rows).toContain("C1");
    expect(d.notes.join(" ")).toMatch(/4 de 6/);
  });

  it("M1: Miguel rejects: stop", () => {
    const d = decide(base({ miguel_rejects: true }));
    expect(d.rows).toContain("M1");
    expect(d.stop).toBe(true);
  });

  it("Z1: after the pairs, time > 60 % or utility < 4 is a negative result", () => {
    const slow = decide(
      base({
        pairs_phase: {
          freeze_deployed_at_order: true,
          hash_ok: true,
          completed: 6,
          planned: 6,
          assisted_time_ratio: 0.61,
          mean_utility: 4.5,
        },
      }),
    );
    expect(slow.rows).toContain("Z1");
    const weak = decide(
      base({
        pairs_phase: {
          freeze_deployed_at_order: true,
          hash_ok: true,
          completed: 6,
          planned: 6,
          assisted_time_ratio: 0.5,
          mean_utility: 3.9,
        },
      }),
    );
    expect(weak.rows).toContain("Z1");
    const good = decide(
      base({
        pairs_phase: {
          freeze_deployed_at_order: true,
          hash_ok: true,
          completed: 6,
          planned: 6,
          assisted_time_ratio: 0.5,
          mean_utility: 4,
        },
      }),
    );
    expect(good.rows).not.toContain("Z1");
  });

  it("is pure: the same input gives the same decision", () => {
    expect(decide(base())).toEqual(decide(base()));
  });
});
