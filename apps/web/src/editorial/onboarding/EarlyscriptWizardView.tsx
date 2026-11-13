import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { EnvironmentId } from "@t3tools/contracts";
import { EarlyscriptBrand } from "@t3tools/shared/earlyscriptBrand";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

import { Button } from "../../components/ui/button";
import { Dialog, DialogPopup } from "../../components/ui/dialog";
import { cn } from "../../lib/utils";
import { makeTranslator, useScopedLocale, type ScopedLocaleOptions } from "../locale/scopedLocale";
import { DataConsentStep } from "./DataConsentStep";
import { EngineStep } from "./EngineStep";
import { EXAMPLE_TREND } from "./onboardingExamples";
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

const STEP_COMPONENTS: OnboardingStepComponents = {
  datos: DataConsentStep,
  proveedores: ProvidersStep,
  estudio: StudioStep,
  motor: EngineStep,
};

// Inner controls (selects, dialogs) may carry upstream's English accessible names.
const WIZARD_LOCALE: ScopedLocaleOptions = {
  translate: makeTranslator([{ text: { Close: "Cerrar" }, patterns: [] }]),
  roots: (anchor) => [anchor.closest('[data-slot="dialog-popup"]') ?? anchor],
  skip: "[contenteditable], input, textarea, pre, code, kbd",
  attributes: ["aria-label"],
};

export type RecordResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type OnboardingStepComponents = Readonly<
  Record<OnboardingStepId, ComponentType<OnboardingStepProps>>
>;

/** Where the wizard opens: the welcome screen, or a step reached before («Seguimos…»). */
export type WizardEntry =
  | { readonly _tag: "welcome" }
  | { readonly _tag: "resume"; readonly position: WizardPosition };

export interface EarlyscriptWizardViewProps {
  /** The local server's environment; null when this client has none. */
  readonly environmentId: EnvironmentId | null;
  readonly entry: WizardEntry;
  /**
   * The wizard was finished before (reopened from Settings): leaving only closes it. Otherwise
   * it reads «Seguir más tarde» and the sidebar offers to finish later.
   */
  readonly finishedBefore: boolean;
  readonly onRecord: (
    step: OnboardingStepId,
    acceptance: Readonly<Record<string, unknown>>,
  ) => Promise<RecordResult>;
  /** After the last step is recorded. Resolves false when finishing failed. */
  readonly onFinish: () => Promise<boolean>;
  /** Close without finishing, or enter without a local server. */
  readonly onLeave: () => void;
  /** The step components; the real ones by default. Tests of the shell pass doubles. */
  readonly steps?: OnboardingStepComponents;
}

export function EarlyscriptWizardView({
  environmentId,
  entry,
  finishedBefore,
  onRecord,
  onFinish,
  onLeave,
  steps = STEP_COMPONENTS,
}: EarlyscriptWizardViewProps) {
  const [welcome, setWelcome] = useState(entry._tag === "welcome");
  const [resumed, setResumed] = useState(entry._tag === "resume");
  const [position, setPosition] = useState<WizardPosition>(
    entry._tag === "resume" ? entry.position : WIZARD_START,
  );
  const [error, setError] = useState<string | null>(null);
  const [leaveHidden, setLeaveHidden] = useState(false);
  const busy = useRef(false);
  // State, not a ref: the popup mounts in a portal after this component's first effect.
  const [localeAnchor, setLocaleAnchor] = useState<HTMLSpanElement | null>(null);
  useScopedLocale(localeAnchor, WIZARD_LOCALE);

  // Focus lands on the step's title, not on its first control; each step mounts at its top.
  const stepTitle = useRef<HTMLHeadingElement>(null);
  const stage = ONBOARDING_STAGES[position.index]!;
  const shownIndex = useRef(welcome ? -1 : position.index);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves keyboard focus to the title of the step that just mounted, forward or back, instead of leaving it on the header
  useEffect(() => {
    if (welcome || shownIndex.current === position.index) return;
    shownIndex.current = position.index;
    stepTitle.current?.focus({ preventScroll: true });
  }, [position.index, welcome]);
  const Step = steps[stage.id];

  const move = (next: WizardPosition) => {
    setError(null);
    setResumed(false);
    setLeaveHidden(false);
    setPosition(next);
  };

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
        else if (outcome._tag === "moved") move(outcome.position);
        else await onFinish();
      })
      .finally(() => {
        busy.current = false;
      });
  };

  const leaveLabel = finishedBefore ? "Cerrar" : "Seguir más tarde";
  // The last step is shorter: a lower dialog keeps its two columns from floating in space.
  const short = !welcome && stage.id === "motor";

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(_, event) => {
        event.cancel();
        // Never finished: only «Seguir más tarde» leaves, so a stray Escape cannot.
        if (event.reason === "escape-key" && finishedBefore && !leaveHidden) onLeave();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        initialFocus={() => stepTitle.current ?? true}
        className={cn(
          "w-[min(62.5rem,calc(100vw-2rem))] max-w-none overflow-hidden",
          welcome
            ? "h-auto"
            : short
              ? "h-[min(39rem,calc(100dvh-2rem))]"
              : "h-[min(48.25rem,calc(100dvh-2rem))]",
        )}
      >
        <span ref={setLocaleAnchor} hidden data-earlyscript-locale="wizard" />
        {welcome ? (
          <WelcomeScreen
            leaveLabel={leaveLabel}
            onLeave={onLeave}
            onStart={() => {
              setWelcome(false);
              shownIndex.current = -1;
            }}
          />
        ) : (
          <>
            <header className="shrink-0 border-b px-6 pt-4 pb-3.5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-center gap-2.5">
                  <img
                    src={EarlyscriptBrand.webIconPath}
                    alt=""
                    aria-hidden
                    className="size-6 shrink-0 rounded-md"
                  />
                  <DialogPrimitive.Title className="truncate text-sm font-semibold text-foreground">
                    Configurar {EarlyscriptBrand.productName}
                  </DialogPrimitive.Title>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                  <span data-testid="wizard-step-caption">
                    Paso {position.index + 1} de {ONBOARDING_STAGES.length}
                  </span>
                  {leaveHidden ? null : (
                    <>
                      <span aria-hidden className="text-muted-foreground/40">
                        ·
                      </span>
                      <button
                        type="button"
                        className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        onClick={onLeave}
                      >
                        {leaveLabel}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <StepBars
                current={position.index}
                reached={position.reached}
                disabled={environmentId === null}
                onSelect={(index) => move(wizardGoTo(position, index))}
              />
              {resumed ? (
                <p role="status" className="mt-2.5 flex items-center gap-1.5 text-xs text-success">
                  <CheckIcon aria-hidden className="size-3.5" />
                  Seguimos donde lo dejaste.
                </p>
              ) : null}
            </header>

            {environmentId === null ? (
              <NoLocalServer onLeave={onLeave} />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <h2
                  ref={stepTitle}
                  tabIndex={-1}
                  className="sr-only"
                  data-testid="wizard-step-title"
                >
                  Paso {position.index + 1} de {ONBOARDING_STAGES.length}: {stage.label}
                </h2>
                {error === null ? null : (
                  <p
                    role="alert"
                    className="mx-6 mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive-foreground text-sm"
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
                  onLeaveHidden={setLeaveHidden}
                />
              </div>
            )}
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

/** Four bars with their labels: done in green, the current one in the accent colour. */
function StepBars({
  current,
  reached,
  disabled,
  onSelect,
}: {
  readonly current: number;
  readonly reached: number;
  readonly disabled: boolean;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <ol aria-label="Pasos del asistente" className="mt-3.5 grid grid-cols-4 gap-2">
      {ONBOARDING_STAGES.map((stage, index) => {
        const isCurrent = index === current;
        const done = index < reached && !isCurrent;
        return (
          <li key={stage.id} className="min-w-0">
            <button
              type="button"
              disabled={disabled || index > reached || isCurrent}
              aria-current={isCurrent ? "step" : undefined}
              aria-label={`${stage.label}, paso ${index + 1}${done ? ", hecho" : ""}`}
              onClick={() => onSelect(index)}
              className="group flex w-full min-w-0 flex-col gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
            >
              <span
                aria-hidden
                className={cn(
                  "h-[3px] w-full rounded-full",
                  isCurrent ? "bg-primary" : done ? "bg-success" : "bg-foreground/10",
                )}
              />
              <span
                className={cn(
                  "flex min-w-0 items-center gap-1.5 truncate text-xs",
                  isCurrent
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground group-enabled:group-hover:text-foreground",
                )}
              >
                {done ? <CheckIcon aria-hidden className="size-3 shrink-0 text-success" /> : null}
                <span className="truncate">{stage.label}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Signal bars of a trend's growth, as the inbox draws them. */
function GrowthBars() {
  return (
    <span aria-hidden className="flex h-4 items-end gap-0.5">
      {[10, 12, 14, 16].map((height) => (
        <span key={height} className="w-[3px] rounded-xs bg-primary" style={{ height }} />
      ))}
    </span>
  );
}

function WelcomeScreen({
  leaveLabel,
  onLeave,
  onStart,
}: {
  readonly leaveLabel: string;
  readonly onLeave: () => void;
  readonly onStart: () => void;
}) {
  return (
    <div className="relative flex flex-col" data-testid="wizard-welcome">
      <button
        type="button"
        onClick={onLeave}
        className="absolute end-6 top-4 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {leaveLabel}
      </button>
      <div className="flex flex-col items-center px-8 pt-11 pb-12 text-center">
        <img src={EarlyscriptBrand.webIconPath} alt="" aria-hidden className="size-10 rounded-lg" />
        <DialogPrimitive.Title className="mt-6 max-w-xl text-3xl leading-tight font-bold tracking-tight text-foreground">
          Cada mañana, los temas que se mueven en tu nicho
        </DialogPrimitive.Title>
        <p className="mt-3 max-w-md text-base leading-relaxed text-muted-foreground">
          Por la noche se revisan fuentes públicas; por la mañana eliges qué tendencia convertir en
          video.
        </p>
        <figure className="mt-8 w-full max-w-lg rounded-xl border bg-card px-4 py-3.5 text-left">
          <figcaption className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            Así llega una tendencia
            <GrowthBars />
          </figcaption>
          <p className="mt-2 text-sm font-semibold leading-snug text-foreground">
            {EXAMPLE_TREND.title}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {EXAMPLE_TREND.posts} publicaciones · {EXAMPLE_TREND.sources}
          </p>
        </figure>
        <p className="mt-8 text-sm text-muted-foreground">
          Cuatro pasos: tus datos · asistente de IA · tu canal · revisión nocturna
        </p>
      </div>
      <div className="flex items-center justify-between gap-3 border-t px-6 py-3.5">
        <p className="text-sm text-muted-foreground">Todo se puede cambiar después en Ajustes.</p>
        <Button size="lg" autoFocus onClick={onStart}>
          Empezar
        </Button>
      </div>
    </div>
  );
}

function NoLocalServer({ onLeave }: { readonly onLeave: () => void }) {
  return (
    <div className="flex flex-col gap-4 px-6 py-6" data-testid="wizard-no-local-server">
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
