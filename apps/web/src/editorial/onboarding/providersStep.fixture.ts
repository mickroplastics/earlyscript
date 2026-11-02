import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

const model = (slug: string, name: string, extra: Partial<ServerProviderModel> = {}) =>
  ({ slug, name, isCustom: false, capabilities: {}, ...extra }) satisfies ServerProviderModel;

/** The catalogs as this machine's Claude and Codex list them, flagship first. */
export const CLAUDE_MODELS = [
  model("claude-opus-5-5", "Claude Opus 5.5", { isDefault: true }),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
  model("claude-haiku-5-5", "Claude Haiku 5.5"),
];
const CODEX_MODELS = [
  model("gpt-6-astra", "GPT-6-Astra", { isDefault: true }),
  model("gpt-6-sol", "GPT-6-Sol"),
  model("gpt-6-luna", "GPT-6-Luna"),
];

export const providerFixture = (
  driver: "codex" | "claudeAgent" | "opencode",
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  displayName: driver === "codex" ? "Codex" : driver === "claudeAgent" ? "Claude" : "OpenCode",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-02T12:00:00.000Z",
  models: driver === "codex" ? CODEX_MODELS : driver === "claudeAgent" ? CLAUDE_MODELS : [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

export const signedOut: Partial<ServerProvider> = {
  status: "error",
  auth: { status: "unauthenticated" },
};
export const notInstalled: Partial<ServerProvider> = {
  installed: false,
  status: "error",
  auth: { status: "unknown" },
};

export const SETTINGS_FIXTURE = DEFAULT_SERVER_SETTINGS;
