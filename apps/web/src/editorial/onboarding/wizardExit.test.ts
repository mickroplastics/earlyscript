import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { selectEnvironmentSpace, useSpaceStore } from "../spaceStore";
import { leaveWizard } from "./wizardExit";

const ENVIRONMENT_ID = EnvironmentId.make("env-exit");

const setup = (environmentId: EnvironmentId | null, completeOnboarding = async () => {}) => {
  useSpaceStore.setState({ byEnvironment: {}, threadsHref: null });
  const openTrends = vi.fn(async (_environmentId: EnvironmentId) => {});
  const fallback = vi.fn();
  const leave = () =>
    leaveWizard({
      environmentId,
      completeOnboarding,
      setSpace: useSpaceStore.getState().setSpace,
      openTrends,
      fallback,
    });
  const space = () => selectEnvironmentSpace(useSpaceStore.getState(), ENVIRONMENT_ID).space;
  return { leave, openTrends, fallback, space };
};

describe("leaveWizard", () => {
  it("opens Trends and keeps it as the environment's space once onboarding is marked", async () => {
    const calls: string[] = [];
    const { leave, openTrends, fallback, space } = setup(ENVIRONMENT_ID, async () => {
      calls.push("complete");
    });
    expect(space()).toBe("threads");
    expect(await leave()).toBe(true);
    expect(calls).toEqual(["complete"]);
    expect(openTrends).toHaveBeenCalledWith(ENVIRONMENT_ID);
    expect(space()).toBe("trends");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("stays when onboarding could not be marked complete", async () => {
    const { leave, openTrends, space } = setup(ENVIRONMENT_ID, async () => {
      throw new Error("settings");
    });
    expect(await leave()).toBe(false);
    expect(openTrends).not.toHaveBeenCalled();
    expect(space()).toBe("threads");
  });

  it("uses the route's exit without a local environment", async () => {
    const { leave, openTrends, fallback } = setup(null);
    expect(await leave()).toBe(true);
    expect(fallback).toHaveBeenCalledOnce();
    expect(openTrends).not.toHaveBeenCalled();
  });
});
