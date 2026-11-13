import {
  EDITORIAL_DRAFT_BUDGET_DEFAULT,
  isDraftBudgetReached,
  type EditorialDraftBudget,
  type ExecutionEnvironmentPlatformOs,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ArrowDownIcon, ArrowLeftIcon, CheckIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  resolveOnboardingProviderInstallCommand,
  resolveOnboardingProviderLoginCommand,
} from "../../onboarding/providerReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DraftingModelSelect, useDraftingSettings } from "../settings/DraftingSettings";
import { EXAMPLE_TREND, NIGHTLY_DRAFTS } from "./onboardingExamples";
import {
  draftUsageText,
  draftingProviderRows,
  disabledDraftingModelText,
  initialDraftingModel,
  isDefaultDraftingModel,
  isUsableSelection,
  parseMonthlyLimit,
  type DraftingProviderRow,
  type ProviderReadiness,
} from "./providersStep.logic";
import type { OnboardingStepProps } from "./steps";
import { SectionLabel, StepLayout } from "./wizardLayout";

const STATE_TEXT: Readonly<Record<ProviderReadiness, string>> = {
  ready: "Con sesión iniciada",
  signIn: "Instalado, sin sesión",
  install: "No instalado",
  checking: "Comprobando…",
  disabled: "Desactivado en Ajustes",
  attention: "Instalado, pero no responde",
};

/** What the operator runs in a terminal to install or sign in, or null when nothing applies. */
/** The sign-in command once installed, with the binary T3 runs by default. */
const DEFAULT_LOGIN_COMMAND: Readonly<Record<string, string>> = {
  claudeAgent: "claude auth login",
  codex: "codex login",
};

function providerSetupCommand(
  row: DraftingProviderRow,
  settings: ServerSettings | null,
  os: ExecutionEnvironmentPlatformOs,
): string | null {
  if (row.state === "signIn" && row.provider !== undefined && settings !== null) {
    return resolveOnboardingProviderLoginCommand(row.provider, settings, os);
  }
  if (row.state === "install" && (row.driver === "claudeAgent" || row.driver === "codex")) {
    return resolveOnboardingProviderInstallCommand(row.driver, os);
  }
  return null;
}

function CommandLine({ command }: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1500, target: "command" });
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-sm">
      <code className="min-w-0 flex-1 select-all break-all">{command}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copiar la orden"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** The terminal stays off in Earlyscript, so sign-in is a command the operator runs. */
function ProviderSetupDialog({
  row,
  command,
  checking,
  onRecheck,
  onClose,
}: {
  readonly row: DraftingProviderRow;
  readonly command: string;
  readonly checking: boolean;
  readonly onRecheck: () => void;
  readonly onClose: () => void;
}) {
  const installing = row.state === "install";
  const login = installing ? DEFAULT_LOGIN_COMMAND[row.driver] : undefined;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {installing ? `Instalar ${row.displayName}` : `Iniciar sesión en ${row.displayName}`}
          </DialogTitle>
          <DialogDescription>
            {installing
              ? "Ejecuta estas dos órdenes en una terminal de esta máquina: la primera instala, la segunda abre el inicio de sesión en el navegador. Luego pulsa «Volver a comprobar»."
              : "Ejecuta esta orden en una terminal de esta máquina y sigue sus pasos en el navegador. Luego pulsa «Volver a comprobar»."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <CommandLine command={command} />
            {login === undefined ? null : <CommandLine command={login} />}
            <p role="status" className="text-muted-foreground text-sm">
              {checking ? "Comprobando…" : `Estado: ${STATE_TEXT[row.state]}`}
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {row.state === "ready" ? "Listo" : "Cerrar"}
          </Button>
          <Button variant="outline" disabled={checking} onClick={onRecheck}>
            {checking ? <Spinner size="sm" /> : null}
            Volver a comprobar
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ProviderRow({
  row,
  hasCommand,
  onSetup,
}: {
  readonly row: DraftingProviderRow;
  readonly hasCommand: boolean;
  readonly onSetup: () => void;
}) {
  return (
    <li className="flex min-h-12 items-center gap-3 px-3.5 py-2" data-provider-state={row.state}>
      <span className="w-28 shrink-0 truncate text-sm text-foreground">{row.displayName}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {STATE_TEXT[row.state]}
      </span>
      <span className="shrink-0">
        {row.state === "ready" ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-success-foreground">
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            Listo
          </span>
        ) : row.state === "checking" ? (
          <Spinner size="sm" />
        ) : hasCommand ? (
          <Button size="sm" variant="outline" onClick={onSetup}>
            {row.state === "install" ? "Instalar" : "Iniciar sesión"}
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/** What the assistant does, on the right: the same trend before and after it drafts. */
function DraftingExample({ anyReady }: { readonly anyReady: boolean }) {
  return (
    <div className="flex flex-col" data-testid="providers-example">
      <SectionLabel tone="accent">Qué hace por ti</SectionLabel>
      <div className="mt-3 rounded-lg border bg-background px-4 py-3">
        <p className="text-xs text-muted-foreground">Sin asistente</p>
        <p className="mt-1.5 font-mono text-xs text-foreground">{EXAMPLE_TREND.rawLabel}</p>
      </div>
      <ArrowDownIcon aria-hidden className="mx-auto my-1.5 size-3.5 text-muted-foreground" />
      <div className="rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
        <p className="text-xs text-primary">Con asistente</p>
        <p className="mt-1.5 text-sm font-semibold leading-snug text-foreground">
          {EXAMPLE_TREND.title}
        </p>
      </div>
      <p
        className={`mt-5 text-xs leading-relaxed ${anyReady ? "text-muted-foreground" : "text-warning-foreground"}`}
      >
        {anyReady
          ? "Si llegas al tope, las tendencias siguen llegando, sin título."
          : "Puedes seguir sin asistente: las tendencias llegarán como la de arriba, sin título."}
      </p>
    </div>
  );
}

export interface ProvidersStepViewProps {
  readonly providers: ReadonlyArray<ServerProvider> | null;
  readonly settings: ServerSettings | null;
  readonly os: ExecutionEnvironmentPlatformOs;
  readonly budget: EditorialDraftBudget | null;
  /** The cap could not be read: the step says so and leaves the saved cap untouched. */
  readonly budgetError: string | null;
  readonly onRetryBudget: () => void;
  readonly checking: boolean;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onRecheck: () => void;
  readonly onBack: (() => void) | null;
  readonly onContinue: (choice: {
    readonly rows: ReadonlyArray<DraftingProviderRow>;
    readonly draftingModel: ModelSelection | null;
    /** Null when the saved cap is unknown; nothing is written then. */
    readonly monthlyDraftLimit: number | null;
  }) => void;
}

export function ProvidersStepView({
  providers,
  settings,
  os,
  budget,
  budgetError,
  onRetryBudget,
  checking,
  saving,
  error,
  onRecheck,
  onBack,
  onContinue,
}: ProvidersStepViewProps) {
  const id = useId();
  const rows = draftingProviderRows(providers);
  const [setupKey, setSetupKey] = useState<string | null>(null);
  const [choice, setChoice] = useState<ModelSelection | null>(null);
  const [limitText, setLimitText] = useState<string | null>(null);

  const saved = settings?.textGenerationModelSelection ?? null;
  const proposed =
    saved === null
      ? null
      : initialDraftingModel({ providers, saved, isDefault: isDefaultDraftingModel(saved) });
  const model = choice !== null && isUsableSelection(providers, choice) ? choice : proposed;
  // The proposal above already skips a disabled provider; this says why the saved one changed.
  const savedDisabledText = choice === null ? disabledDraftingModelText(providers, saved) : null;
  const anyReady = rows.some((row) => row.state === "ready");
  // Nothing is decided before the server has said which providers it has and what cap it keeps;
  // a cap that failed to load is left as saved instead of being overwritten with a guess.
  const loadingBudget = budget === null && budgetError === null;
  const loading = providers === null || loadingBudget;
  const capKnown = budget !== null;
  const savedLimit = budget?.monthlyLimit ?? EDITORIAL_DRAFT_BUDGET_DEFAULT;
  const limit = limitText === null ? savedLimit : parseMonthlyLimit(limitText);
  const setupRow = rows.find((row) => row.key === setupKey);
  const setupCommand = setupRow === undefined ? null : providerSetupCommand(setupRow, settings, os);
  const invalidLimit = anyReady && capKnown && limit === null;

  return (
    <StepLayout
      testId="providers-step"
      title="Asistente de IA"
      description="Pone un título claro a cada tendencia y luego te ayuda con el guion."
      aside={<DraftingExample anyReady={anyReady || providers === null} />}
      footer={
        <>
          {onBack ? (
            <Button variant="ghost" onClick={onBack} disabled={saving}>
              <ArrowLeftIcon className="size-3.5" />
              Atrás
            </Button>
          ) : (
            <span />
          )}
          <Button
            autoFocus
            variant={anyReady || loading ? "default" : "outline"}
            disabled={loading || saving || invalidLimit}
            onClick={() => {
              if (invalidLimit) return;
              onContinue({
                rows,
                draftingModel: anyReady ? model : null,
                // Hidden without an assistant, the cap is then the saved one, written back as before.
                monthlyDraftLimit: capKnown ? limit : null,
              });
            }}
          >
            {saving ? (
              <>
                <span aria-hidden className="flex">
                  <Spinner size="sm" />
                </span>
                Guardando…
              </>
            ) : anyReady || loading ? (
              "Continuar"
            ) : (
              "Continuar sin asistente"
            )}
          </Button>
        </>
      }
    >
      <section aria-labelledby={`${id}-providers`} className="flex flex-col gap-2.5">
        <SectionLabel id={`${id}-providers`}>Con qué cuenta</SectionLabel>
        <ul className="divide-y overflow-hidden rounded-lg border bg-background">
          {rows.map((row) => (
            <ProviderRow
              key={row.key}
              row={row}
              hasCommand={providerSetupCommand(row, settings, os) !== null}
              onSetup={() => setSetupKey(row.key)}
            />
          ))}
        </ul>
        {providers !== null && !anyReady ? (
          <>
            <p className="text-xs text-muted-foreground">
              ¿Ya iniciaste sesión?{" "}
              <button
                type="button"
                disabled={checking}
                onClick={onRecheck}
                className="text-foreground underline underline-offset-2 hover:text-primary disabled:opacity-64"
              >
                {checking ? "Comprobando…" : "Volver a comprobar"}
              </button>
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              El modelo que redacta y el tope al mes aparecen al iniciar sesión.
            </p>
          </>
        ) : null}
      </section>

      {anyReady ? (
        <>
          <section className="flex flex-col gap-2" aria-labelledby={`${id}-model`}>
            <SectionLabel id={`${id}-model`}>Modelo que redacta</SectionLabel>
            {savedDisabledText === null ? null : (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertDescription>{savedDisabledText}</AlertDescription>
              </Alert>
            )}
            <DraftingModelSelect
              providers={providers}
              value={model}
              onChange={setChoice}
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">Uno barato basta para títulos.</p>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby={`${id}-limit`}>
            <SectionLabel id={`${id}-limit`}>Tope al mes</SectionLabel>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Input
                aria-labelledby={`${id}-limit`}
                nativeInput
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                className="w-24 text-end"
                disabled={saving || !capKnown}
                aria-invalid={capKnown && limit === null}
                value={capKnown ? (limitText ?? String(savedLimit)) : ""}
                onChange={(event) => setLimitText(event.target.value)}
              />
              <span className="text-sm text-foreground">tendencias redactadas</span>
            </div>
            {loadingBudget ? (
              <span className="text-xs text-muted-foreground">Cargando el tope…</span>
            ) : capKnown && limit === null ? (
              <span className="text-xs text-destructive-foreground">
                Escribe un número entero; 0 quita el tope.
              </span>
            ) : (
              <p className="text-xs text-muted-foreground">
                Cada noche redacta hasta {NIGHTLY_DRAFTS}. 0 quita el tope.
                {budget !== null && budget.usedThisMonth > 0 ? (
                  <span
                    className={`block ${isDraftBudgetReached(budget) ? "text-warning-foreground" : ""}`}
                  >
                    {draftUsageText(budget)}
                  </span>
                ) : null}
              </p>
            )}
            {budgetError === null ? null : (
              <Alert variant="error">
                <TriangleAlertIcon />
                <AlertTitle>No se pudo leer el tope mensual</AlertTitle>
                <AlertDescription>
                  <p>
                    {budgetError} Al continuar se conserva el tope guardado; puedes cambiarlo
                    después en Ajustes.
                  </p>
                  <Button size="xs" variant="outline" className="mt-2" onClick={onRetryBudget}>
                    Reintentar
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </section>
        </>
      ) : null}

      {error === null ? null : (
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertDescription>{error} Vuelve a intentarlo.</AlertDescription>
        </Alert>
      )}

      {setupRow !== undefined && setupCommand !== null ? (
        <ProviderSetupDialog
          row={setupRow}
          command={setupCommand}
          checking={checking}
          onRecheck={onRecheck}
          onClose={() => setSetupKey(null)}
        />
      ) : null}
    </StepLayout>
  );
}

/**
 * Saves what the step decided, then returns the acceptance the shell records. The cap is written
 * only when the step knew the saved one; an unknown cap stays as it is.
 */
export async function commitProvidersChoice(
  choice: Parameters<ProvidersStepViewProps["onContinue"]>[0],
  save: {
    readonly saveModel: (selection: ModelSelection) => Promise<string | null>;
    readonly saveLimit: (limit: number) => Promise<string | null>;
  },
): Promise<
  | {
      readonly ok: true;
      readonly acceptance: {
        readonly providers: ReadonlyArray<{ readonly id: string; readonly ready: boolean }>;
        readonly draftingModel: ModelSelection | null;
        readonly monthlyDraftLimit: number | null;
      };
    }
  | { readonly ok: false; readonly error: string }
> {
  const { rows, draftingModel, monthlyDraftLimit } = choice;
  const modelError = draftingModel === null ? null : await save.saveModel(draftingModel);
  const error =
    modelError ?? (monthlyDraftLimit === null ? null : await save.saveLimit(monthlyDraftLimit));
  if (error !== null) return { ok: false, error };
  return {
    ok: true,
    acceptance: {
      providers: rows.map((row) => ({ id: row.key, ready: row.state === "ready" })),
      draftingModel,
      monthlyDraftLimit,
    },
  };
}

/** Step 2 of the first-run wizard: who drafts, with which model, and how much per month. */
export function ProvidersStep({ environmentId, onContinue, onBack }: OnboardingStepProps) {
  const drafting = useDraftingSettings(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recheck = () => {
    setChecking(true);
    void refreshProviders({ environmentId, input: {} }).finally(() => setChecking(false));
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to probe its providers once when the step opens, as upstream's agents step does
  useEffect(() => {
    void refreshProviders({ environmentId, input: {} });
  }, [environmentId, refreshProviders]);

  return (
    <ProvidersStepView
      providers={drafting.providers}
      settings={config?.settings ?? null}
      os={config?.environment.platform.os ?? "linux"}
      budget={drafting.budget}
      budgetError={drafting.budgetError}
      onRetryBudget={drafting.retryBudget}
      checking={checking}
      saving={saving}
      error={error}
      onRecheck={recheck}
      onBack={onBack}
      onContinue={(choice) => {
        setSaving(true);
        setError(null);
        void commitProvidersChoice(choice, drafting).then((result) => {
          setSaving(false);
          if (result.ok) onContinue(result.acceptance);
          else setError(`No se guardó: ${result.error}`);
        });
      }}
    />
  );
}
