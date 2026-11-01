import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MANUAL_THREAD_MODEL, videoThreadTargetFor } from "./videoThreadTarget";

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const CLAUDE = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const CODEX = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
const SETTINGS_WITH_MODEL = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: CLAUDE };

const provider = (
  instanceId: "codex" | "claudeAgent",
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T12:00:00.000Z",
  models: [
    {
      slug: instanceId === "codex" ? CODEX.model : CLAUDE.model,
      name: instanceId,
      isCustom: false,
      isDefault: true,
      capabilities: {},
    },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

/** The settings page's switch off: the setting and the server's snapshot both say so. */
const disabled = (instanceId: "codex" | "claudeAgent"): Partial<ServerSettings> => ({
  providerInstances: {
    [instanceId]: { driver: ProviderDriverKind.make(instanceId), enabled: false, config: {} },
  },
});
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
    const resolved = target({ providers: [provider("claudeAgent")] });
    expect(resolved).not.toHaveProperty("projectId");
    expect(resolved?.modelSelection).toEqual(CLAUDE);
  });

  it("opens the thread in the most recent project when there is one", () => {
    expect(
      target({ projects: [PROJECT as never], providers: [provider("claudeAgent")] })?.projectId,
    ).toBe(PROJECT.id);
  });

  it("needs a model only for an assisted thread", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: null };
    expect(target({ settings })).toBeNull();
    expect(target({ settings, mode: "manual" })?.modelSelection).toEqual(MANUAL_THREAD_MODEL);
  });

  it("rejects a saved default when no provider is available", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: CODEX };
    expect(target({ settings, providers: [] })).toBeNull();
    expect(target({ settings, providers: [], mode: "manual" })?.modelSelection).toEqual(
      MANUAL_THREAD_MODEL,
    );
  });

  it("rejects a saved default whose provider is disabled", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      ...disabled("codex"),
      defaultModelSelection: CODEX,
    } as ServerSettings;
    expect(target({ settings, providers: [provider("codex", { enabled: false })] })).toBeNull();
  });

  it("rejects a saved default whose provider is unavailable", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: CODEX };
    expect(
      target({ settings, providers: [provider("codex", { availability: "unavailable" })] }),
    ).toBeNull();
  });

  it("rejects a project default whose provider the project disables", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: CLAUDE,
      projectSettingsOverrides: {
        [PROJECT.id]: {
          defaultModelSelection: CODEX,
          providerInstances: { [CODEX.instanceId]: { enabled: false } },
        },
      },
    } as ServerSettings;
    const resolved = target({
      settings,
      projects: [PROJECT as never],
      providers: [provider("codex")],
    });
    expect(resolved).toBeNull();
  });

  it("gives a disabled saved default way to a provider that is available", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      ...disabled("codex"),
      defaultModelSelection: CODEX,
    } as ServerSettings;
    const resolved = target({
      settings,
      providers: [provider("codex", { enabled: false }), provider("claudeAgent")],
    });
    expect(resolved?.modelSelection).toEqual(CLAUDE);
  });

  describe("replacing a default that cannot run (cost review, round 2)", () => {
    const CODEX_OFF = {
      ...DEFAULT_SERVER_SETTINGS,
      ...disabled("codex"),
      defaultModelSelection: CODEX,
    } as ServerSettings;
    const model = (slug: string, name: string, isDefault = false) => ({
      slug,
      name,
      isCustom: false,
      ...(isDefault ? { isDefault } : {}),
      capabilities: {},
    });
    const claude = (models: ReadonlyArray<ReturnType<typeof model>>) =>
      provider("claudeAgent", { displayName: "Claude", models: [...models] });
    const codexOff = provider("codex", {
      enabled: false,
      displayName: "Codex",
      models: [model(CODEX.model, "GPT-6-Astra", true)],
    });

    it("takes the model the composer picks for that provider: its catalog default", () => {
      const resolved = target({
        settings: CODEX_OFF,
        providers: [
          codexOff,
          claude([
            model("claude-opus-5-5", "Claude Opus 5.5"),
            model("claude-sonnet-5-5", "Claude Sonnet 5.5", true),
          ]),
        ],
      });
      expect(resolved?.modelSelection).toEqual({
        instanceId: CLAUDE.instanceId,
        model: "claude-sonnet-5-5",
      });
      expect(resolved?.providerNotice).toBe(
        "Se usará Claude Sonnet 5.5 (Claude) porque GPT-6-Astra (Codex) no está disponible. Puedes cambiarlo antes de enviar.",
      );
    });

    it("takes the first model listed when the catalog has no default or hides it", () => {
      const models = [
        model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
        model("claude-opus-5-5", "Claude Opus 5.5"),
      ];
      expect(
        target({ settings: CODEX_OFF, providers: [codexOff, claude(models)] })?.modelSelection
          .model,
      ).toBe("claude-sonnet-5-5");
      const hidden = {
        ...CODEX_OFF,
        providerModelPreferences: {
          [CLAUDE.instanceId]: { hiddenModels: ["claude-opus-5-5"], modelOrder: [] },
        },
      } as ServerSettings;
      const withDefault = [model("claude-opus-5-5", "Claude Opus 5.5", true), models[0]!];
      expect(
        target({ settings: hidden, providers: [codexOff, claude(withDefault)] })?.modelSelection
          .model,
      ).toBe("claude-sonnet-5-5");
    });

    it("says nothing when the default runs, when none is saved, or for a manual thread", () => {
      const sonnet = claude([model("claude-sonnet-5-5", "Claude Sonnet 5.5", true)]);
      expect(target({ providers: [sonnet] })).not.toHaveProperty("providerNotice");
      const unsaved = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: null };
      expect(target({ settings: unsaved, providers: [sonnet] })).not.toHaveProperty(
        "providerNotice",
      );
      expect(
        target({ settings: CODEX_OFF, providers: [codexOff, sonnet], mode: "manual" }),
      ).not.toHaveProperty("providerNotice");
    });
  });
});
