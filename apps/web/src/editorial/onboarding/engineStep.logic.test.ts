import { describe, expect, it } from "vite-plus/test";

import { engineStepAcceptance, scheduleText } from "./engineStep.logic";

describe("scheduleText", () => {
  it("names the time with the machine's zone", () => {
    expect(scheduleText("03:00", "America/Guayaquil")).toBe("03:00, hora de America/Guayaquil");
    expect(scheduleText("22:30", "America/New_York")).toBe("22:30, hora de America/New York");
  });

  it("says UTC once for the UTC zones", () => {
    expect(scheduleText("03:00", "UTC")).toBe("03:00 UTC");
    expect(scheduleText("03:00", "Etc/UTC")).toBe("03:00 UTC");
  });
});

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
