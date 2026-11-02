import {
  EDITORIAL_DRAFT_BUDGET_DEFAULT,
  isDraftBudgetReached,
  ProviderDriverKind,
  type EditorialDraftBudget,
  type ExecutionEnvironmentPlatformOs,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, CopyIcon, TerminalIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
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
import {
  DRAFT_BUDGET_EXPLANATION,
  DRAFT_USAGE_NO_TOKENS,
  DRAFTING_MODEL_EXPLANATION,
  draftUsageText,
  draftingProviderRows,
  initialDraftingModel,
  isDefaultDraftingModel,
  isUsableSelection,
  parseMonthlyLimit,
  type DraftingProviderRow,
  type ProviderReadiness,
} from "./providersStep.logic";
import type { OnboardingStepProps } from "./steps";

const STATE_TEXT: Readonly<Record<ProviderReadiness, string>> = {
  ready: "Listo, con sesión iniciada.",
  signIn: "Instalado, sin sesión.",
  install: "No está instalado en esta máquina.",
  checking: "Comprobando…",
  disabled: "Desactivado en Ajustes › Proveedores.",
  attention: "Instalado, pero no responde. Revísalo en Ajustes › Proveedores.",
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
    <li
      className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5"
      data-provider-state={row.state}
    >
      <ProviderInstanceIcon
        driverKind={ProviderDriverKind.make(row.driver)}
        displayName={row.displayName}
        iconClassName="size-5"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground text-sm">{row.displayName}</p>
        <p className="text-muted-foreground text-xs">{STATE_TEXT[row.state]}</p>
      </div>
      <div className="shrink-0">
        {row.state === "ready" ? (
          <span className="inline-flex items-center gap-1 font-medium text-success-foreground text-xs">
            <CheckIcon className="size-3.5" />
            Listo
          </span>
        ) : row.state === "checking" ? (
          <Spinner size="sm" />
        ) : hasCommand ? (
          <Button size="xs" variant="outline" onClick={onSetup}>
            <TerminalIcon />
            {row.state === "install" ? "Instalar" : "Iniciar sesión"}
          </Button>
        ) : null}
      </div>
    </li>
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

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby={`${id}-providers`} className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 id={`${id}-providers`} className="font-medium text-foreground text-sm">
            Proveedores
          </h3>
          <Button size="xs" variant="ghost-muted" disabled={checking} onClick={onRecheck}>
            {checking ? <Spinner size="sm" /> : null}
            Volver a comprobar
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          Earlyscript redacta las tendencias con tu suscripción de Claude o Codex, desde esta
          máquina. Basta con uno.
        </p>
        <ul className="flex flex-col gap-1.5">
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
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Ningún proveedor tiene sesión iniciada</AlertTitle>
            <AlertDescription>
              Puedes continuar igual: las tendencias se verán con sus términos, sin título ni
              resumen redactados, y el hilo manual funciona sin modelo. Conecta uno cuando quieras
              desde Ajustes › Proveedores.
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-model`}>
        <h3 id={`${id}-model`} className="font-medium text-foreground text-sm">
          Modelo de redacción
        </h3>
        <p className="text-muted-foreground text-sm">{DRAFTING_MODEL_EXPLANATION}</p>
        <DraftingModelSelect
          providers={providers}
          value={model}
          onChange={setChoice}
          disabled={saving}
        />
      </section>

      <section className="flex flex-col gap-2" aria-labelledby={`${id}-limit`}>
        <h3 id={`${id}-limit`} className="font-medium text-foreground text-sm">
          Tope mensual de redacciones
        </h3>
        <p className="text-muted-foreground text-sm">{DRAFT_BUDGET_EXPLANATION}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Input
            aria-labelledby={`${id}-limit`}
            nativeInput
            size="sm"
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            className="w-28"
            disabled={saving || !capKnown}
            aria-invalid={capKnown && limit === null}
            value={capKnown ? (limitText ?? String(savedLimit)) : ""}
            onChange={(event) => setLimitText(event.target.value)}
          />
          {loadingBudget ? (
            <span className="text-muted-foreground text-sm">Cargando el tope…</span>
          ) : capKnown && limit === null ? (
            <span className="text-destructive-foreground text-sm">
              Escribe un número entero; 0 quita el tope.
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-0.5 text-muted-foreground text-sm">
          {budget === null ? null : (
            <span className={isDraftBudgetReached(budget) ? "text-warning-foreground" : ""}>
              {draftUsageText(budget)}
            </span>
          )}
          <span>{DRAFT_USAGE_NO_TOKENS}</span>
        </div>
        {budgetError === null ? null : (
          <Alert variant="error">
            <TriangleAlertIcon />
            <AlertTitle>No se pudo leer el tope mensual</AlertTitle>
            <AlertDescription>
              <p>
                {budgetError} Al continuar se conserva el tope guardado; puedes cambiarlo después en
                Ajustes › Editorial.
              </p>
              <Button size="xs" variant="outline" className="mt-2" onClick={onRetryBudget}>
                Reintentar
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </section>

      {error === null ? null : (
        <Alert variant="error">
          <TriangleAlertIcon />
          <AlertDescription>{error} Vuelve a intentarlo.</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {onBack === null ? (
          <span />
        ) : (
          <Button variant="ghost" onClick={onBack} disabled={saving}>
            Atrás
          </Button>
        )}
        <Button
          autoFocus
          disabled={saving || loading || (capKnown && limit === null)}
          onClick={() => {
            if (capKnown && limit === null) return;
            onContinue({
              rows,
              draftingModel: anyReady ? model : null,
              monthlyDraftLimit: capKnown ? limit : null,
            });
          }}
        >
          {saving ? <Spinner size="sm" /> : null}
          {anyReady || loading ? "Continuar" : "Continuar sin proveedor"}
        </Button>
      </div>

      {setupRow !== undefined && setupCommand !== null ? (
        <ProviderSetupDialog
          row={setupRow}
          command={setupCommand}
          checking={checking}
          onRecheck={onRecheck}
          onClose={() => setSetupKey(null)}
        />
      ) : null}
    </div>
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
