import { useAtomValue } from "@effect/atom-react";
import {
  EDITORIAL_JOB_PHASES,
  EDITORIAL_NIGHTLY_MAX_WORKERS,
  type EditorialJob,
  type EditorialJobPhase,
  type EditorialModelState,
  type EditorialNightlySettings,
  type EditorialNightlySettingsUpdateInput,
  type EditorialSourcesView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, LockIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { FoldedSettingsSection } from "../../components/settings/FoldedSettingsSection";
import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { SettingsPageContainer, SettingsRow } from "../../components/settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { editorialEngineEnvironment, formatMiB, MODEL_NAME, modelIsReady } from "../engineState";
import { durationText, editorialJobsEnvironment, JOB_STATUS_LABEL } from "../jobsState";
import { ModelDownloadCard } from "../onboarding/ModelDownloadCard";
import { usePairsModeStore } from "../pairsMode";
import {
  capitalize,
  failureDetail,
  finishedLabel,
  formatCount,
  formatDay,
  localDay,
  relativeDay,
  sameSources,
  STEP_LABEL,
  timeOf,
  trendsText,
  type NightlyState,
} from "./editorialStatus.logic";
import { useNightlyStatus, useRunNow } from "./editorialStatus";
import { TONE_DOT } from "./EditorialStatusStrip";
import {
  EVALUATED_METHOD,
  initialMethod,
  methodChoices,
  methodName,
  methodTag,
  nextNightText,
  nightRows,
  usualDuration,
  type NightRow,
} from "./nightly.logic";
import { settingsFailureText } from "./nightlyText";
import {
  EDITORIAL_METHOD_SECTION_ID,
  EDITORIAL_NIGHTLY_SECTION_ID,
  EDITORIAL_PAIRS_SECTION_ID,
} from "./settingsEntry";
import { NoEnvironment, SettingsPageHeader } from "./SettingsPageHeader";
import { editorialSourcesEnvironment } from "./sourcesState";

export { failureText, nextRunText } from "./nightlyText";

const WORKER_CHOICES = [1, 2, 4, 6, 8, 12, EDITORIAL_NIGHTLY_MAX_WORKERS] as const;
const RECENT_NIGHTS = 5;

/** The five steps of a review as bars: done green, running blue, failed red, the rest empty. */
function StepBar({ job }: { readonly job: EditorialJob }) {
  const byPhase = new Map(job.artifacts.phases.map((phase) => [phase.phase, phase] as const));
  const progress = job.artifacts.progress;
  return (
    <ol aria-label="Pasos de la revisión" className="grid grid-cols-5 gap-2">
      {EDITORIAL_JOB_PHASES.map((name) => {
        const phase: EditorialJobPhase | undefined = byPhase.get(name);
        const status = phase?.status ?? "pending";
        const share =
          status === "running" &&
          progress?.phase === name &&
          progress.done !== null &&
          progress.total !== null &&
          progress.total > 0
            ? progress.done / progress.total
            : 0.5;
        const mark =
          status === "done"
            ? durationText(phase?.startedAt ?? null, phase?.finishedAt ?? null)
            : status === "failed"
              ? "falló"
              : status === "running"
                ? progress?.phase === name && progress.done !== null && progress.total !== null
                  ? `${formatCount(progress.done)} de ${formatCount(progress.total)}`
                  : "en curso"
                : status === "skipped"
                  ? "omitido"
                  : null;
        return (
          <li key={name} className="min-w-0 space-y-1.5">
            <p
              className={cn(
                "flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs",
                status === "failed"
                  ? "text-destructive-foreground"
                  : status === "running"
                    ? "text-info-foreground"
                    : status === "done"
                      ? "text-foreground"
                      : "text-muted-foreground",
              )}
            >
              <span>{STEP_LABEL[name]}</span>
              {mark === null ? null : <span className="text-muted-foreground">{mark}</span>}
            </p>
            <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full",
                  status === "done"
                    ? "w-full bg-success"
                    : status === "failed"
                      ? "w-full bg-destructive"
                      : status === "running"
                        ? "bg-info"
                        : "w-0",
                )}
                style={status === "running" ? { width: `${Math.round(share * 100)}%` } : undefined}
              />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StatusCard({
  environmentId,
  state,
  jobs,
  sources,
  timeZone,
  now,
  starting,
  onRunNow,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: NightlyState;
  readonly jobs: ReadonlyArray<EditorialJob>;
  readonly sources: EditorialSourcesView | null;
  readonly timeZone: string | undefined;
  readonly now: number;
  readonly starting: boolean;
  readonly onRunNow: () => void;
}) {
  const today = localDay(now, timeZone);
  const runButton = (label: string, primary = false) => (
    <Button
      size="sm"
      variant={primary ? "default" : "outline"}
      disabled={starting}
      onClick={onRunNow}
    >
      {starting ? <Spinner size="sm" /> : null}
      {label}
    </Button>
  );
  const trendsLink = (
    <Button
      size="sm"
      render={<Link to="/editorial/$environmentId/trends" params={{ environmentId }} />}
    >
      Ver tendencias
    </Button>
  );
  const lastText = (job: EditorialJob | null) =>
    job === null
      ? "Todavía no hay tendencias."
      : `La última fue ${finishedLabel(job, timeZone, now).toLowerCase()}.`;
  const content = ((): {
    readonly tone: keyof typeof TONE_DOT;
    readonly title: string;
    readonly line: string;
    readonly action: ReactNode;
    readonly job: EditorialJob | null;
    readonly detail: string | null;
  } => {
    switch (state._tag) {
      case "loading":
        return {
          tone: "idle",
          title: "Cargando…",
          line: "",
          action: null,
          job: null,
          detail: null,
        };
      case "running": {
        const started = state.job.startedAt ?? state.job.scheduledFor;
        const usual = usualDuration(jobs);
        return {
          tone: "running",
          title: "Revisando…",
          line: `Empezó a las ${timeOf(started, timeZone)}${usual === null ? "" : ` · suele tardar ${usual}`}`,
          action: null,
          job: state.job,
          detail: null,
        };
      }
      case "failed": {
        const day = relativeDay(localDay(state.job.cutoffAt, "UTC"), today);
        const last = state.lastDone;
        const lastDay = last === null ? null : relativeDay(localDay(last.cutoffAt, "UTC"), today);
        return {
          tone: "error",
          title: day === "hoy" ? "La revisión de hoy falló" : `La revisión del ${day} falló`,
          line:
            last === null || last.artifacts.dossiers === null
              ? "Todavía no hay tendencias."
              : `Siguen disponibles las ${trendsText(last.artifacts.dossiers)} ${lastDay === "hoy" || lastDay === "ayer" ? `de ${lastDay}` : `del ${lastDay}`}.`,
          action: runButton("Reintentar", true),
          job: state.job,
          detail: failureDetail(state.job),
        };
      }
      case "current": {
        const job = state.job;
        const duration = durationText(job.startedAt, job.finishedAt);
        const found =
          job.artifacts.dossiers === null
            ? "terminó"
            : `encontró ${trendsText(job.artifacts.dossiers)}`;
        const at = finishedLabel(job, timeZone, now);
        const changed = !sameSources(job, sources);
        return {
          tone: "ok",
          title: "Al día",
          line: `${/^\d/.test(at) ? `El ${at}` : at.replace(" ", " a las ")} ${found}${duration === null ? "" : ` · tardó ${duration}`}.${changed ? " Las fuentes cambiaron desde entonces." : ""}`,
          action: (
            <div className="flex flex-wrap items-center gap-2">
              {changed ? runButton("Revisar ahora") : null}
              {trendsLink}
            </div>
          ),
          job: null,
          detail: null,
        };
      }
      case "due":
        return {
          tone: "warning",
          title: "Pendiente",
          line: `La revisión de esta noche todavía no corrió. ${lastText(state.lastDone)}`,
          action: runButton("Revisar ahora", true),
          job: null,
          detail: null,
        };
      case "disabled":
        return {
          tone: "idle",
          title: "Revisión desactivada",
          line: lastText(state.lastDone),
          action: runButton("Revisar ahora"),
          job: null,
          detail: null,
        };
      case "none":
        return {
          tone: "idle",
          title: "Todavía no hay revisiones",
          line: "La primera corre a la hora de abajo, o ahora mismo.",
          action: runButton("Revisar ahora", true),
          job: null,
          detail: null,
        };
    }
  })();
  return (
    <div
      role="status"
      className={cn(
        "space-y-4 rounded-xl border bg-card/40 px-4 py-4 shadow-xs/5",
        content.tone === "error"
          ? "border-destructive/40"
          : content.tone === "running"
            ? "border-info/40"
            : "border-border/60",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[content.tone])}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-semibold text-foreground">{content.title}</p>
          {content.line ? <p className="text-sm text-muted-foreground">{content.line}</p> : null}
        </div>
        {content.action}
      </div>
      {content.job === null ? null : <StepBar job={content.job} />}
      {content.detail === null ? null : (
        <p className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-foreground dark:bg-destructive/12">
          {content.detail}
        </p>
      )}
    </div>
  );
}

const NIGHT_MARK: Readonly<Record<NightRow["status"], ReactNode>> = {
  done: (
    <span className="text-success-foreground">
      <CheckIcon aria-hidden className="size-3.5" />
      <span className="sr-only">Hecha</span>
    </span>
  ),
  running: (
    <Badge size="sm" variant="info">
      En curso
    </Badge>
  ),
  failed: (
    <Badge size="sm" variant="error">
      {JOB_STATUS_LABEL.failed}
    </Badge>
  ),
  retrying: (
    <Badge size="sm" variant="error">
      Falló, se reintentará
    </Badge>
  ),
  pending: (
    <Badge size="sm" variant="outline">
      {JOB_STATUS_LABEL.pending}
    </Badge>
  ),
  skipped: (
    <Badge size="sm" variant="outline">
      {JOB_STATUS_LABEL.skipped}
    </Badge>
  ),
};

function NightList({ rows }: { readonly rows: ReadonlyArray<NightRow> }) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, RECENT_NIGHTS);
  return (
    <section aria-labelledby="editorial-nights-title" className="space-y-2">
      <h3
        id="editorial-nights-title"
        className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
      >
        Últimas noches
      </h3>
      <SettingsGroup>
        {rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Todavía no hay revisiones.</p>
        ) : (
          <ol aria-label="Últimas noches" className="divide-y divide-border/50">
            {shown.map((row) => (
              <li
                key={row.key}
                className="grid grid-cols-[6.5rem_9rem_minmax(0,1fr)] items-center gap-3 px-4 py-2.5 text-sm"
              >
                <span className="text-foreground">
                  {row.day}
                  {row.time === null ? null : (
                    <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                      {row.time}
                    </span>
                  )}
                </span>
                <span className="flex">{NIGHT_MARK[row.status]}</span>
                <span className="min-w-0 truncate text-muted-foreground">{row.detail}</span>
              </li>
            ))}
          </ol>
        )}
        {rows.length > RECENT_NIGHTS ? (
          <div className="px-2 py-1.5">
            <Button size="xs" variant="ghost-muted" onClick={() => setShowAll(!showAll)}>
              {showAll
                ? "Mostrar solo las recientes"
                : `Mostrar las ${rows.length - RECENT_NIGHTS} anteriores`}
            </Button>
          </div>
        ) : null}
      </SettingsGroup>
    </section>
  );
}

const chosenFormat = (timeZone: string) =>
  new Intl.DateTimeFormat("es", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

function methodSentence(settings: EditorialNightlySettings): string {
  const name = `${capitalize(methodName(settings.engineConfig))} (${methodTag(settings.engineConfig)})`;
  if (settings.engineConfigChosenAt === null) {
    return `${name}, el que venía por omisión. Cambiarlo solo afecta a las revisiones siguientes y queda registrado.`;
  }
  const when = chosenFormat(settings.timezone).format(new Date(settings.engineConfigChosenAt));
  return `${name}, fijado el ${when}. Cambiarlo solo afecta a las revisiones siguientes y queda registrado.`;
}

function MethodOption({
  file,
  settings,
}: {
  readonly file: string;
  readonly settings: EditorialNightlySettings;
}) {
  const current = file === settings.engineConfig;
  const since =
    current && settings.engineConfigChosenAt !== null
      ? `En uso desde el ${formatDay(localDay(settings.engineConfigChosenAt, settings.timezone))}`
      : current
        ? "En uso"
        : file === EVALUATED_METHOD
          ? "El que se evaluó con revisores"
          : "El que venía por omisión";
  const named = methodTag(file) !== file;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 has-data-checked:border-primary/60 has-data-checked:bg-primary/6",
      )}
    >
      <Radio value={file} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm text-foreground">
          {named ? (
            capitalize(methodName(file).replace(/^el /, ""))
          ) : (
            <code className="font-mono text-xs">{file}</code>
          )}{" "}
          {named ? <span className="text-xs text-muted-foreground">{methodTag(file)}</span> : null}
        </span>
        {named || current ? (
          <span className="block text-xs text-muted-foreground">{since}</span>
        ) : null}
      </span>
    </label>
  );
}

/**
 * How trends are chosen: the evaluated method, pinned. «Cambiar…» opens a dialog on the
 * evaluated method; the setting changes only when the operator confirms another one.
 */
function MethodRow({
  settings,
  onChange,
}: {
  readonly settings: EditorialNightlySettings;
  readonly onChange: (patch: EditorialNightlySettingsUpdateInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => initialMethod(settings));
  const [showOthers, setShowOthers] = useState(false);
  const { named, others } = methodChoices(settings);
  const openDialog = () => {
    setSelected(initialMethod(settings));
    setShowOthers(false);
    setOpen(true);
  };
  return (
    <>
      <SettingsRow
        title="Cómo se eligen las tendencias"
        description={methodSentence(settings)}
        control={
          <div className="flex items-center gap-3">
            {settings.engineConfig === EVALUATED_METHOD ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <LockIcon aria-hidden className="size-3" />
                Fijado
              </span>
            ) : null}
            <Button size="xs" variant="outline" onClick={openDialog}>
              Cambiar…
            </Button>
          </div>
        }
      />
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Cambiar el método que elige tus tendencias?</AlertDialogTitle>
            <AlertDialogDescription>
              Lo ya encontrado no cambia. Las revisiones siguientes y «Revisar ahora» usarán el
              nuevo; si hoy queda una revisión pendiente, se rehace con él. Queda registrado con su
              hora y se puede volver atrás.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-6">
            <RadioGroup
              aria-label="Método"
              value={selected}
              onValueChange={(value) => {
                if (typeof value === "string") setSelected(value);
              }}
            >
              {named.map((file) => (
                <MethodOption key={file} file={file} settings={settings} />
              ))}
              {showOthers
                ? others.map((file) => <MethodOption key={file} file={file} settings={settings} />)
                : null}
            </RadioGroup>
          </div>
          <AlertDialogFooter className="sm:justify-between">
            {others.length > 0 && !showOthers ? (
              <Button size="sm" variant="ghost-muted" onClick={() => setShowOthers(true)}>
                Otras instaladas ({others.length})
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <AlertDialogClose render={<Button size="sm" variant="ghost" />}>
                Cancelar
              </AlertDialogClose>
              <Button
                size="sm"
                disabled={selected === settings.engineConfig}
                onClick={() => {
                  onChange({ engineConfig: selected });
                  setOpen(false);
                }}
              >
                Cambiar
              </Button>
            </div>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function PairsModeRow() {
  const enabled = usePairsModeStore((state) => state.enabled);
  const setEnabled = usePairsModeStore((state) => state.setEnabled);
  return (
    <SettingsGroup>
      <SettingsRow
        id={EDITORIAL_PAIRS_SECTION_ID}
        title="Evaluación a ciegas"
        description="Oculta la opinión de los jueces y de dónde sale cada tendencia, para decidir sin sesgo."
        status={
          enabled
            ? "Activada en esta app (modo pares). Tus decisiones se registran con su hora, como siempre; al apagarla, la opinión de los jueces vuelve solo en las tendencias ya decididas."
            : undefined
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(Boolean(checked))}
            aria-label="Evaluación a ciegas (modo pares)"
          />
        }
      />
    </SettingsGroup>
  );
}

export interface NightlyRunSettingsViewProps {
  readonly environmentId: EnvironmentId;
  readonly settings: EditorialNightlySettings;
  readonly jobs: ReadonlyArray<EditorialJob>;
  readonly active: EditorialJob | null;
  readonly state: NightlyState;
  readonly sources: EditorialSourcesView | null;
  readonly model: EditorialModelState | null;
  readonly now: number;
  readonly starting: boolean;
  readonly onChange: (patch: EditorialNightlySettingsUpdateInput) => void;
  readonly onRunNow: () => void;
  /** The download card, shown while the model is not on disk. */
  readonly modelCard?: ReactNode;
}

export function NightlyRunSettingsView({
  environmentId,
  settings,
  jobs,
  active,
  state,
  sources,
  model,
  now,
  starting,
  onChange,
  onRunNow,
  modelCard,
}: NightlyRunSettingsViewProps) {
  const ready = modelIsReady(model);
  const summary = `${capitalize(methodName(settings.engineConfig).replace(/^el /, ""))} · ${ready ? "modelo local listo" : "falta el modelo local"}`;
  return (
    <>
      <section id={EDITORIAL_NIGHTLY_SECTION_ID} tabIndex={-1} className="space-y-4 outline-none">
        <SettingsPageHeader title="Revisión nocturna" />
        <StatusCard
          environmentId={environmentId}
          state={state}
          jobs={jobs}
          sources={sources}
          timeZone={settings.timezone}
          now={now}
          starting={starting}
          onRunNow={onRunNow}
        />
        <SettingsGroup>
          <SettingsRow
            title="Revisar cada noche"
            description={`${nextNightText(settings, now)} Solo con el equipo encendido; si una noche se pierde, la siguiente captura lo que faltó.`}
            control={
              <div className="flex items-center gap-3">
                <Input
                  nativeInput
                  size="sm"
                  type="time"
                  className="w-28"
                  aria-label="Hora de la revisión nocturna"
                  value={settings.timeOfDay}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (/^\d{2}:\d{2}$/.test(value) && value !== settings.timeOfDay) {
                      onChange({ timeOfDay: value });
                    }
                  }}
                />
                <Switch
                  checked={settings.enabled}
                  onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
                  aria-label="Revisar cada noche"
                />
              </div>
            }
          />
        </SettingsGroup>
      </section>
      <NightList rows={nightRows(jobs, active, settings.timezone)} />
      <PairsModeRow />
      <FoldedSettingsSection
        id={EDITORIAL_METHOD_SECTION_ID}
        title="Avanzado"
        control={
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {settings.engineConfig === EVALUATED_METHOD ? (
              <LockIcon aria-hidden className="size-3" />
            ) : null}
            {summary}
          </span>
        }
      >
        <MethodRow settings={settings} onChange={onChange} />
        {ready && model !== null ? (
          <SettingsRow
            title="Modelo local"
            description={`Agrupa las publicaciones en este equipo; no envía textos a nadie. ${MODEL_NAME}, ${formatMiB(model.bytesExpected)} MiB.`}
            control={
              <Badge size="sm" variant="success">
                Listo
              </Badge>
            }
          />
        ) : (
          <SettingsRow title="Modelo local">{modelCard}</SettingsRow>
        )}
        <SettingsRow
          title="Procesos en paralelo"
          description="Más procesos terminan antes y usan más memoria."
          control={
            <Select
              value={String(settings.workers)}
              onValueChange={(value) => {
                const workers = Number(value);
                if (Number.isInteger(workers) && workers !== settings.workers)
                  onChange({ workers });
              }}
            >
              <SelectTrigger size="sm" aria-label="Procesos en paralelo">
                <SelectValue>
                  {(value: string | null) => value ?? String(settings.workers)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {WORKER_CHOICES.map((choice) => (
                  <SelectItem key={choice} value={String(choice)}>
                    {choice}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </FoldedSettingsSection>
    </>
  );
}

const ignoreReady = () => {};

function NightlySettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const target = { environmentId, input: {} };
  const status = useNightlyStatus(environmentId);
  const sources = useEnvironmentQuery(editorialSourcesEnvironment.list(target));
  const model = AsyncResult.getOrElse(
    useAtomValue(editorialEngineEnvironment.model(target)),
    () => null,
  );
  const update = useAtomCommand(editorialJobsEnvironment.updateSettings, {
    reportFailure: false,
  });
  const runNow = useRunNow(environmentId);
  const settings = status.settings.data;
  if (settings === null) {
    return (
      <SettingsPageContainer>
        <SettingsPageHeader
          title="Revisión nocturna"
          description={
            status.settings.error
              ? `No se pudo leer la revisión nocturna: ${status.settings.error}`
              : "Cargando…"
          }
        />
      </SettingsPageContainer>
    );
  }
  const onChange = (patch: EditorialNightlySettingsUpdateInput) =>
    void update({ environmentId, input: patch }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "No se guardó la revisión nocturna",
          description: settingsFailureText(result),
        });
      }
    });
  return (
    <SettingsPageContainer className="gap-6">
      <NightlyRunSettingsView
        environmentId={environmentId}
        settings={settings}
        jobs={status.jobs ?? []}
        active={status.active}
        state={status.state}
        sources={sources.data}
        model={model}
        now={status.now}
        starting={runNow.starting}
        onChange={onChange}
        onRunNow={runNow.run}
        modelCard={<ModelDownloadCard environmentId={environmentId} onReady={ignoreReady} bare />}
      />
    </SettingsPageContainer>
  );
}

/** Settings › Editorial › Revisión nocturna, on the primary environment, which runs the jobs. */
export function NightlySettingsPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return <NoEnvironment />;
  return <NightlySettingsForEnvironment environmentId={environmentId} />;
}
