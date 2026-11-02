import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_JOB_PHASES,
  EDITORIAL_JOBS_WS_METHODS,
  type EditorialJob,
  type EditorialJobNotice,
  type EditorialJobPhaseName,
  type EditorialJobStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:jobs",
  tag: EDITORIAL_JOBS_WS_METHODS.list,
  staleTimeMs: 60_000,
});

const settings = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:jobs-settings",
  tag: EDITORIAL_JOBS_WS_METHODS.getSettings,
  staleTimeMs: 60_000,
});

export const refreshJobsList = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.refresh(list({ environmentId, input: {} })));

/** The nightly run per environment: its settings, its latest jobs and the job in flight. */
export const editorialJobsEnvironment = {
  list,
  settings,
  /** Pushed by the server on every change of the job in flight; nothing is polled. */
  activity: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:jobs-activity",
    tag: EDITORIAL_JOBS_WS_METHODS.watch,
  }),
  runNow: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:jobs-run-now",
    tag: EDITORIAL_JOBS_WS_METHODS.runNow,
    onSuccess: refreshJobsList,
  }),
  updateSettings: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:jobs-update-settings",
    tag: EDITORIAL_JOBS_WS_METHODS.updateSettings,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => registry.refresh(settings({ environmentId, input: {} }))),
  }),
};

export const PHASE_LABEL: Readonly<Record<EditorialJobPhaseName, string>> = {
  collect: "captura",
  run: "motor",
  check: "comprobación",
  import: "importación",
  presentations: "redacción",
};

export const JOB_STATUS_LABEL: Readonly<Record<EditorialJobStatus, string>> = {
  pending: "En espera",
  running: "Corriendo",
  done: "Hecha",
  failed: "Falló",
  skipped: "Omitida",
};

const formatCount = (count: number) => count.toLocaleString("es");

/** "captura 1/5", then what the phase reports: texts embedded or trends drafted. */
export function jobProgressText(job: EditorialJob): string {
  const running =
    job.artifacts.progress?.phase ??
    job.artifacts.phases.find((phase) => phase.status === "running")?.phase ??
    null;
  if (running === null) return "preparando";
  const step = `${PHASE_LABEL[running]} ${EDITORIAL_JOB_PHASES.indexOf(running) + 1}/${EDITORIAL_JOB_PHASES.length}`;
  const progress = job.artifacts.progress;
  if (progress === null || progress.done === null || progress.total === null) return step;
  const unit = progress.phase === "run" ? " textos" : "";
  return `${step} · ${formatCount(progress.done)} de ${formatCount(progress.total)}${unit}`;
}

/** "4 min", "38 s"; null while the span is open. */
export function durationText(startedAt: string | null, finishedAt: string | null): string | null {
  if (startedAt === null || finishedAt === null) return null;
  const seconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const dayFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});
const formatDays = (days: ReadonlyArray<string>) =>
  days.map((day) => dayFormat.format(new Date(`${day}T00:00:00Z`))).join(", ");

/** What the trend engine was doing when it exited with an error; its log has the detail. */
const ENGINE_FAILED_TEXT: Readonly<Record<EditorialJobPhaseName, string>> = {
  collect: "El motor de tendencias terminó con error al capturar las fuentes.",
  run: "El motor de tendencias terminó con error al agrupar las publicaciones.",
  check: "El motor de tendencias terminó con error al comprobar la corrida.",
  import: "El motor de tendencias terminó con error al importar la corrida.",
  presentations: "El motor de tendencias terminó con error al redactar las tendencias.",
};

/** The operator's wording of a notice; the technical detail stays on the server. */
function noticeText(notice: EditorialJobNotice): string {
  switch (notice.code) {
    case "missed_days":
      return `Sin corrida ${notice.days?.length === 1 ? "el día" : "los días"} ${formatDays(notice.days ?? [])}: se capturaron ahora y cuentan desde este corte.`;
    case "stale_lock_removed":
      return "Se retiró un candado de captura abandonado.";
    case "stale_engine_waited":
      return "Se esperó a que terminara un motor anterior de esta corrida antes de seguir.";
    case "presentations_pending":
      return `Redacción pendiente: ${notice.ready ?? 0} de ${notice.total ?? 0} tendencias redactadas. Revisa el modelo de texto en Ajustes.`;
    case "presentations_unavailable":
      return "Redacción pendiente: no hay un modelo de texto disponible. Las tendencias se ven con sus términos.";
    case "config_changed":
      return "Las fuentes del motor cambiaron antes de correr; la reemplaza una corrida con la configuración nueva.";
    case "no_sources":
      return "Ninguna fuente está activada para el motor (Ajustes › Editorial › Fuentes).";
    case "engine_missing":
      return "No se encontró el motor de tendencias en esta instalación. Reinstala Earlyscript o revisa EARLYSCRIPT_ENGINE_CLI.";
    case "engine_failed":
      return ENGINE_FAILED_TEXT[notice.phase ?? "run"];
    case "check_failed":
      return "La comprobación no reprodujo la corrida.";
    case "import_failed":
      return "La importación rechazó la corrida.";
    case "collect_locked":
      return "Otra captura estaba usando el corpus.";
    case "storage":
      return "La base editorial no respondió.";
    case "too_many_attempts":
      return "Se agotaron los intentos.";
  }
}

/** What a job row says beyond its phases: the failure first, then the notices. */
export function jobMessages(job: EditorialJob): ReadonlyArray<string> {
  const failure = job.artifacts.failure;
  const retry = failure !== null && job.status === "pending" ? " Se reintentará más tarde." : "";
  return [
    ...(failure === null ? [] : [`${noticeText(failure)}${retry}`]),
    ...job.artifacts.notices.map(noticeText),
  ];
}
