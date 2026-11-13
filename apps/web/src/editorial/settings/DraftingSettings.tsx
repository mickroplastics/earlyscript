import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  isDraftBudgetReached,
  ProviderInstanceId,
  type EditorialDraftBudget,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { useState } from "react";

import { Link } from "@tanstack/react-router";

import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { SettingsPageContainer, SettingsRow } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  budgetResetText,
  cheapestModel,
  disabledDraftingModelText,
  draftingModelLabel,
  isUsableSelection,
  parseMonthlyLimit,
  readyDraftingProviders,
  recommendedDraftingModel,
} from "../onboarding/providersStep.logic";
import { presentationEnvironment } from "../presentationState";
import { EDITORIAL_DRAFTING_SECTION_ID } from "./settingsEntry";
import { NoEnvironment, SettingsPageHeader } from "./SettingsPageHeader";

const KEY_SEPARATOR = "\u0000";
const keyOf = (selection: { readonly instanceId: string; readonly model: string }) =>
  `${selection.instanceId}${KEY_SEPARATOR}${selection.model}`;

/** The selection's model and provider names, as the selector shows them. */
/** Models of the providers ready to draft, by provider; the cheapest one marked. */
export function DraftingModelSelect({
  providers,
  value,
  onChange,
  disabled = false,
}: {
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly value: ModelSelection | null;
  readonly onChange: (selection: ModelSelection) => void;
  readonly disabled?: boolean;
}) {
  const ready = readyDraftingProviders(providers);
  const recommended = recommendedDraftingModel(providers);
  return (
    <Select
      value={value === null ? "" : keyOf(value)}
      disabled={disabled || ready.length === 0}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === "") return;
        const [instanceId, model] = next.split(KEY_SEPARATOR);
        if (instanceId && model)
          onChange({ instanceId: ProviderInstanceId.make(instanceId), model });
      }}
    >
      <SelectTrigger size="sm" aria-label="Modelo de redacción" className="w-full min-w-0 sm:w-72">
        <SelectValue>
          {() => (
            <span className="block min-w-0 truncate">
              {value === null
                ? providers === null
                  ? "Comprobando proveedores…"
                  : ready.length === 0
                    ? "Ningún proveedor listo"
                    : "Elige un modelo"
                : draftingModelLabel(providers, value)}
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {ready.map((provider) => {
          const cheap = cheapestModel(provider);
          return (
            <SelectGroup key={provider.instanceId}>
              <SelectGroupLabel>{provider.displayName ?? provider.driver}</SelectGroupLabel>
              {provider.models
                .filter((model) => model.isLegacy !== true)
                .map((model) => {
                  const selection = { instanceId: provider.instanceId, model: model.slug };
                  const isRecommended =
                    recommended !== null && keyOf(recommended) === keyOf(selection);
                  return (
                    <SelectItem key={model.slug} value={keyOf(selection)}>
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="max-w-[min(28rem,calc(100vw-9rem))] whitespace-normal break-words">
                          {model.name}
                        </span>
                        {isRecommended ? (
                          <span className="shrink-0 text-muted-foreground text-xs">
                            recomendado
                          </span>
                        ) : cheap?.slug === model.slug ? (
                          <span className="shrink-0 text-muted-foreground text-xs">
                            el más barato
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  );
                })}
            </SelectGroup>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

/** Commits on blur or Enter; a value out of range goes back to the saved one. */
function MonthlyLimitInput({
  value,
  onCommit,
  disabled = false,
  invalid = false,
}: {
  readonly value: number;
  readonly onCommit: (limit: number) => void;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = parseMonthlyLimit(draft);
    setDraft(null);
    if (parsed !== null && parsed !== value) onCommit(parsed);
  };
  return (
    <Input
      nativeInput
      size="sm"
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      className="w-28"
      aria-label="Tope mensual de redacciones"
      disabled={disabled}
      value={draft ?? String(value)}
      aria-invalid={invalid || (draft !== null && parseMonthlyLimit(draft) === null)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** A save that did not go through: what was tried, so «Reintentar» can send it again. */
export interface FailedSave<A> {
  readonly value: A;
  readonly message: string;
}

export interface DraftingSettingsViewProps {
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly selection: ModelSelection | null;
  readonly budget: EditorialDraftBudget | null;
  readonly budgetError: string | null;
  readonly modelFailure: FailedSave<ModelSelection> | null;
  readonly limitFailure: FailedSave<number> | null;
  readonly onModelChange: (selection: ModelSelection) => void;
  readonly onLimitChange: (limit: number) => void;
}

function NotSaved({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <span role="alert" className="mt-2 flex flex-wrap items-center gap-2">
      <Badge size="sm" variant="error">
        No se guardó
      </Badge>
      <span className="text-destructive-foreground">{message}</span>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Reintentar
      </Button>
    </span>
  );
}

function usageLine(budget: EditorialDraftBudget): string {
  const reset = budgetResetText(budget.month);
  if (budget.monthlyLimit === 0) return `${budget.usedThisMonth} este mes, sin tope`;
  if (isDraftBudgetReached(budget)) {
    return `Tope alcanzado: ${budget.usedThisMonth} de ${budget.monthlyLimit}. Se reanuda el ${reset}`;
  }
  return `${budget.usedThisMonth} de ${budget.monthlyLimit} este mes · se reinicia el ${reset}`;
}

export function DraftingSettingsView({
  providers,
  selection,
  budget,
  budgetError,
  modelFailure,
  limitFailure,
  onModelChange,
  onLimitChange,
}: DraftingSettingsViewProps) {
  const usable = selection !== null && isUsableSelection(providers, selection);
  const ready = readyDraftingProviders(providers);
  const noProvider = providers !== null && ready.length === 0;
  const disabledText = disabledDraftingModelText(providers, selection);
  const recommended = recommendedDraftingModel(providers);
  return (
    <section id={EDITORIAL_DRAFTING_SECTION_ID} tabIndex={-1} className="space-y-4 outline-none">
      <SettingsPageHeader
        title="Redacción"
        description="Cada noche la app escribe el título y el resumen de las tendencias nuevas."
      />
      <SettingsGroup>
        <SettingsRow
          title="Modelo"
          description="Uno rápido basta para títulos y resúmenes. Los guiones usan el que elijas en cada hilo."
          status={
            disabledText !== null ? (
              <span className="flex flex-col items-start gap-1.5">
                <span className="text-warning-foreground">{disabledText}</span>
                {recommended === null ? null : (
                  <Button size="xs" variant="outline" onClick={() => onModelChange(recommended)}>
                    Usar el recomendado
                  </Button>
                )}
              </span>
            ) : noProvider ? (
              "Ningún proveedor tiene sesión iniciada; las tendencias se ven con sus términos mientras tanto."
            ) : selection !== null && !usable ? (
              `${draftingModelLabel(providers, selection)} no está disponible ahora; elige otro.`
            ) : modelFailure !== null ? (
              <NotSaved
                message={modelFailure.message}
                onRetry={() => onModelChange(modelFailure.value)}
              />
            ) : undefined
          }
          control={
            <DraftingModelSelect
              providers={providers}
              value={usable ? selection : null}
              onChange={onModelChange}
            />
          }
        />
        <SettingsRow
          title="Tope mensual"
          description="Tendencias redactadas al mes. Claude y Codex se pagan por suscripción, así que el tope cuenta tendencias, no dinero. 0 quita el tope."
          status={
            budget === null ? (
              (budgetError ?? "Cargando el uso del mes…")
            ) : (
              <span className="block space-y-1.5">
                {budget.monthlyLimit === 0 ? null : (
                  <span
                    aria-hidden
                    className="block h-1 w-full max-w-64 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        isDraftBudgetReached(budget) ? "bg-destructive" : "bg-info",
                      )}
                      style={{
                        width: `${Math.min(100, Math.round((budget.usedThisMonth / budget.monthlyLimit) * 100))}%`,
                      }}
                    />
                  </span>
                )}
                <span
                  className={cn("block", isDraftBudgetReached(budget) && "text-warning-foreground")}
                >
                  {usageLine(budget)}
                </span>
                {limitFailure === null ? null : (
                  <NotSaved
                    message={`Sigue el tope de ${budget.monthlyLimit}.`}
                    onRetry={() => onLimitChange(limitFailure.value)}
                  />
                )}
              </span>
            )
          }
          control={
            <MonthlyLimitInput
              value={budget?.monthlyLimit ?? 0}
              disabled={budget === null}
              invalid={limitFailure !== null}
              onCommit={onLimitChange}
            />
          }
        />
        <SettingsRow
          title="Proveedores"
          description={
            providers === null
              ? "Comprobando…"
              : ready.length === 0
                ? "Ninguno con sesión iniciada"
                : ready
                    .map(
                      (provider) =>
                        `${provider.displayName ?? provider.driver} con sesión iniciada`,
                    )
                    .join(" · ")
          }
          control={
            <Button size="xs" variant="ghost" render={<Link to="/settings/providers" />}>
              Ajustes › Proveedores
            </Button>
          }
        />
      </SettingsGroup>
    </section>
  );
}

const BUDGET_ERROR_TEXT: Readonly<Record<string, string>> = {
  unavailable: "Este servidor no tiene activada la redacción.",
  "storage-failed": "La base editorial no respondió.",
};

function errorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const text = BUDGET_ERROR_TEXT[String(error.reason)];
    if (text) return text;
  }
  return error instanceof Error ? error.message : "Error desconocido.";
}

function failureText(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag === "Success") return "";
  if (isAtomCommandInterrupted(result)) return "Se canceló.";
  return errorText(squashAtomCommandFailure(result));
}

/** Saving the drafting model and the monthly cap, shared by Settings and the wizard. */
export function useDraftingSettings(environmentId: EnvironmentId) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const budget = useEnvironmentQuery(presentationEnvironment.budget({ environmentId, input: {} }));
  const quiet = { reportFailure: false } as const;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, quiet);
  const updateBudget = useAtomCommand(presentationEnvironment.updateBudget, quiet);
  return {
    providers: providers ?? null,
    saved: config?.settings.textGenerationModelSelection ?? null,
    budget: budget.data,
    /** In the operator's words; the query's own text is the transport's, in English. */
    budgetError:
      budget.error === null
        ? null
        : budget.failure === null
          ? "El servidor no respondió."
          : errorText(budget.failure),
    retryBudget: budget.refresh,
    /** Resolves to an error text, or null once saved. */
    saveModel: async (selection: ModelSelection) => {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            textGenerationModelSelection: {
              instanceId: selection.instanceId,
              model: selection.model,
            },
          },
        },
      });
      return result._tag === "Success" ? null : failureText(result);
    },
    saveLimit: async (monthlyLimit: number) => {
      const result = await updateBudget({ environmentId, input: { monthlyLimit } });
      return result._tag === "Success" ? null : failureText(result);
    },
  };
}

function DraftingSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const drafting = useDraftingSettings(environmentId);
  const [modelFailure, setModelFailure] = useState<FailedSave<ModelSelection> | null>(null);
  const [limitFailure, setLimitFailure] = useState<FailedSave<number> | null>(null);
  return (
    <DraftingSettingsView
      providers={drafting.providers}
      selection={drafting.saved}
      budget={drafting.budget}
      budgetError={drafting.budgetError}
      modelFailure={modelFailure}
      limitFailure={limitFailure}
      onModelChange={(selection) =>
        void drafting.saveModel(selection).then((error) => {
          setModelFailure(error === null ? null : { value: selection, message: error });
        })
      }
      onLimitChange={(limit) =>
        void drafting.saveLimit(limit).then((error) => {
          setLimitFailure(error === null ? null : { value: limit, message: error });
        })
      }
    />
  );
}

/** Settings › Editorial › Redacción, on the primary environment, which drafts the trends. */
export function DraftingSettingsPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return <NoEnvironment />;
  return (
    <SettingsPageContainer>
      <DraftingSettingsForEnvironment environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
