import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  EDITORIAL_DRAFT_BUDGET_MAX,
  isDraftBudgetReached,
  ProviderDriverKind,
  type EditorialDraftBudget,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

import { getOnboardingProviderState } from "../../onboarding/providerReadiness.logic";

export type ProviderReadiness = ReturnType<typeof getOnboardingProviderState>;

/** The two providers a script studio is set up with; others show only when enabled. */
const PRIMARY_DRAFTING_DRIVERS = ["claudeAgent", "codex"] as const;

export interface DraftingProviderRow {
  /** Instance id, or the driver when this server has no instance of a primary driver. */
  readonly key: string;
  readonly driver: string;
  readonly displayName: string;
  readonly state: ProviderReadiness;
  /** Undefined for a primary driver this server does not list. */
  readonly provider: ServerProvider | undefined;
}

const DRIVER_NAMES: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

const drafts = (provider: ServerProvider) => provider.supportsTextGeneration !== false;

/**
 * One row per enabled provider that can draft, Claude and Codex first and always present: a
 * missing one shows as not installed once the list has loaded (`null` while it loads).
 */
export function draftingProviderRows(
  providers: ReadonlyArray<ServerProvider> | null,
): ReadonlyArray<DraftingProviderRow> {
  const listed = (providers ?? []).filter(drafts);
  const rowOf = (provider: ServerProvider): DraftingProviderRow => ({
    key: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName?.trim() || DRIVER_NAMES[provider.driver] || provider.driver,
    state: getOnboardingProviderState(provider),
    provider,
  });
  const primary = PRIMARY_DRAFTING_DRIVERS.flatMap((driver): ReadonlyArray<DraftingProviderRow> => {
    const instances = listed.filter((provider) => provider.driver === driver);
    if (instances.length > 0) return instances.map(rowOf);
    return [
      {
        key: driver,
        driver,
        displayName: DRIVER_NAMES[driver]!,
        state: providers === null ? "checking" : "install",
        provider: undefined,
      },
    ];
  });
  const others = listed
    .filter(
      (provider) =>
        !(PRIMARY_DRAFTING_DRIVERS as ReadonlyArray<string>).includes(provider.driver) &&
        provider.enabled,
    )
    .map(rowOf);
  return [...primary, ...others];
}

/** Model names that mark a provider's cheap tier when the catalog has no text default. */
const CHEAP_NAME = /haiku|luna|nano|mini|flash|lite/i;

const offers = (model: ServerProviderModel, slug: string) =>
  model.slug === slug || (model.aliases ?? []).includes(slug);

/**
 * The provider's cheapest model: the cheap text-generation default T3 already picks for titles
 * (Haiku for Claude, the lowest tier for Codex) when the catalog offers it, then a cheap tier by
 * name, then the catalog default.
 */
export function cheapestModel(provider: ServerProvider): ServerProviderModel | undefined {
  const models = provider.models.filter((model) => model.isLegacy !== true);
  const preferred =
    DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[ProviderDriverKind.make(provider.driver)];
  return (
    (preferred === undefined ? undefined : models.find((model) => offers(model, preferred))) ??
    models.find((model) => CHEAP_NAME.test(model.slug) || CHEAP_NAME.test(model.name)) ??
    models.find((model) => model.isDefault === true) ??
    models[0]
  );
}

const DRIVER_ORDER: ReadonlyArray<string> = PRIMARY_DRAFTING_DRIVERS;
const driverRank = (driver: string) => {
  const index = DRIVER_ORDER.indexOf(driver);
  return index === -1 ? DRIVER_ORDER.length : index;
};

/** Providers ready to draft, Claude first, then Codex, then the rest in server order. */
export function readyDraftingProviders(
  providers: ReadonlyArray<ServerProvider> | null,
): ReadonlyArray<ServerProvider> {
  return (providers ?? [])
    .filter((provider) => drafts(provider) && getOnboardingProviderState(provider) === "ready")
    .map((provider, index) => ({ provider, index }))
    .toSorted(
      (left, right) =>
        driverRank(left.provider.driver) - driverRank(right.provider.driver) ||
        left.index - right.index,
    )
    .map(({ provider }) => provider);
}

/** The cheapest model of the first provider ready to draft, or null when none is. */
export function recommendedDraftingModel(
  providers: ReadonlyArray<ServerProvider> | null,
): ModelSelection | null {
  for (const provider of readyDraftingProviders(providers)) {
    const model = cheapestModel(provider);
    if (model !== undefined) return { instanceId: provider.instanceId, model: model.slug };
  }
  return null;
}

/** True when a ready provider lists the selection's model. */
export function isUsableSelection(
  providers: ReadonlyArray<ServerProvider> | null,
  selection: { readonly instanceId: ProviderInstanceId; readonly model: string },
): boolean {
  return readyDraftingProviders(providers).some(
    (provider) =>
      provider.instanceId === selection.instanceId &&
      provider.models.some((model) => offers(model, selection.model)),
  );
}

/** True while the saved model is still the settings default, which the operator never chose. */
export const isDefaultDraftingModel = (selection: ModelSelection): boolean =>
  selection.instanceId === DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId &&
  selection.model === DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model;

/**
 * What the step proposes: the saved model when the operator chose one that still runs, else the
 * recommendation. `isDefault` marks a saved value that is only the settings default, which the
 * operator never chose.
 */
export function initialDraftingModel(input: {
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly saved: ModelSelection;
  readonly isDefault: boolean;
}): ModelSelection | null {
  if (!input.isDefault && isUsableSelection(input.providers, input.saved)) {
    return { instanceId: input.saved.instanceId, model: input.saved.model };
  }
  return recommendedDraftingModel(input.providers);
}

const monthName = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" });

/** "1 de diciembre": when the count of `month` (`YYYY-MM`) starts again. */
export function budgetResetText(month: string): string {
  const [year, index] = month.split("-").map(Number);
  if (year === undefined || index === undefined || !Number.isInteger(year + index)) return "";
  return `1 de ${monthName.format(new Date(Date.UTC(year, index, 1)))}`;
}

/** One line on this month's use of the cap. */
export function draftUsageText(budget: EditorialDraftBudget): string {
  const drafted = `${budget.usedThisMonth} ${budget.usedThisMonth === 1 ? "tendencia redactada" : "tendencias redactadas"}`;
  const reset = budgetResetText(budget.month);
  if (budget.monthlyLimit === 0) return `Este mes: ${drafted}, sin tope.`;
  if (isDraftBudgetReached(budget)) {
    return `Tope alcanzado: ${budget.usedThisMonth} de ${budget.monthlyLimit} este mes. La redacción se reanuda el ${reset}.`;
  }
  return `Este mes: ${budget.usedThisMonth} de ${budget.monthlyLimit} redacciones. El conteo vuelve a cero el ${reset}.`;
}

/** The bulk drafting button while the cap stops it. */
export const budgetReachedLabel = (budget: EditorialDraftBudget): string =>
  `Tope mensual alcanzado (${budget.usedThisMonth}/${budget.monthlyLimit})`;

/** What the cap means, in one line: a count of drafts, not money. */
export const DRAFT_BUDGET_EXPLANATION =
  "Claude y Codex se pagan por suscripción, no por llamada, así que el tope cuenta tendencias redactadas al mes. Una corrida nocturna redacta hasta 40. 0 quita el tope.";

/** Why the recommended model is the cheap one. */
export const DRAFTING_MODEL_EXPLANATION =
  "Las corridas nocturnas redactan todas las tendencias; un modelo barato basta.";

/** The providers' text generation reports no tokens; say so instead of showing zeros. */
export const DRAFT_USAGE_NO_TOKENS = "Tokens: el proveedor no informa el consumo.";

/** A whole number between 0 and the server's maximum, or null. */
export function parseMonthlyLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= EDITORIAL_DRAFT_BUDGET_MAX ? value : null;
}
