import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MANUAL_THREAD_MODEL, videoThreadTargetFor } from "./videoThreadTarget";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const CLAUDE = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };
const SETTINGS_WITH_MODEL = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: CLAUDE };
const PROJECT = {
  id: ProjectId.make("project:repo"),
  environmentId: ENVIRONMENT_ID,
  title: "repo",
  workspaceRoot: "/home/miguel/repo",
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
};

const target = (input: Partial<Parameters<typeof videoThreadTargetFor>[0]>) =>
  videoThreadTargetFor({
    projects: [],
    threadShells: [],
    settings: SETTINGS_WITH_MODEL,
    providers: [],
    mode: "assisted",
    now: Date.parse("2026-11-01T12:00:00.000Z"),
    ...input,
  });

describe("videoThreadTargetFor", () => {
  it("leaves the project to the server when the install has none yet", () => {
    const resolved = target({});
    expect(resolved).not.toHaveProperty("projectId");
    expect(resolved?.modelSelection).toEqual(CLAUDE);
  });

  it("opens the thread in the most recent project when there is one", () => {
    expect(target({ projects: [PROJECT as never] })?.projectId).toBe(PROJECT.id);
  });

  it("needs a model only for an assisted thread", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: null };
    expect(target({ settings })).toBeNull();
    expect(target({ settings, mode: "manual" })?.modelSelection).toEqual(MANUAL_THREAD_MODEL);
  });
});
