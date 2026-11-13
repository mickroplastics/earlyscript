import type { EditorialOnboardingAcceptance, EditorialOnboardingStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  firstReviewWaitsForModel,
  missingStepsText,
  setupProgress,
  stepCaption,
} from "./setupProgress";

const AT = "2026-11-12T10:00:00.000Z";

const status = (
  accepted: ReadonlyArray<EditorialOnboardingStatus["steps"][number]["step"]>,
  completedAt: string | null = null,
): EditorialOnboardingStatus => ({
  steps: (["datos", "proveedores", "estudio", "motor"] as const).map((step) => ({
    step,
    lastAcceptedAt: accepted.includes(step) ? AT : null,
  })),
  completedAt,
});

const motor = (payload: Record<string, unknown>): EditorialOnboardingAcceptance => ({
  id: "a",
  step: "motor",
  acceptedAt: AT,
  payload,
  appVersion: "0.1.5",
});

describe("setupProgress", () => {
  it("reopens at the first step not accepted while the wizard was never finished", () => {
    expect(setupProgress(status([]))).toEqual({ pending: true, reached: 0 });
    expect(setupProgress(status(["datos", "proveedores"]))).toEqual({ pending: true, reached: 2 });
    expect(setupProgress(status(["datos", "proveedores", "estudio", "motor"]))).toEqual({
      pending: true,
      reached: 3,
    });
  });

  it("is no longer pending once finished, whatever was accepted", () => {
    expect(setupProgress(status(["datos"], AT)).pending).toBe(false);
  });
});

describe("missing steps", () => {
  it("names what is left in the inbox and in the sidebar entry", () => {
    expect(missingStepsText(2)).toBe("Faltan tu canal y la revisión nocturna.");
    expect(missingStepsText(3)).toBe("Falta la revisión nocturna.");
    expect(stepCaption(2)).toBe("Paso 3 de 4 · Tu canal");
  });
});

describe("firstReviewWaitsForModel", () => {
  it("waits only when the last nightly step was finished before the model and any review", () => {
    expect(firstReviewWaitsForModel([])).toBe(false);
    expect(firstReviewWaitsForModel([motor({ modelReady: false, firstRunStarted: false })])).toBe(
      true,
    );
    expect(
      firstReviewWaitsForModel([
        motor({ modelReady: false, firstRunStarted: false }),
        motor({ modelReady: true, firstRunStarted: true }),
      ]),
    ).toBe(false);
  });
});
