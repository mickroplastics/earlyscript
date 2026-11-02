import type {
  EditorialNightlySettings,
  EditorialNightlySettingsUpdateInput,
} from "@t3tools/contracts";
import { ArrowLeftIcon, ArrowRightIcon, RotateCwIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { useAtomCommand } from "../../state/use-atom-command";
import { FirstRunPanel, useFirstRun } from "../FirstRunCard";
import { firstRunView, type FirstRunView } from "../firstRun.logic";
import { editorialJobsEnvironment } from "../jobsState";
import { failureText, nextRunText } from "../settings/NightlyRunSettings";
import {
  MODEL_MISSING_TEXT,
  engineStepAcceptance,
  scheduleText,
  type EngineStepAcceptance,
} from "./engineStep.logic";
import { ModelDownloadCard } from "./ModelDownloadCard";
import type { OnboardingStepProps } from "./steps";

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export interface EngineStepViewProps {
  readonly settings: EditorialNightlySettings | null;
  readonly loadError: string | null;
  /** The model card; the wired step passes `ModelDownloadCard`. */
  readonly model: ReactNode;
  readonly modelReady: boolean;
  readonly run: FirstRunView;
  readonly starting: boolean;
  readonly runError: string | null;
  /** True once a job was started here or one already exists. */
  readonly firstRunStarted: boolean;
  /** A setting change is still on its way to the server: «Continuar» waits for it. */
  readonly saving: boolean;
  /** Why the last change was not saved; «Continuar» stays off until a change saves. */
  readonly saveError: string | null;
  readonly onRetrySave: () => void;
  readonly onChange: (patch: EditorialNightlySettingsUpdateInput) => void;
  readonly onRun: () => void;
  readonly onRetry: () => void;
  readonly onBack: (() => void) | null;
  readonly onContinue: (acceptance: EngineStepAcceptance) => void;
}

/** The step without its RPC wiring: what the browser test renders. */
export function EngineStepView({
  settings,
  loadError,
  model,
  modelReady,
  run,
  starting,
  runError,
  firstRunStarted,
  saving,
  saveError,
  onRetrySave,
  onChange,
  onRun,
  onRetry,
  onBack,
  onContinue,
}: EngineStepViewProps) {
  const canContinue = settings !== null && !saving && saveError === null;
  return (
    <div className="flex min-h-0 flex-col" data-testid="engine-step">
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Motor y nocturna</h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        El motor de tendencias corre en esta máquina con un modelo local. Elige si corre solo cada
        noche y, si quieres, lanza ya la primera corrida.
      </p>

      <ScrollArea scrollFade className="mt-4 h-auto max-h-[min(34rem,56dvh)]">
        <div className="flex flex-col gap-6 pr-3 pb-1">
          <Section title="Modelo local">{model}</Section>

          <Section title="Corrida nocturna">
            {settings === null ? (
              loadError === null ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <span aria-hidden className="flex">
                    <Spinner size="sm" tone="muted" />
                  </span>
                  Cargando la corrida nocturna…
                </p>
              ) : (
                <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                  <p className="text-error-foreground">
                    No se pudo leer la corrida nocturna: {loadError}
                  </p>
                  <Button size="xs" variant="outline" onClick={onRetry}>
                    <RotateCwIcon aria-hidden />
                    Reintentar
                  </Button>
                </div>
              )
            ) : (
              <>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">Activar la corrida nocturna</span>
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      Cada noche captura las fuentes activas, agrupa sus publicaciones en
                      tendencias, importa la corrida y la redacta. Cada corrida queda registrada en
                      Ajustes › Editorial.
                    </span>
                  </div>
                  <Switch
                    className="mt-0.5 shrink-0"
                    checked={settings.enabled}
                    onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
                    aria-label="Activar la corrida nocturna"
                  />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm text-foreground">Hora</span>
                    <span className="text-xs text-muted-foreground" data-testid="engine-schedule">
                      {scheduleText(settings.timeOfDay, settings.timezone)}
                    </span>
                  </div>
                  <Input
                    nativeInput
                    size="sm"
                    type="time"
                    className="w-32 shrink-0"
                    aria-label="Hora de la corrida nocturna"
                    value={settings.timeOfDay}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (/^\d{2}:\d{2}$/.test(value) && value !== settings.timeOfDay) {
                        onChange({ timeOfDay: value });
                      }
                    }}
                  />
                </div>
                {settings.enabled && !saving ? (
                  <p className="text-xs text-muted-foreground">{nextRunText(settings)}</p>
                ) : null}
                {saveError !== null ? (
                  <div role="alert" className="flex flex-col items-start gap-2 text-xs">
                    <p className="text-error-foreground">
                      No se guardó la corrida nocturna: {saveError}
                    </p>
                    <Button size="xs" variant="outline" onClick={onRetrySave}>
                      <RotateCwIcon aria-hidden />
                      Reintentar
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </Section>

          <Section title="Primera corrida">
            <FirstRunPanel
              bare
              view={run}
              starting={starting}
              error={runError}
              onRun={onRun}
              runLabel="Ejecutar la primera corrida ahora"
              doneNote={
                run.kind === "done" && run.job.artifacts.dossiers !== null
                  ? `${run.job.artifacts.dossiers} ${run.job.artifacts.dossiers === 1 ? "tendencia nueva" : "tendencias nuevas"} en la bandeja de Tendencias.`
                  : "Sus tendencias están en la bandeja de Tendencias."
              }
              blockedReason={modelReady ? null : MODEL_MISSING_TEXT}
              footer={
                run.kind === "idle" || run.kind === "running" ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {run.kind === "idle"
                      ? "La primera procesa todo el corpus y puede tardar. No hace falta esperar: puedes terminar el asistente y seguir el progreso en Tendencias."
                      : "Puedes terminar el asistente: el progreso sigue en Tendencias."}
                  </p>
                ) : null
              }
            />
          </Section>
        </div>
      </ScrollArea>

      <div className="mt-5 flex items-center justify-between gap-2">
        {onBack ? (
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeftIcon className="size-3.5" />
            Atrás
          </Button>
        ) : (
          <span />
        )}
        <Button
          disabled={!canContinue}
          onClick={() => {
            if (settings !== null && canContinue) {
              onContinue(engineStepAcceptance(settings, { firstRunStarted, modelReady }));
            }
          }}
        >
          {saving ? (
            <>
              <span aria-hidden className="flex">
                <Spinner size="sm" />
              </span>
              Guardando…
            </>
          ) : (
            <>
              Continuar
              <ArrowRightIcon className="size-3.5" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * Step 4 of the first-run wizard on the given environment, which runs the jobs. Each change
 * saves at once; the switch and the time show it while it travels, and the acceptance is
 * built only from what the server confirmed.
 */
export function EngineStep({ environmentId, onContinue, onBack }: OnboardingStepProps) {
  const update = useAtomCommand(editorialJobsEnvironment.updateSettings, { reportFailure: false });
  const firstRun = useFirstRun(environmentId);
  const settings = firstRun.settings;
  const [modelReady, setModelReady] = useState(false);
  const [startedHere, setStartedHere] = useState(false);
  // What the server answered last; its query refetches after each save and may lag.
  const [confirmed, setConfirmed] = useState<EditorialNightlySettings | null>(null);
  // Changes still in flight, merged, shown over the confirmed settings.
  const [pending, setPending] = useState<EditorialNightlySettingsUpdateInput | null>(null);
  const inFlight = useRef(0);
  const [saveError, setSaveError] = useState<{
    readonly message: string;
    readonly patch: EditorialNightlySettingsUpdateInput;
  } | null>(null);
  const run = firstRunView({
    active: firstRun.active,
    latest: firstRun.latest,
    emptyRun: false,
    jobsKnown: firstRun.jobsKnown,
  });
  const server = confirmed ?? settings.data;
  const shown = server === null ? null : { ...server, ...pending };
  const save = (patch: EditorialNightlySettingsUpdateInput) => {
    setSaveError(null);
    setPending((current) => ({ ...current, ...patch }));
    inFlight.current += 1;
    void update({ environmentId, input: patch }).then((result) => {
      inFlight.current -= 1;
      if (result._tag === "Failure") {
        setSaveError({ message: failureText(result), patch });
      } else {
        setConfirmed(result.value);
      }
      if (inFlight.current === 0) setPending(null);
    });
  };
  return (
    <EngineStepView
      settings={shown}
      loadError={settings.error}
      model={<ModelDownloadCard environmentId={environmentId} onReady={setModelReady} />}
      modelReady={modelReady}
      run={run}
      starting={firstRun.starting}
      runError={firstRun.error}
      firstRunStarted={startedHere || run.kind !== "idle"}
      saving={pending !== null}
      saveError={saveError?.message ?? null}
      onRetrySave={() => {
        if (saveError !== null) save(saveError.patch);
      }}
      onChange={save}
      onRun={() =>
        void firstRun.start().then((started) => {
          if (started) setStartedHere(true);
        })
      }
      onRetry={settings.refresh}
      onBack={onBack}
      onContinue={(acceptance) => onContinue({ ...acceptance })}
    />
  );
}
