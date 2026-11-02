import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_MODELS,
  notInstalled,
  providerFixture,
  signedOut,
  SETTINGS_FIXTURE,
} from "./providersStep.fixture";
import {
  budgetReachedLabel,
  budgetResetText,
  cheapestModel,
  draftUsageText,
  draftingProviderRows,
  initialDraftingModel,
  parseMonthlyLimit,
  recommendedDraftingModel,
} from "./providersStep.logic";

const claude = providerFixture("claudeAgent");
const codex = providerFixture("codex");
const HAIKU = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };
const LUNA = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" };

describe("recommendedDraftingModel", () => {
  it.each([
    ["Claude and Codex ready: Haiku", [codex, claude], HAIKU],
    ["only Codex ready: its lowest tier", [codex, providerFixture("claudeAgent", signedOut)], LUNA],
    ["no provider ready", [providerFixture("codex", signedOut)], null],
    ["nothing listed yet", null, null],
  ] as const)("%s", (_, providers, expected) => {
    expect(recommendedDraftingModel(providers)).toEqual(expected);
  });

  it("falls back to a cheap name, then the catalog default, when T3 has no text default", () => {
    const renamed = providerFixture("claudeAgent", {
      models: CLAUDE_MODELS.map((model) => ({ ...model, slug: `${model.slug}-preview` })),
    });
    expect(cheapestModel(renamed)?.slug).toBe("claude-haiku-5-5-preview");
    const plain = providerFixture("opencode", {
      models: [
        { slug: "big", name: "Big", isCustom: false, capabilities: {} },
        { slug: "default", name: "Default", isCustom: false, isDefault: true, capabilities: {} },
      ],
    });
    expect(cheapestModel(plain)?.slug).toBe("default");
  });
});

describe("initialDraftingModel", () => {
  const astra = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };

  it("keeps a model the operator chose while it still runs", () => {
    expect(
      initialDraftingModel({ providers: [claude, codex], saved: astra, isDefault: false }),
    ).toEqual(astra);
  });

  it("recommends the cheap one over the untouched settings default or a model that cannot run", () => {
    expect(
      initialDraftingModel({
        providers: [claude, codex],
        saved: SETTINGS_FIXTURE.textGenerationModelSelection,
        isDefault: true,
      }),
    ).toEqual(HAIKU);
    expect(
      initialDraftingModel({
        providers: [claude, providerFixture("codex", signedOut)],
        saved: astra,
        isDefault: false,
      }),
    ).toEqual(HAIKU);
  });
});

describe("draftingProviderRows", () => {
  it("always shows Claude and Codex, and other providers only when enabled", () => {
    const rows = draftingProviderRows([
      providerFixture("opencode", { enabled: false, status: "disabled" }),
      providerFixture("codex", notInstalled),
    ]);
    expect(rows.map((row) => [row.key, row.state])).toEqual([
      ["claudeAgent", "install"],
      ["codex", "install"],
    ]);
    expect(draftingProviderRows(null).map((row) => row.state)).toEqual(["checking", "checking"]);
    expect(
      draftingProviderRows([
        providerFixture("claudeAgent", signedOut),
        providerFixture("opencode"),
      ]).map((row) => [row.key, row.state]),
    ).toEqual([
      ["claudeAgent", "signIn"],
      ["codex", "install"],
      ["opencode", "ready"],
    ]);
  });
});

describe("draft budget texts", () => {
  it.each([
    [
      { monthlyLimit: 600, usedThisMonth: 12, month: "2026-11" },
      "Este mes: 12 de 600 redacciones. El conteo vuelve a cero el 1 de diciembre.",
    ],
    [
      { monthlyLimit: 0, usedThisMonth: 1, month: "2026-11" },
      "Este mes: 1 tendencia redactada, sin tope.",
    ],
    [
      { monthlyLimit: 600, usedThisMonth: 600, month: "2026-12" },
      "Tope alcanzado: 600 de 600 este mes. La redacción se reanuda el 1 de enero.",
    ],
  ] as const)("%o", (budget, text) => {
    expect(draftUsageText(budget)).toBe(text);
  });

  it("names the cap on the bulk button and the month it resets", () => {
    expect(budgetReachedLabel({ monthlyLimit: 600, usedThisMonth: 600, month: "2026-11" })).toBe(
      "Tope mensual alcanzado (600/600)",
    );
    expect(budgetResetText("bad")).toBe("");
  });

  it.each([
    ["600", 600],
    [" 0 ", 0],
    ["100000", 100_000],
    ["100001", null],
    ["-1", null],
    ["1.5", null],
    ["", null],
  ] as const)("parses %o", (text, value) => {
    expect(parseMonthlyLimit(text)).toBe(value);
  });
});
