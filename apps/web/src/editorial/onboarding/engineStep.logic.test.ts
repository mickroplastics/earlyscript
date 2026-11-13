import { describe, expect, it } from "vite-plus/test";

import { engineStepAcceptance } from "./engineStep.logic";

describe("engineStepAcceptance", () => {
  it("records the saved schedule and what the operator did in the step", () => {
    expect(
      engineStepAcceptance(
        { enabled: true, timeOfDay: "04:15", timezone: "America/Guayaquil" },
        { firstRunStarted: true, modelReady: false },
      ),
    ).toEqual({
      nightlyEnabled: true,
      timeOfDay: "04:15",
      timezone: "America/Guayaquil",
      firstRunStarted: true,
      modelReady: false,
    });
  });
});
