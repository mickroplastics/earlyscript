import type { EnvironmentId } from "@t3tools/contracts";
import { EarlyscriptBrand } from "@t3tools/shared/earlyscriptBrand";
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../../components/ui/wizard";
import { makeTranslator, useScopedLocale, type ScopedLocaleOptions } from "../locale/scopedLocale";
import { PrivacyNote } from "./DataHandlingDialog";
import { DataConsentStep } from "./DataConsentStep";
import { EngineStep } from "./EngineStep";
import { ProvidersStep } from "./ProvidersStep";
import { ONBOARDING_STAGES, type OnboardingStepId, type OnboardingStepProps } from "./steps";
import { StudioStep } from "./StudioStep";
import {
  WIZARD_START,
  acceptStep,
  wizardBack,
  wizardGoTo,
  type WizardPosition,
} from "./wizardNavigation";

const STEP_COMPONENTS: Readonly<Record<OnboardingStepId, ComponentType<OnboardingStepProps>>> = {
  datos: DataConsentStep,
  proveedores: ProvidersStep,
  estudio: StudioStep,
  motor: EngineStep,
};

const STAGE_LABELS = ONBOARDING_STAGES.map((stage) => stage.label);

// `WizardSteps` and the dialog's close button carry English accessible names.
const WIZARD_LOCALE: ScopedLocaleOptions = {
  translate: makeTranslator([
    {
      text: { "Setup progress": "Progreso del asistente", Close: "Cerrar" },
      patterns: [[/^(.+), step (\d+)(, .+)?$/, "$1, paso $2$3"]],
    },
  ]),
  roots: (anchor) => [anchor.closest('[data-slot="dialog-popup"]') ?? anchor],
  skip: "[contenteditable], input, textarea, pre, code, kbd",
  attributes: ["aria-label"],
};

export type RecordResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface EarlyscriptWizardViewProps {
  /** The local server's environment; null when this client has none. */
  readonly environmentId: EnvironmentId | null;
  /** Reopened from Settings: the operator may close it without finishing. */
  readonly dismissible: boolean;
  readonly onRecord: (
    step: OnboardingStepId,
    acceptance: Readonly<Record<string, unknown>>,
  ) => Promise<RecordResult>;
  /** After the last step is recorded. Resolves false when finishing failed. */
  readonly onFinish: () => Promise<boolean>;
  /** Close without finishing, or enter without a local server. */
  readonly onLeave: () => void;
}

export function EarlyscriptWizardView({
  environmentId,
  dismissible,
  onRecord,
  onFinish,
  onLeave,
}: EarlyscriptWizardViewProps) {
  const [position, setPosition] = useState<WizardPosition>(WIZARD_START);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // State, not a ref: the popup mounts in a portal after this component's first effect.
  const [localeAnchor, setLocaleAnchor] = useState<HTMLSpanElement | null>(null);
  useScopedLocale(localeAnchor, WIZARD_LOCALE);

  const panel = useRef<HTMLDivElement>(null);
  const stage = ONBOARDING_STAGES[position.index]!;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves keyboard focus into the step that just mounted, instead of leaving it on the header or the body
  useEffect(() => {
    if (position.index > 0) focusFirstControl(panel.current);
  }, [position.index]);
  const Step = STEP_COMPONENTS[stage.id];

  const onContinue = (acceptance: Readonly<Record<string, unknown>>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    void acceptStep({
      position,
      total: ONBOARDING_STAGES.length,
      record: () => onRecord(stage.id, acceptance),
    })
      .then(async (outcome) => {
        if (outcome._tag === "failed") setError(outcome.error);
        else if (outcome._tag === "moved") setPosition(outcome.position);
        else await onFinish();
      })
      .finally(() => {
        busy.current = false;
      });
  };

  const move = (next: WizardPosition) => {
    setError(null);
    setPosition(next);
  };

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(_, event) => {
        event.cancel();
        if (dismissible && (event.reason === "close-press" || event.reason === "escape-key")) {
          onLeave();
        }
      }}
    >
      <WizardPopup
        size="wide"
        bottomStickOnMobile={false}
        showCloseButton={dismissible}
        initialFocus={() => firstControl(panel.current) ?? true}
      >
        <span ref={setLocaleAnchor} hidden data-earlyscript-locale="wizard" />
        <WizardHeader
          title={`Configurar ${EarlyscriptBrand.productName}`}
          identity={
            <div className="flex items-baseline gap-1.5" role="img" aria-label="Earlyscript">
              <span className="text-2xl font-medium tracking-tight text-foreground">
                {EarlyscriptBrand.productName}
              </span>
            </div>
          }
        >
          <WizardSteps
            steps={STAGE_LABELS}
            currentStep={position.index}
            isStepDisabled={(index) => environmentId === null || index > position.reached}
            onStepChange={(index) => move(wizardGoTo(position, index))}
          />
          <p className="text-muted-foreground text-sm sm:hidden" data-testid="wizard-step-caption">
            Paso {position.index + 1} de {ONBOARDING_STAGES.length}: {stage.label}
          </p>
        </WizardHeader>

        <WizardPanel>
          {environmentId === null ? (
            <NoLocalServer onLeave={onLeave} />
          ) : (
            <div ref={panel} className="flex flex-col gap-4">
              {error === null ? null : (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive-foreground text-sm"
                >
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                  <span>No se guardó tu decisión: {error} Vuelve a intentarlo.</span>
                </p>
              )}
              <Step
                key={stage.id}
                environmentId={environmentId}
                onContinue={onContinue}
                onBack={position.index === 0 ? null : () => move(wizardBack(position))}
              />
            </div>
          )}
        </WizardPanel>

        <div className="px-6 py-4">
          <PrivacyNote />
        </div>
      </WizardPopup>
    </Dialog>
  );
}

const FOCUSABLE =
  "button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])";

function firstControl(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
}

function focusFirstControl(root: HTMLElement | null) {
  firstControl(root)?.focus();
}

function NoLocalServer({ onLeave }: { readonly onLeave: () => void }) {
  return (
    <div className="flex flex-col gap-4" data-testid="wizard-no-local-server">
      <div className="flex items-start gap-2 text-sm">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">
            Este navegador no está conectado al servidor local de Earlyscript.
          </p>
          <p className="text-muted-foreground">
            El asistente guarda tus decisiones en el servidor de esta máquina. Abre Earlyscript en
            la máquina donde corre, o entra igual y vuelve al asistente desde Ajustes › Editorial.
          </p>
        </div>
      </div>
      <Button className="self-end" variant="outline" onClick={onLeave}>
        Entrar sin configurar
      </Button>
    </div>
  );
}
