import { describe, expect, it, vi } from "vite-plus/test";

import {
  WIZARD_START,
  acceptStep,
  wizardAdvance,
  wizardBack,
  wizardGoTo,
  type WizardPosition,
} from "./wizardNavigation";

const ok = { ok: true } as const;

describe("wizard navigation", () => {
  it("walks the steps in order and finishes after the last one", () => {
    let position: WizardPosition = WIZARD_START;
    const seen = [position.index];
    for (;;) {
      const next = wizardAdvance(position, 4);
      if (next === "finished") break;
      position = next;
      seen.push(position.index);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(position.reached).toBe(3);
  });

  it("goes back without forgetting how far the operator got, and never past the start", () => {
    const third: WizardPosition = { index: 2, reached: 2 };
    expect(wizardBack(third)).toEqual({ index: 1, reached: 2 });
    expect(wizardBack(WIZARD_START)).toBe(WIZARD_START);
    // Accepting a step again after going back returns to the furthest step reached.
    const again = wizardAdvance({ index: 0, reached: 2 }, 4);
    expect(again).toEqual({ index: 1, reached: 2 });
  });

  it("opens only steps already reached from the header", () => {
    const position: WizardPosition = { index: 1, reached: 2 };
    expect(wizardGoTo(position, 0)).toEqual({ index: 0, reached: 2 });
    expect(wizardGoTo(position, 2)).toEqual({ index: 2, reached: 2 });
    expect(wizardGoTo(position, 3)).toBe(position);
    expect(wizardGoTo(position, -1)).toBe(position);
  });

  it("records the acceptance before moving on", async () => {
    const calls: string[] = [];
    const record = vi.fn(async () => {
      calls.push("record");
      return ok;
    });
    const outcome = await acceptStep({ position: WIZARD_START, total: 4, record });
    calls.push("advance");
    expect(calls).toEqual(["record", "advance"]);
    expect(outcome).toEqual({ _tag: "moved", position: { index: 1, reached: 1 } });
  });

  it("stays on the step when the acceptance is not recorded", async () => {
    const outcome = await acceptStep({
      position: { index: 1, reached: 1 },
      total: 4,
      record: async () => ({ ok: false, error: "storage" }),
    });
    expect(outcome).toEqual({ _tag: "failed", error: "storage" });
  });

  it("finishes only after the last acceptance is recorded", async () => {
    const record = vi.fn(async () => ok);
    const outcome = await acceptStep({ position: { index: 3, reached: 3 }, total: 4, record });
    expect(record).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ _tag: "finished" });
  });
});
