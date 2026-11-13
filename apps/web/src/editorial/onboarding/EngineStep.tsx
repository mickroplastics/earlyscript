import type {
  EditorialNightlySettings,
  EditorialNightlySettingsUpdateInput,
} from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { useFirstRun } from "../FirstRunCard";
import { ReviewPhaseList, usePhaseNotes, type PhaseNotes } from "../FirstReviewPhases";
import {
  firstRunView,
  minuteClockMs,
  nextReviewText,
  reviewFailure,
  type FirstRunView,
} from "../firstRun.logic";
import { durationText, editorialJobsEnvironment } from "../jobsState";
import { failureText, nextRunText } from "../settings/NightlyRunSettings";
import { engineStepAcceptance, type EngineStepAcceptance } from "./engineStep.logic";
import { modelCardPhase } from "../engineState";
import { ModelRowView, useModelDownload } from "./ModelDownloadCard";
import type { OnboardingStepProps } from "./steps";
import { SectionLabel, StepLayout, StepSection } from "./wizardLayout";

/** What the model is doing, for the label of «Terminar». */
export type ModelProgress = "ready" | "downloading" | "missing";

export interface EngineStepViewProps {
  readonly settings: EditorialNightlySettings | null;
  readonly loadError: string | null;
  /** The model row; the wired step passes `ModelRowView` over the pushed state. */
  readonly model: ReactNode;
  readonly modelProgress: ModelProgress;
  readonly run: FirstRunView;
  /** This is the first review of the server: once it is done there is no way back. */
  readonly first: boolean;
  readonly starting: boolean;
  readonly runError: string | null;
  /** True once a job was started here or one already exists. */
  readonly firstRunStarted: boolean;
  /** A setting change is still on its way to the server: «Terminar» waits for it. */
  readonly saving: boolean;
  /** Why the last change was not saved; «Terminar» stays off until a change saves. */
  readonly saveError: string | null;
  readonly notes: PhaseNotes;
  /** Epoch ms of the minute clock, for the elapsed time and the next review. */
  readonly nowMs: number;
  readonly onRetrySave: () => void;
  readonly onChange: (patch: EditorialNightlySettingsUpdateInput) => void;
  /** Starts the review again after a failure, or for the first time. */
  readonly onRun: () => void;
  readonly onRetry: () => void;
  readonly onBack: (() => void) | null;
  readonly onContinue: (acceptance: EngineStepAcceptance) => void;
}

const ASIDE_LABEL: Readonly<
  Record<FirstRunView["kind"], { text: string; tone: "accent" | "success" | "error" }>
> = {
  idle: { text: "Qué pasa cada noche", tone: "accent" },
  running: { text: "Ahora mismo", tone: "accent" },
  done: { text: "Terminada", tone: "success" },
  failed: { text: "Se detuvo aquí", tone: "error" },
  empty: { text: "Terminada sin tendencias", tone: "accent" },
};

function FailureBox({
  run,
  starting,
  onRun,
}: {
  readonly run: Extract<FirstRunView, { kind: "failed" }>;
  readonly starting: boolean;
  readonly onRun: () => void;
}) {
  const failure = reviewFailure(run.job);
  const [open, setOpen] = useState(false);
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-error/32 bg-error-surface px-4 py-3"
    >
      <p className="flex items-start gap-2.5 text-sm text-foreground">
        <span aria-hidden className="font-bold text-error-foreground">
          !
        </span>
        <span>{failure.headline}</span>
      </p>
      {failure.kept === null ? null : (
        <p className="pl-5 text-xs text-muted-foreground">{failure.kept}</p>
      )}
      <div className="flex flex-wrap items-center gap-3 pl-5">
        <Button size="sm" variant="outline" disabled={starting} onClick={onRun}>
          {starting ? <Spinner size="sm" /> : <RotateCwIcon aria-hidden />}
          Reintentar
        </Button>
        {failure.technical.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
            Detalle técnico
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="ml-5 flex flex-col gap-1 font-mono text-2xs leading-relaxed break-words text-muted-foreground">
          {failure.technical.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** «Primera revisión»: how it goes, under the nightly settings. */
function RunSummary({
  run,
  first,
  starting,
  runError,
  settings,
  nowMs,
  onRun,
}: {
  readonly run: FirstRunView;
  readonly first: boolean;
  readonly starting: boolean;
  readonly runError: string | null;
  readonly settings: EditorialNightlySettings | null;
  readonly nowMs: number;
  readonly onRun: () => void;
}) {
  if (run.kind === "idle" && !starting && runError === null) return null;
  const next = settings === null ? null : nextReviewText(settings, nowMs);
  const body = (() => {
    if (run.kind === "idle") {
      return runError === null ? (
        <p className="flex items-center gap-2 text-sm text-foreground" role="status">
          <Spinner size="sm" />
          Empezando…
        </p>
      ) : (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p className="text-error-foreground">{runError}</p>
          <Button size="sm" variant="outline" disabled={starting} onClick={onRun}>
            <RotateCwIcon aria-hidden />
            Reintentar
          </Button>
        </div>
      );
    }
    switch (run.kind) {
      case "running": {
        // The clock ticks by the minute: below one the time would read «0 s».
        const elapsed =
          run.job.startedAt === null || nowMs - Date.parse(run.job.startedAt) < 60_000
            ? null
            : durationText(run.job.startedAt, new Date(nowMs).toISOString());
        return (
          <p className="text-sm text-foreground" role="status">
            En marcha{elapsed === null ? "" : ` · ${elapsed}`}
          </p>
        );
      }
      case "done": {
        const count = run.job.artifacts.dossiers;
        return (
          <div className="flex flex-col gap-1.5" role="status">
            <p className="text-sm text-success-foreground">
              Lista
              {count === null ? "" : ` · ${count} ${count === 1 ? "tendencia" : "tendencias"}`}
            </p>
            {next === null ? null : (
              <p className="text-xs text-muted-foreground">La próxima, {next}.</p>
            )}
          </div>
        );
      }
      case "failed":
        return <FailureBox run={run} starting={starting} onRun={onRun} />;
      case "empty":
        return (
          <div className="flex flex-col gap-1.5 text-xs text-muted-foreground" role="status">
            <p className="text-sm text-foreground">Terminó sin tendencias nuevas.</p>
            {run.messages.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        );
    }
  })();
  return <StepSection label={first ? "Primera revisión" : "Última revisión"}>{body}</StepSection>;
}

function FinishButton({
  run,
  first,
  modelProgress,
  disabled,
  saving,
  nightly,
  onFinish,
}: {
  readonly run: FirstRunView;
  readonly first: boolean;
  readonly modelProgress: ModelProgress;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly nightly: boolean;
  readonly onFinish: () => void;
}) {
  if (saving) {
    return (
      <Button disabled>
        <span aria-hidden className="flex">
          <Spinner size="sm" />
        </span>
        Guardando…
      </Button>
    );
  }
  if (run.kind === "failed") {
    return (
      <div className="flex items-center gap-3">
        {nightly ? (
          <span className="text-xs text-muted-foreground">
            Si terminas, se reintenta esta noche.
          </span>
        ) : null}
        <Button variant="outline" disabled={disabled} onClick={onFinish}>
          Terminar igual
        </Button>
      </div>
    );
  }
  const label =
    run.kind === "done" && first
      ? "Ver mis tendencias"
      : run.kind === "running"
        ? "Terminar y ver el progreso"
        : run.kind === "idle" && modelProgress === "downloading"
          ? "Terminar y buscar al acabar la descarga"
          : "Terminar";
  return (
    <Button disabled={disabled} onClick={onFinish}>
      {label}
    </Button>
  );
}

/** The step without its RPC wiring: what the browser test renders. */
export function EngineStepView({
  settings,
  loadError,
  model,
  modelProgress,
  run,
  first,
  starting,
  runError,
  firstRunStarted,
  saving,
  saveError,
  notes,
  nowMs,
  onRetrySave,
  onChange,
  onRun,
  onRetry,
  onBack,
  onContinue,
}: EngineStepViewProps) {
  const canContinue = settings !== null && !saving && saveError === null;
  const aside = ASIDE_LABEL[run.kind];
  const finishedFirst = first && run.kind === "done";
  return (
    <StepLayout
      testId="engine-step"
      title="Revisión nocturna"
      description="Busca tendencias mientras duermes; por la mañana están en tu bandeja."
      aside={
        <div className="flex flex-col gap-2">
          <SectionLabel tone={aside.tone}>{aside.text}</SectionLabel>
          <ReviewPhaseList job={run.kind === "idle" ? null : run.job} notes={notes} />
        </div>
      }
      footer={
        <>
          {onBack && !finishedFirst ? (
            <Button variant="ghost" onClick={onBack}>
              <ArrowLeftIcon className="size-3.5" />
              Atrás
            </Button>
          ) : (
            <span />
          )}
          <FinishButton
            run={run}
            first={first}
            modelProgress={modelProgress}
            disabled={!canContinue}
            saving={saving}
            nightly={settings?.enabled === true}
            onFinish={() => {
              if (settings !== null && canContinue) {
                onContinue(
                  engineStepAcceptance(settings, {
                    firstRunStarted,
                    modelReady: modelProgress === "ready",
                  }),
                );
              }
            }}
          />
        </>
      }
    >
      {model}

      <StepSection label="Cada noche">
        {settings === null ? (
          loadError === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <span aria-hidden className="flex">
                <Spinner size="sm" tone="muted" />
              </span>
              Cargando la revisión nocturna…
            </p>
          ) : (
            <div role="alert" className="flex flex-col items-start gap-2 text-sm">
              <p className="text-error-foreground">
                No se pudo leer la revisión nocturna: {loadError}
              </p>
              <Button size="xs" variant="outline" onClick={onRetry}>
                <RotateCwIcon aria-hidden />
                Reintentar
              </Button>
            </div>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Switch
                checked={settings.enabled}
                onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
                aria-label="Revisión nocturna"
              />
              <label htmlFor="earlyscript-nightly-time" className="text-sm text-foreground">
                Revisar a las
              </label>
              <Input
                id="earlyscript-nightly-time"
                nativeInput
                type="time"
                className="w-24"
                value={settings.timeOfDay}
                onChange={(event) => {
                  const value = event.target.value;
                  if (/^\d{2}:\d{2}$/.test(value) && value !== settings.timeOfDay) {
                    onChange({ timeOfDay: value });
                  }
                }}
              />
              <span className="text-xs text-muted-foreground" data-testid="engine-schedule">
                {settings.timezone}
              </span>
            </div>
            {settings.enabled && !saving ? (
              <p className="text-xs text-muted-foreground">{nextRunText(settings)}</p>
            ) : null}
            {saveError !== null ? (
              <div role="alert" className="flex flex-col items-start gap-2 text-xs">
                <p className="text-error-foreground">
                  No se guardó la revisión nocturna: {saveError}
                </p>
                <Button size="xs" variant="outline" onClick={onRetrySave}>
                  <RotateCwIcon aria-hidden />
                  Reintentar
                </Button>
              </div>
            ) : null}
          </>
        )}
      </StepSection>

      <RunSummary
        run={run}
        first={first}
        starting={starting}
        runError={runError}
        settings={settings}
        nowMs={nowMs}
        onRun={onRun}
      />
    </StepLayout>
  );
}

/**
 * Step 4 of the first-run wizard on the given environment, which runs the jobs. Each change
 * saves at once; the switch and the time show it while it travels, and the acceptance is
 * built only from what the server confirmed. The first review starts by itself as soon as the
 * local model is on disk.
 */
export function EngineStep({
  environmentId,
  onContinue,
  onBack,
  onLeaveHidden,
}: OnboardingStepProps) {
  const update = useAtomCommand(editorialJobsEnvironment.updateSettings, { reportFailure: false });
  const firstRun = useFirstRun(environmentId);
  const settings = firstRun.settings;
  const model = useModelDownload(environmentId);
  const phase = modelCardPhase(model.state)._tag;
  const modelProgress: ModelProgress = model.ready
    ? "ready"
    : phase === "downloading" || phase === "verifying"
      ? "downloading"
      : "missing";
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
  const first = firstRun.jobCount <= 1;
  const notes = usePhaseNotes(environmentId, run.kind === "idle" ? null : run.job);
  const nowMs = minuteClockMs(useNowMinute());
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
  const start = () =>
    void firstRun.start().then((started) => {
      if (started) setStartedHere(true);
    });

  const autoStarted = useRef(false);
  const shouldStart =
    model.ready && firstRun.jobsKnown && run.kind === "idle" && !firstRun.starting;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the first review starts by itself once the pushed model state says the model is on disk
  useEffect(() => {
    if (!shouldStart || autoStarted.current) return;
    autoStarted.current = true;
    start();
  }, [shouldStart, start]);

  const leaveHidden = first && run.kind === "done";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the wizard header that «Seguir más tarde» no longer applies once the first review is done
  useEffect(() => {
    onLeaveHidden?.(leaveHidden);
  }, [leaveHidden, onLeaveHidden]);

  return (
    <EngineStepView
      settings={shown}
      loadError={settings.error}
      model={
        <ModelRowView
          state={model.state}
          starting={model.starting}
          requestError={model.requestError}
          onDownload={model.onDownload}
        />
      }
      modelProgress={modelProgress}
      run={run}
      first={first}
      starting={firstRun.starting}
      runError={firstRun.error}
      firstRunStarted={startedHere || run.kind !== "idle"}
      saving={pending !== null}
      saveError={saveError?.message ?? null}
      notes={notes}
      nowMs={nowMs}
      onRetrySave={() => {
        if (saveError !== null) save(saveError.patch);
      }}
      onChange={save}
      onRun={start}
      onRetry={settings.refresh}
      onBack={onBack}
      onContinue={(acceptance) => onContinue({ ...acceptance })}
    />
  );
}
