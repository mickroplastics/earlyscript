import type { EditorialJob, EditorialNightlySettings } from "@t3tools/contracts";

import { durationText } from "../jobsState";
import { formatDay, localDay, timeOf, trendsText } from "./editorialStatus.logic";

// «Revisión nocturna»: the line of each night, when the next one runs and how the method the
// review starts from is named.

export type NightStatus = "done" | "running" | "failed" | "retrying" | "pending" | "skipped";

export interface NightRow {
  readonly key: string;
  /** "12 nov", the night's cutoff day. */
  readonly day: string;
  /** Start time, only when two rows share a day. */
  readonly time: string | null;
  readonly status: NightStatus;
  readonly detail: string;
}

const NOTICE_NOTE: Readonly<Partial<Record<string, string>>> = {
  presentations_pending: "quedaron tendencias sin redactar",
  presentations_unavailable: "sin redactar: no había modelo de texto",
  presentations_provider_disabled: "sin redactar: proveedor desactivado",
  presentations_budget: "redacción detenida por el tope",
  missed_days: "recuperó días sin captura",
};

function nightStatus(job: EditorialJob): NightStatus {
  if (job.status === "pending" && job.artifacts.failure !== null) return "retrying";
  return job.status;
}

/** One line per night, newest first; `active` replaces its row with the live one. */
export function nightRows(
  jobs: ReadonlyArray<EditorialJob>,
  active: EditorialJob | null,
  timeZone: string | undefined,
): ReadonlyArray<NightRow> {
  const live = jobs.map((job) => (active !== null && active.jobId === job.jobId ? active : job));
  const rows =
    active !== null && !jobs.some((job) => job.jobId === active.jobId) ? [active, ...live] : live;
  const dayOf = (job: EditorialJob) => job.cutoffAt.slice(0, 10);
  const dayCount = new Map<string, number>();
  for (const job of rows) dayCount.set(dayOf(job), (dayCount.get(dayOf(job)) ?? 0) + 1);
  return rows.map((job) => {
    const status = nightStatus(job);
    const started = job.startedAt ?? job.scheduledFor;
    const duration = durationText(job.startedAt, job.finishedAt);
    const notes = job.artifacts.notices.flatMap((notice) => {
      const note = NOTICE_NOTE[notice.code];
      return note === undefined ? [] : [note];
    });
    const parts =
      status === "running"
        ? [`desde las ${timeOf(started, timeZone)}`]
        : status === "pending"
          ? [`programada para las ${timeOf(job.scheduledFor, timeZone)}`]
          : status === "skipped"
            ? ["reemplazada por otra con las fuentes nuevas"]
            : [
                ...(duration === null ? [] : [duration]),
                ...(status === "done" && job.artifacts.dossiers !== null
                  ? [trendsText(job.artifacts.dossiers)]
                  : []),
                ...(job.attempt > 1 ? [`intento ${job.attempt}`] : []),
                ...notes,
              ];
    return {
      key: job.jobId,
      day: formatDay(dayOf(job)),
      time: (dayCount.get(dayOf(job)) ?? 0) > 1 ? timeOf(started, timeZone) : null,
      status,
      detail: parts.join(" · "),
    };
  });
}

/** "unos 10 min": the median of the finished reviews; null before the first one. */
export function usualDuration(jobs: ReadonlyArray<EditorialJob>): string | null {
  const spans = jobs
    .filter((job) => job.status === "done" && job.startedAt !== null && job.finishedAt !== null)
    .map((job) => Date.parse(job.finishedAt!) - Date.parse(job.startedAt!))
    .toSorted((a, b) => a - b);
  if (spans.length === 0) return null;
  const median = spans[Math.floor(spans.length / 2)]!;
  const text = durationText(new Date(0).toISOString(), new Date(median).toISOString());
  return text === null ? null : `unos ${text}`;
}

const DAY_MS = 86_400_000;

/** "Próxima: mañana a las 03:00, hora de Guayaquil." */
export function nextNightText(settings: EditorialNightlySettings, now: number): string {
  if (!settings.enabled || settings.nextRunAt === null) {
    return "Desactivada: no se revisa sola. «Revisar ahora» sigue disponible.";
  }
  const zone = settings.timezone;
  const day = localDay(settings.nextRunAt, zone);
  const today = localDay(now, zone);
  const tomorrow = localDay(Date.parse(`${today}T12:00:00Z`) + DAY_MS, "UTC");
  const when = day === today ? "hoy" : day === tomorrow ? "mañana" : `el ${formatDay(day)}`;
  return `Próxima: ${when} a las ${timeOf(settings.nextRunAt, zone)}, ${zoneText(zone)}.`;
}

/** "hora de Guayaquil" for America/Guayaquil. */
function zoneText(zone: string): string {
  if (zone === "UTC" || zone === "Etc/UTC") return "hora UTC";
  return `hora de ${(zone.split("/").at(-1) ?? zone).replaceAll("_", " ")}`;
}

/** The configuration the thesis evaluated, and the one the engine ships by default. */
export const EVALUATED_METHOD = "engine.v3-sel.json";
const ORIGINAL_METHOD = "engine.v1.json";

/** How a configuration file is named on screen. */
export function methodName(file: string): string {
  if (file === EVALUATED_METHOD) return "el método evaluado";
  if (file === ORIGINAL_METHOD) return "el método original";
  return file.replace(/^engine\./, "").replace(/\.json$/, "");
}

/** The tag beside the name: "v3", "v1", or the file for the other installed ones. */
export function methodTag(file: string): string {
  if (file === EVALUATED_METHOD) return "v3";
  if (file === ORIGINAL_METHOD) return "v1";
  return file;
}

/** The choices of the method dialog: the evaluated and the original by name, the rest apart. */
export function methodChoices(settings: EditorialNightlySettings): {
  readonly named: ReadonlyArray<string>;
  readonly others: ReadonlyArray<string>;
} {
  const installed = settings.engineConfigs.includes(settings.engineConfig)
    ? settings.engineConfigs
    : [settings.engineConfig, ...settings.engineConfigs];
  const named = [EVALUATED_METHOD, ORIGINAL_METHOD].filter((file) => installed.includes(file));
  return { named, others: installed.filter((file) => !named.includes(file)) };
}

/** The dialog opens on the evaluated method when it is installed, otherwise on the current one. */
export function initialMethod(settings: EditorialNightlySettings): string {
  return settings.engineConfigs.includes(EVALUATED_METHOD)
    ? EVALUATED_METHOD
    : settings.engineConfig;
}
