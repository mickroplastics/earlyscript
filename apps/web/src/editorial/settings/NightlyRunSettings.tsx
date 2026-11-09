import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_NIGHTLY_MAX_WORKERS,
  type EditorialJob,
  type EditorialJobPhase,
  type EditorialNightlySettings,
  type EditorialNightlySettingsUpdateInput,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
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
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  JOB_STATUS_LABEL,
  PHASE_LABEL,
  durationText,
  editorialJobsEnvironment,
  jobMessages,
  jobProgressText,
} from "../jobsState";
import { ModelDownloadCard } from "../onboarding/ModelDownloadCard";
import { useEditorialJobActivity } from "../TrendJobIndicator";
import { EDITORIAL_NIGHTLY_SECTION_ID } from "./settingsEntry";

const WORKER_CHOICES = [1, 2, 4, 6, 8, 12, EDITORIAL_NIGHTLY_MAX_WORKERS] as const;

const STATUS_BADGE: Readonly<
  Record<EditorialJob["status"], "success" | "warning" | "error" | "info" | "outline">
> = {
  pending: "outline",
  running: "info",
  done: "success",
  failed: "error",
  skipped: "warning",
};

const PHASE_MARK: Readonly<Record<EditorialJobPhase["status"], string>> = {
  pending: "pendiente",
  running: "en curso",
  done: "",
  skipped: "omitida",
  failed: "falló",
};

const cutoffFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function nextRunText(settings: EditorialNightlySettings): string {
  if (!settings.enabled || settings.nextRunAt === null) {
    return "Desactivada. «Ejecutar ahora» sigue disponible.";
  }
  const when = new Intl.DateTimeFormat("es", {
    timeZone: settings.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(settings.nextRunAt));
  return `Próxima: ${when} (${settings.timezone}).`;
}

const DEFAULT_ENGINE_CONFIG = "engine.v1.json";

/** What a configuration file is, for the files whose name alone does not say it. */
const ENGINE_CONFIG_LABELS: Readonly<Record<string, string>> = {
  "engine.v3-sel.json": "v3, variante V3 elegida",
};

/** The file name, followed by what it is when the name alone does not say it. */
function engineConfigLabel(file: string): string {
  const label = ENGINE_CONFIG_LABELS[file];
  return label === undefined ? file : `${file} (${label})`;
}

function engineConfigStatus(settings: EditorialNightlySettings): string {
  if (settings.engineConfigChosenAt === null) {
    return `${engineConfigLabel(settings.engineConfig)}, la predeterminada; nunca se cambió.`;
  }
  const when = new Intl.DateTimeFormat("es", {
    timeZone: settings.timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(settings.engineConfigChosenAt));
  return `${engineConfigLabel(settings.engineConfig)}, elegida el ${when} (${settings.timezone}).`;
}

/**
 * The configuration file the nightly run starts from. Choosing one only opens a confirmation;
 * the setting changes when the operator confirms it.
 */
function EngineConfigRow({
  settings,
  onChange,
}: {
  readonly settings: EditorialNightlySettings;
  readonly onChange: (patch: EditorialNightlySettingsUpdateInput) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const choices = settings.engineConfigs.includes(settings.engineConfig)
    ? settings.engineConfigs
    : [settings.engineConfig, ...settings.engineConfigs];
  return (
    <>
      <SettingsRow
        title="Configuración del motor"
        description={`El archivo de configuración con que corre el motor cada noche. Sin una elección explícita es ${DEFAULT_ENGINE_CONFIG}. Cambiarla cambia las tendencias de las corridas siguientes, no las anteriores, y queda registrada con su hora.`}
        status={engineConfigStatus(settings)}
        control={
          <Select
            value={settings.engineConfig}
            onValueChange={(value) => {
              if (typeof value === "string" && value !== settings.engineConfig) setPending(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Configuración del motor">
              <SelectValue>
                {(value: string | null) => engineConfigLabel(value ?? settings.engineConfig)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {choices.map((choice) => (
                <SelectItem key={choice} value={choice}>
                  {engineConfigLabel(choice)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              ¿Correr el motor con {pending === null ? null : engineConfigLabel(pending)}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              La próxima corrida nocturna y «Ejecutar ahora» usarán{" "}
              {pending === null ? null : engineConfigLabel(pending)} en lugar de{" "}
              {engineConfigLabel(settings.engineConfig)}. Un trabajo pendiente de hoy se reemplaza
              por uno con la configuración nueva. El cambio queda registrado con su hora y se puede
              deshacer eligiendo otra vez la anterior.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancelar</AlertDialogClose>
            <Button
              onClick={() => {
                if (pending !== null) onChange({ engineConfig: pending });
                setPending(null);
              }}
            >
              Sí, usar {pending}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function phaseText(phase: EditorialJobPhase): string {
  const mark = PHASE_MARK[phase.status];
  const duration = durationText(phase.startedAt, phase.finishedAt);
  return [PHASE_LABEL[phase.phase], mark, duration].filter(Boolean).join(" ");
}

function JobRow({
  job,
  environmentId,
}: {
  readonly job: EditorialJob;
  readonly environmentId: EnvironmentId;
}) {
  const duration = durationText(job.startedAt, job.finishedAt);
  const phases = job.artifacts.phases.map(phaseText).join(" · ");
  const details = [
    ...(job.status === "running" ? [`Corriendo: ${jobProgressText(job)}.`] : []),
    ...jobMessages(job),
  ];
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <span>Corte {cutoffFormat.format(new Date(job.cutoffAt))}</span>
          <Badge size="sm" variant={STATUS_BADGE[job.status]}>
            {JOB_STATUS_LABEL[job.status]}
          </Badge>
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span>{phases}</span>
          {details.map((line) => (
            <span key={line} className="text-muted-foreground">
              {line}
            </span>
          ))}
        </span>
      }
      status={duration === null ? undefined : `Duración: ${duration}, intento ${job.attempt}.`}
      control={
        job.artifacts.runId !== null && job.status === "done" ? (
          <Button
            size="xs"
            variant="outline"
            render={<Link to="/editorial/$environmentId/trends" params={{ environmentId }} />}
          >
            Ver en Tendencias
          </Button>
        ) : null
      }
    />
  );
}

export interface NightlyRunSettingsViewProps {
  readonly environmentId: EnvironmentId;
  readonly settings: EditorialNightlySettings;
  readonly jobs: ReadonlyArray<EditorialJob>;
  readonly active: EditorialJob | null;
  readonly starting: boolean;
  readonly onChange: (patch: EditorialNightlySettingsUpdateInput) => void;
  readonly onRunNow: () => void;
  /** The model card, for machines that went through the first-run wizard already. */
  readonly modelCard?: ReactNode;
}

export function NightlyRunSettingsView({
  environmentId,
  settings,
  jobs,
  active,
  starting,
  onChange,
  onRunNow,
  modelCard,
}: NightlyRunSettingsViewProps) {
  const busy = starting || active !== null;
  return (
    <SettingsSection id={EDITORIAL_NIGHTLY_SECTION_ID} title="Corrida nocturna">
      <SettingsRow
        title="Corrida nocturna"
        description="Cada día, a la hora indicada, captura las fuentes activas hasta ayer, corre el motor con corte a las 00:00 UTC de hoy, comprueba e importa la corrida y redacta sus tendencias. Corre solo mientras el servidor está encendido; si faltó algún día, captura lo que falta y corre una sola vez."
        status={nextRunText(settings)}
        control={
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
            aria-label="Corrida nocturna"
          />
        }
      />
      <SettingsRow
        title="Hora"
        description={`Hora local de ${settings.timezone}.`}
        control={
          <Input
            nativeInput
            size="sm"
            type="time"
            className="w-32"
            aria-label="Hora de la corrida nocturna"
            value={settings.timeOfDay}
            onChange={(event) => {
              const value = event.target.value;
              if (/^\d{2}:\d{2}$/.test(value) && value !== settings.timeOfDay) {
                onChange({ timeOfDay: value });
              }
            }}
          />
        }
      />
      <SettingsRow
        title="Procesos del motor"
        description="Procesos de embeddings en paralelo. Más procesos terminan antes y usan más CPU y memoria."
        control={
          <Select
            value={String(settings.workers)}
            onValueChange={(value) => {
              const workers = Number(value);
              if (Number.isInteger(workers) && workers !== settings.workers) onChange({ workers });
            }}
          >
            <SelectTrigger size="sm" aria-label="Procesos del motor">
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
      <EngineConfigRow settings={settings} onChange={onChange} />
      {modelCard === undefined ? null : (
        <SettingsRow
          title="Modelo del motor"
          description="La corrida nocturna lo necesita; se descarga una sola vez en esta máquina."
        >
          {modelCard}
        </SettingsRow>
      )}
      <SettingsRow
        title="Ejecutar ahora"
        description={
          active === null
            ? "Corre la de hoy sin esperar a la hora. Si ya corrió con estas fuentes, no la repite; si falló, sigue desde la fase que falta."
            : `Corriendo: ${jobProgressText(active)}.`
        }
        control={
          <Button size="xs" variant="outline" disabled={busy} onClick={onRunNow}>
            {busy ? (
              <span aria-hidden>
                <Spinner size="sm" />
              </span>
            ) : null}
            Ejecutar ahora
          </Button>
        }
      />
      {jobs.length === 0 ? (
        <SettingsRow title="Últimas corridas" description="Todavía no hay corridas programadas." />
      ) : (
        jobs.map((job) => (
          <JobRow
            key={job.jobId}
            job={active?.jobId === job.jobId ? active : job}
            environmentId={environmentId}
          />
        ))
      )}
    </SettingsSection>
  );
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  "no-sources": "Ninguna fuente está activada para el motor (Ajustes › Editorial › Fuentes).",
  unavailable: "Los servicios editoriales no están montados en este servidor.",
  storage: "La base editorial no respondió.",
  "invalid-settings": "El ajuste no es válido.",
};

export function failureText(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag === "Success") return "";
  if (isAtomCommandInterrupted(result)) return "Se canceló.";
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "reason" in error) {
    const text = ERROR_TEXT[String(error.reason)];
    if (text) return text;
  }
  return error instanceof Error ? error.message : "Error desconocido.";
}

const ignoreReady = () => {};

function NightlyRunSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const target = { environmentId, input: {} };
  const settings = useEnvironmentQuery(editorialJobsEnvironment.settings(target));
  const list = useEnvironmentQuery(editorialJobsEnvironment.list(target));
  const active = useEditorialJobActivity(environmentId);
  const quiet = { reportFailure: false } as const;
  const update = useAtomCommand(editorialJobsEnvironment.updateSettings, quiet);
  const runNow = useAtomCommand(editorialJobsEnvironment.runNow, quiet);
  const [starting, setStarting] = useState(false);
  if (settings.data === null) {
    return (
      <SettingsSection id={EDITORIAL_NIGHTLY_SECTION_ID} title="Corrida nocturna">
        <SettingsRow
          title={settings.error ? "No se pudo leer la corrida nocturna" : "Cargando"}
          description={settings.error ?? undefined}
        />
      </SettingsSection>
    );
  }
  const onChange = (patch: EditorialNightlySettingsUpdateInput) =>
    void update({ environmentId, input: patch }).then((result) => {
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "No se guardó la corrida nocturna",
          description: failureText(result),
        });
      }
    });
  const onRunNow = () => {
    setStarting(true);
    void runNow({ environmentId, input: {} }).then((result) => {
      setStarting(false);
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "No se pudo ejecutar",
          description: failureText(result),
        });
      }
    });
  };
  return (
    <NightlyRunSettingsView
      environmentId={environmentId}
      settings={settings.data}
      jobs={list.data?.jobs ?? []}
      active={active}
      starting={starting}
      onChange={onChange}
      onRunNow={onRunNow}
      modelCard={<ModelDownloadCard environmentId={environmentId} onReady={ignoreReady} bare />}
    />
  );
}

/** Settings › Editorial › Corrida nocturna, on the primary environment, which runs the jobs. */
export function NightlyRunSettings() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return null;
  return <NightlyRunSettingsForEnvironment environmentId={environmentId} />;
}
