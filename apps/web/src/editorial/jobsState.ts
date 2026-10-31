import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_JOB_PHASES,
  EDITORIAL_JOBS_WS_METHODS,
  type EditorialJob,
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
