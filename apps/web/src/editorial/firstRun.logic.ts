import {
  EDITORIAL_JOB_PHASES,
  type EditorialJob,
  type EditorialJobPhaseName,
  type EditorialJobPhaseStatus,
} from "@t3tools/contracts";

import { PHASE_LABEL, durationText, jobMessages } from "./jobsState";

/**
 * What the first-run card shows, from the job in flight, the newest job and the read of the
 * inbox. Pure, so the four cases of an empty Tendencias inbox are tested without a server.
 */
export type FirstRunView =
  /** No job yet: the card offers the first run. */
  | { readonly kind: "idle" }
  /** A job is in flight, or due and waiting for the scheduler. */
  | { readonly kind: "running"; readonly job: EditorialJob }
  /** The newest job failed, or failed and waits to retry: the card offers to retry now. */
  | {
      readonly kind: "failed";
      readonly job: EditorialJob;
      readonly messages: ReadonlyArray<string>;
    }
  /**
   * The newest job finished without trends to show. With no job (a run imported by hand or
   * older than the nightly run), `runNow` has no job of the day to answer, so it can run.
   */
  | {
      readonly kind: "empty";
      readonly job: EditorialJob | null;
      readonly messages: ReadonlyArray<string>;
      readonly canRun: boolean;
    }
  /** The newest job finished with trends: the inbox refetches them, the wizard says so. */
  | {
      readonly kind: "done";
      readonly job: EditorialJob;
      readonly messages: ReadonlyArray<string>;
    };

export interface FirstRunInput {
  readonly active: EditorialJob | null;
  readonly latest: EditorialJob | null;
  /** True when the inbox has a run, imported earlier, that holds no trend. */
  readonly emptyRun: boolean;
  /** False while the job list is still loading: `latest` may not be known yet. */
  readonly jobsKnown?: boolean;
}

/** An empty run in the inbox that no job of this server ran. */
export const IMPORTED_EMPTY_TEXT =
  "La última corrida no produjo tendencias y no hay registro de su ejecución (fue importada o anterior a la nocturna). Puedes ejecutar una corrida nueva.";

export function firstRunView({
  active,
  latest,
  emptyRun,
  jobsKnown = true,
}: FirstRunInput): FirstRunView {
  if (active !== null) return { kind: "running", job: active };
  if (latest === null) {
    if (!emptyRun) return { kind: "idle" };
    return jobsKnown
      ? { kind: "empty", job: null, messages: [IMPORTED_EMPTY_TEXT], canRun: true }
      : { kind: "empty", job: null, messages: [], canRun: false };
  }
  switch (latest.status) {
    case "failed":
      return { kind: "failed", job: latest, messages: firstRunMessages(latest) };
    case "pending":
      return latest.artifacts.failure === null
        ? { kind: "running", job: latest }
        : { kind: "failed", job: latest, messages: firstRunMessages(latest) };
    case "running":
      return { kind: "running", job: latest };
    case "done":
    case "skipped": {
      const dossiers = latest.artifacts.dossiers;
      if (!emptyRun && latest.artifacts.runId !== null && (dossiers === null || dossiers > 0)) {
        return { kind: "done", job: latest, messages: firstRunMessages(latest) };
      }
      return { kind: "empty", job: latest, messages: emptyReasons(latest), canRun: false };
    }
  }
}

const countFormat = (count: number) => count.toLocaleString("es");

const dayFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});
const formatDay = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));

/** Why a finished job left nothing in the inbox, as far as the job tells it. */
function emptyReasons(job: EditorialJob): ReadonlyArray<string> {
  const collect = job.artifacts.collect;
  const reasons: Array<string> = [];
  if (collect !== null && collect.items === 0) {
    reasons.push(
      `La captura no trajo publicaciones entre el ${formatDay(collect.fromDay)} y el ${formatDay(collect.toDay)}.`,
    );
  } else if (job.artifacts.dossiers === 0) {
    reasons.push(
      collect === null
        ? "El motor no formó ninguna tendencia con el corpus actual."
        : `El motor no formó ninguna tendencia con ${countFormat(collect.items)} publicaciones capturadas.`,
    );
  } else if (job.status === "skipped") {
    reasons.push("La corrida se omitió.");
  }
  return [...reasons, ...firstRunMessages(job)];
}

/**
 * The job's failure and notices, without `missed_days`: a first run always starts after
 * days the corpus lacks, and the card is not where the nightly history is read.
 */
function firstRunMessages(job: EditorialJob): ReadonlyArray<string> {
  const drafting = draftingProblem(job);
  const notices = job.artifacts.notices.filter(
    (notice) =>
      notice.code !== "missed_days" &&
      (drafting === null ||
        (notice.code !== "presentations_pending" && notice.code !== "presentations_unavailable")),
  );
  const messages = jobMessages({ ...job, artifacts: { ...job.artifacts, notices } });
  return drafting === null ? messages : [...messages, drafting.message];
}

export interface DraftingProblem {
  /** For the wizard and the job: what happened and where to look. */
  readonly message: string;
  /** For the inbox header: one short line. */
  readonly short: string;
}

/**
 * Why a finished job left trends without their drafted title and summary, or null. The
 * engine's work is in the inbox either way; only the text model is missing or failing.
 */
export function draftingProblem(job: EditorialJob): DraftingProblem | null {
  const notice = job.artifacts.notices.find(
    (entry) => entry.code === "presentations_unavailable" || entry.code === "presentations_pending",
  );
  if (notice === undefined) return null;
  const total = notice.total ?? job.artifacts.presentations?.total ?? job.artifacts.dossiers ?? 0;
  const ready = notice.ready ?? job.artifacts.presentations?.ready ?? 0;
  if (notice.code === "presentations_unavailable") {
    return {
      message:
        "No hay un proveedor de modelos disponible: las tendencias están en la bandeja sin redactar. Conecta uno en Ajustes › Proveedores y redáctalas desde la bandeja.",
      short: "Tendencias sin redactar: no hay un proveedor de modelos disponible.",
    };
  }
  if (ready === 0) {
    return {
      message: `El proveedor de modelos no redactó ninguna de las ${countFormat(total)} tendencias (sin sesión o sin acceso al modelo): están en la bandeja sin redactar. Revisa la sesión en Ajustes › Proveedores y redáctalas desde la bandeja.`,
      short: "Tendencias sin redactar: el proveedor de modelos no respondió.",
    };
  }
  return {
    message: `Se redactaron ${countFormat(ready)} de ${countFormat(total)} tendencias; las demás están en la bandeja sin redactar. Revisa el proveedor en Ajustes › Proveedores y redáctalas desde la bandeja.`,
    short: `Faltan ${countFormat(total - ready)} de ${countFormat(total)} tendencias por redactar.`,
  };
}

export type FirstRunPhaseStatus = EditorialJobPhaseStatus;

export interface FirstRunPhaseRow {
  readonly phase: EditorialJobPhaseName;
  readonly label: string;
  readonly status: FirstRunPhaseStatus;
  /** Right-hand detail: live progress, what the phase produced, or its duration. */
  readonly detail: string | null;
  /** The same detail for a narrow panel: what the phase produced or its duration, not both. */
  readonly compactDetail: string | null;
  /** Finished, but short of what it should have produced: trends left undrafted. */
  readonly warning: boolean;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const STATUS_WORD: Readonly<Record<FirstRunPhaseStatus, string>> = {
  pending: "pendiente",
  running: "en curso",
  done: "hecha",
  skipped: "omitida",
  failed: "falló",
};

/** Accessible name of a phase row: "Motor: en curso, 3.072 de 11.913 textos". */
export function phaseRowName(row: FirstRunPhaseRow): string {
  const status = row.warning ? "incompleta" : STATUS_WORD[row.status];
  return `${row.label}: ${status}${row.detail === null ? "" : `, ${row.detail}`}`;
}

function producedText(job: EditorialJob, phase: EditorialJobPhaseName): string | null {
  const artifacts = job.artifacts;
  switch (phase) {
    case "collect":
      return artifacts.collect === null
        ? null
        : `${countFormat(artifacts.collect.items)} publicaciones`;
    case "run":
      return artifacts.dossiers === null
        ? null
        : `${countFormat(artifacts.dossiers)} ${artifacts.dossiers === 1 ? "tendencia" : "tendencias"}`;
    case "presentations":
      return artifacts.presentations === null || artifacts.presentations.total === 0
        ? null
        : `${countFormat(artifacts.presentations.ready)} de ${countFormat(artifacts.presentations.total)} redactadas`;
    case "check":
    case "import":
      return null;
  }
}

/**
 * Epoch ms of the client's minute clock (`useNowMinute`), which is UTC truncated to the
 * minute without its `Z`: `Date.parse` would read that form as local time.
 */
export function minuteClockMs(minute: string): number {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(minute)
    ? Date.parse(minute)
    : Date.parse(`${minute}:00.000Z`);
}

/**
 * The five phases in order, each with its state, even before the job records any. `nowMs`
 * gives the running phase its elapsed time while the engine reports no count: it logs one
 * every 1024 texts.
 */
export function firstRunPhaseRows(
  job: EditorialJob | null,
  nowMs: number | null = null,
): ReadonlyArray<FirstRunPhaseRow> {
  return EDITORIAL_JOB_PHASES.map((phase) => {
    const recorded = job?.artifacts.phases.find((entry) => entry.phase === phase);
    const status = recorded?.status ?? "pending";
    const label = capitalize(PHASE_LABEL[phase]);
    if (job === null || recorded === undefined) {
      return { phase, label, status, detail: null, compactDetail: null, warning: false };
    }
    const progress = job.artifacts.progress;
    if (status === "running") {
      const live =
        progress !== null &&
        progress.phase === phase &&
        progress.done !== null &&
        progress.total !== null
          ? `${countFormat(progress.done)} de ${countFormat(progress.total)}${phase === "run" ? " textos" : ""}`
          : null;
      const elapsed =
        nowMs !== null &&
        recorded.startedAt !== null &&
        nowMs - Date.parse(recorded.startedAt) >= 60_000
          ? durationText(recorded.startedAt, new Date(nowMs).toISOString())
          : null;
      const detail = live ?? elapsed;
      return { phase, label, status, detail, compactDetail: detail, warning: false };
    }
    if (status === "done") {
      const produced = producedText(job, phase);
      const duration = durationText(recorded.startedAt, recorded.finishedAt);
      return {
        phase,
        label,
        status,
        detail: [produced, duration].filter((part) => part !== null).join(" · ") || null,
        compactDetail: produced ?? duration,
        warning:
          phase === "presentations" &&
          job.artifacts.presentations !== null &&
          job.artifacts.presentations.ready < job.artifacts.presentations.total,
      };
    }
    return { phase, label, status, detail: null, compactDetail: null, warning: false };
  });
}
