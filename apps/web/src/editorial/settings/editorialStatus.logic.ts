import {
  isDraftBudgetReached,
  type EditorialDraftBudget,
  type EditorialJob,
  type EditorialJobNotice,
  type EditorialJobPhaseName,
  type EditorialModelState,
  type EditorialNightlySettings,
  type EditorialSourceEntry,
  type EditorialSourcesView,
} from "@t3tools/contracts";

import { modelCardPhase } from "../engineState";

// What Settings › Editorial says about the nightly review, the sources, the local model and the
// month's drafting: the status strip on «Mi canal», the dot beside «Revisión nocturna» in the
// sidebar and the status card of that page all read these.

export type Tone = "ok" | "running" | "warning" | "error" | "idle";

const DAY_MS = 86_400_000;

/** The calendar day of `iso` in `timeZone` ("2026-11-12"); the browser's zone when undefined. */
export function localDay(iso: string | number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

const shortDay = new Intl.DateTimeFormat("es", { timeZone: "UTC", day: "numeric", month: "short" });

/** "12 nov" for a `YYYY-MM-DD` day. */
export const formatDay = (day: string) => shortDay.format(new Date(`${day}T00:00:00Z`));

const dayDistance = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** "hoy", "ayer" or "12 nov": `day` seen from `today`, both `YYYY-MM-DD`. */
export function relativeDay(day: string, today: string): string {
  const distance = dayDistance(day, today);
  if (distance === 0) return "hoy";
  if (distance === 1) return "ayer";
  return formatDay(day);
}

export function timeOf(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("es", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** "1.154": Spanish leaves four-digit numbers ungrouped unless told otherwise. */
export const formatCount = (count: number) => count.toLocaleString("es", { useGrouping: "always" });

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The five steps of a review, in the operator's words. */
export const STEP_LABEL: Readonly<Record<EditorialJobPhaseName, string>> = {
  collect: "Capturar fuentes",
  run: "Buscar tendencias",
  check: "Comprobar",
  import: "Guardar",
  presentations: "Redactar",
};

/** "al agrupar": what was being done when a step failed. */
const FAILED_AT: Readonly<Record<EditorialJobPhaseName, string>> = {
  collect: "al capturar",
  run: "al agrupar",
  check: "al comprobar",
  import: "al guardar",
  presentations: "al redactar",
};

const ENGINE_FAILED: Readonly<Record<EditorialJobPhaseName, string>> = {
  collect: "Falló al capturar las fuentes.",
  run: "Falló al agrupar las publicaciones.",
  check: "Falló al comprobar las tendencias.",
  import: "Falló al guardar las tendencias.",
  presentations: "Falló al redactar las tendencias.",
};

const failedPhase = (job: EditorialJob): EditorialJobPhaseName | null =>
  job.artifacts.failure?.phase ??
  job.artifacts.phases.find((phase) => phase.status === "failed")?.phase ??
  null;

/** One sentence on why a review failed, without the technical detail the server keeps. */
function failureSentence(notice: EditorialJobNotice): string {
  switch (notice.code) {
    case "engine_failed":
      return ENGINE_FAILED[notice.phase ?? "run"];
    case "engine_missing":
      return "Falta el programa que busca las tendencias en esta instalación; reinstala Earlyscript.";
    case "no_sources":
      return "Ninguna fuente cuenta para tus tendencias.";
    case "check_failed":
      return "La comprobación no reprodujo lo encontrado.";
    case "import_failed":
      return "No se pudieron guardar las tendencias encontradas.";
    case "collect_locked":
      return "Otra captura estaba en curso.";
    case "storage":
      return "La base editorial no respondió.";
    case "too_many_attempts":
      return "Se agotaron los intentos.";
    case "config_changed":
      return "Las fuentes cambiaron antes de empezar; se rehace con las nuevas.";
    case "presentations_budget":
      return `La redacción se detuvo en el tope mensual (${notice.used ?? 0} de ${notice.limit ?? 0}).`;
    case "presentations_unavailable":
      return "No hay un modelo de texto disponible para redactar.";
    case "presentations_provider_disabled":
      return "El proveedor elegido para redactar está desactivado.";
    case "presentations_pending":
      return `Quedaron ${(notice.total ?? 0) - (notice.ready ?? 0)} tendencias sin redactar.`;
    case "missed_days":
      return "Faltaron noches; se capturaron después.";
    case "stale_lock_removed":
    case "stale_engine_waited":
      return "Se limpió una revisión anterior que quedó a medias.";
  }
}

/** The sentence under a failed review, with what «Reintentar» does. */
export function failureDetail(job: EditorialJob): string {
  const failure = job.artifacts.failure;
  const phase = failedPhase(job);
  const sentence =
    failure === null
      ? phase === null
        ? "La revisión falló."
        : `Falló ${FAILED_AT[phase]}.`
      : failureSentence(failure);
  const collected = job.artifacts.phases.some(
    (step) => step.phase === "collect" && step.status === "done",
  );
  const retry =
    phase !== null && phase !== "collect" && collected
      ? " «Reintentar» sigue desde ahí; lo capturado no se repite."
      : " «Reintentar» vuelve a intentarlo.";
  const later = job.status === "pending" ? " Si no, se reintentará sola más tarde." : "";
  return `${sentence}${retry}${later}`;
}

export type NightlyState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "running"; readonly job: EditorialJob }
  | {
      readonly _tag: "failed";
      readonly job: EditorialJob;
      /** The newest finished review, whose trends the inbox still shows. */
      readonly lastDone: EditorialJob | null;
    }
  | { readonly _tag: "current"; readonly job: EditorialJob }
  | { readonly _tag: "due"; readonly lastDone: EditorialJob | null }
  | { readonly _tag: "disabled"; readonly lastDone: EditorialJob | null }
  | { readonly _tag: "none" };

const isFailed = (job: EditorialJob) =>
  job.status === "failed" || (job.status === "pending" && job.artifacts.failure !== null);

/**
 * Where the nightly review stands. `jobs` is newest cutoff first, as the server lists them;
 * skipped jobs were replaced and say nothing about the night.
 */
export function nightlyState(input: {
  readonly settings: EditorialNightlySettings | null;
  readonly jobs: ReadonlyArray<EditorialJob> | null;
  readonly active: EditorialJob | null;
  readonly now: number;
}): NightlyState {
  if (input.active !== null) return { _tag: "running", job: input.active };
  if (input.settings === null || input.jobs === null) return { _tag: "loading" };
  const jobs = input.jobs.filter((job) => job.status !== "skipped");
  const latest = jobs[0] ?? null;
  const lastDone = jobs.find((job) => job.status === "done") ?? null;
  if (latest !== null && latest.status === "running") return { _tag: "running", job: latest };
  if (latest !== null && isFailed(latest)) return { _tag: "failed", job: latest, lastDone };
  if (!input.settings.enabled) return { _tag: "disabled", lastDone };
  const nextRunAt = input.settings.nextRunAt;
  // `nextRunAt` is the next time whose cutoff has no job yet: past it, tonight's is owed.
  if (nextRunAt !== null && Date.parse(nextRunAt) <= input.now) return { _tag: "due", lastDone };
  if (latest === null) return { _tag: "none" };
  if (latest.status === "done") return { _tag: "current", job: latest };
  return { _tag: "due", lastDone };
}

/** "Hoy 03:12", "Ayer 03:12" or "11 nov": when a review finished. */
export function finishedLabel(job: EditorialJob, timeZone: string | undefined, now: number) {
  const at = job.finishedAt ?? job.startedAt ?? job.scheduledFor;
  const day = relativeDay(localDay(at, timeZone), localDay(now, timeZone));
  return day === "hoy" || day === "ayer" ? `${capitalize(day)} ${timeOf(at, timeZone)}` : day;
}

/** The local day a review ran (or was due): what "hoy" and "ayer" are about, unlike its UTC cutoff. */
export const jobDay = (job: EditorialJob, timeZone: string | undefined) =>
  localDay(job.startedAt ?? job.scheduledFor, timeZone);

export const trendsText = (count: number) =>
  `${formatCount(count)} ${count === 1 ? "tendencia" : "tendencias"}`;

/** Whether the sources a review used are the ones that count and capture now. */
export function sameSources(job: EditorialJob, sources: EditorialSourcesView | null): boolean {
  if (sources === null) return true;
  const same = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
    a.length === b.length && a.every((id) => b.includes(id));
  return (
    same(
      job.artifacts.sources.rank,
      sources.sources.filter((entry) => entry.rank).map((entry) => entry.source),
    ) &&
    same(
      job.artifacts.sources.collect,
      sources.sources.filter((entry) => entry.collect).map((entry) => entry.source),
    )
  );
}

export interface Cell {
  readonly tone: Tone;
  readonly text: string;
}

export function nightlyCell(state: NightlyState, timeZone: string | undefined, now: number): Cell {
  switch (state._tag) {
    case "loading":
      return { tone: "idle", text: "Cargando…" };
    case "running":
      return { tone: "running", text: "Revisando…" };
    case "failed": {
      const phase = failedPhase(state.job);
      return { tone: "error", text: phase === null ? "Falló" : `Falló ${FAILED_AT[phase]}` };
    }
    case "current":
      return { tone: "ok", text: `${finishedLabel(state.job, timeZone, now)} · al día` };
    case "due":
      return { tone: "warning", text: "Pendiente" };
    case "disabled":
      return { tone: "idle", text: "Desactivada" };
    case "none":
      return { tone: "idle", text: "Sin revisiones" };
  }
}

/** Item nouns per source, for "1.154 publicaciones". */
const ITEM_NOUN: Readonly<Record<string, readonly [string, string]>> = {
  hn: ["publicación", "publicaciones"],
  lobsters: ["publicación", "publicaciones"],
  bluesky: ["publicación", "publicaciones"],
  github: ["repositorio", "repositorios"],
  huggingface: ["repositorio", "repositorios"],
  arxiv: ["artículo", "artículos"],
  wikipedia: ["página", "páginas"],
  npm: ["paquete", "paquetes"],
  rss: ["entrada", "entradas"],
  stackexchange: ["pregunta", "preguntas"],
};

export function itemsText(source: string, count: number): string {
  const [one, many] = ITEM_NOUN[source] ?? ["elemento", "elementos"];
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The corpus's last day (its `toDay` is exclusive); null without a corpus. */
export function corpusLastDay(view: EditorialSourcesView): string | null {
  const toDay = view.corpus.toDay;
  if (toDay === null) return null;
  return new Date(Date.parse(`${toDay}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** What is wrong with a source that counts, or null when its last day came in whole. */
function countingSourceProblem(
  entry: EditorialSourceEntry,
  name: string,
  lastDay: string | null,
): string | null {
  const capture = entry.lastCapture;
  if (!entry.collect) return `${name} no se captura`;
  if (capture === null) return `${name} sin capturas`;
  if (capture.status === "unavailable") return `${name} no responde`;
  if (capture.status === "rate_limited") return `${name} limitada por cuota`;
  if (lastDay !== null && capture.day < lastDay)
    return `${name}: nada desde ${formatDay(capture.day)}`;
  if (capture.items === 0) return `${name}: 0 ${itemsText(entry.source, 0).split(" ")[1]}`;
  return null;
}

export function sourcesCell(
  view: EditorialSourcesView | null,
  nameOf: (source: string) => string,
): Cell {
  if (view === null) return { tone: "idle", text: "Cargando…" };
  const counting = view.sources.filter((entry) => entry.rank);
  if (counting.length === 0) return { tone: "error", text: "Ninguna cuenta" };
  if (view.corpus.status === "unreadable") return { tone: "error", text: "No se pudieron leer" };
  if (view.corpus.status === "missing") return { tone: "idle", text: "Sin capturas aún" };
  const lastDay = corpusLastDay(view);
  const problems = counting.flatMap((entry) => {
    const problem = countingSourceProblem(entry, nameOf(entry.source), lastDay);
    return problem === null ? [] : [problem];
  });
  if (problems.length === 0) return { tone: "ok", text: "Al día" };
  return {
    tone: "warning",
    text: problems.length === 1 ? problems[0]! : `${problems[0]} y ${problems.length - 1} más`,
  };
}

export function modelCell(state: EditorialModelState | null, failed: boolean): Cell {
  if (failed) return { tone: "error", text: "Sin estado" };
  const phase = modelCardPhase(state);
  switch (phase._tag) {
    case "checking":
      return { tone: "idle", text: "Comprobando…" };
    case "verifying":
      return { tone: "running", text: "Comprobando archivos" };
    case "downloading": {
      const percent =
        phase.bytesTotal > 0 ? Math.floor((phase.bytesDone / phase.bytesTotal) * 100) : 0;
      return { tone: "running", text: `Descargando ${percent} %` };
    }
    case "failed":
      return { tone: "error", text: "Falló la descarga" };
    case "missing":
      return { tone: "warning", text: "Falta descargarlo" };
    case "ready":
      return { tone: "ok", text: "Listo" };
  }
}

export interface DraftCell extends Cell {
  /** Share of the cap used, 0 to 1; null without a cap. */
  readonly used: number | null;
}

export function draftCell(budget: EditorialDraftBudget | null, hasProvider: boolean): DraftCell {
  if (budget === null) return { tone: "idle", text: "Cargando…", used: null };
  if (!hasProvider) return { tone: "warning", text: "Sin proveedor", used: null };
  if (budget.monthlyLimit === 0) {
    return { tone: "ok", text: `${budget.usedThisMonth} este mes · sin tope`, used: null };
  }
  const used = Math.min(1, budget.usedThisMonth / budget.monthlyLimit);
  const tone: Tone = isDraftBudgetReached(budget) ? "error" : used >= 0.9 ? "warning" : "ok";
  return {
    tone,
    text: `${budget.usedThisMonth} de ${budget.monthlyLimit} redacciones`,
    used,
  };
}

export type StripAlert =
  | { readonly _tag: "retry"; readonly text: string }
  | { readonly _tag: "sources"; readonly text: string }
  | { readonly _tag: "model"; readonly text: string }
  | { readonly _tag: "budget"; readonly text: string };

/** The one line under the strip: the most pressing problem and what fixes it; null when none. */
export function stripAlert(input: {
  readonly nightly: NightlyState;
  readonly sources: EditorialSourcesView | null;
  readonly model: Cell;
  readonly draft: DraftCell;
  readonly budgetReset: string;
  readonly timeZone: string | undefined;
  readonly now: number;
}): StripAlert | null {
  const { nightly } = input;
  if (nightly._tag === "failed") {
    const last = nightly.lastDone;
    if (last === null) {
      return { _tag: "retry", text: "La revisión falló y todavía no hay tendencias." };
    }
    const today = localDay(input.now, input.timeZone);
    const lastDay = relativeDay(jobDay(last, input.timeZone), today);
    const failedDay = relativeDay(jobDay(nightly.job, input.timeZone), today);
    const lead = failedDay === "hoy" ? "Sin tendencias nuevas hoy" : "Sin tendencias nuevas";
    const from =
      lastDay === "hoy" || lastDay === "ayer" ? `las de ${lastDay}` : `las del ${lastDay}`;
    return { _tag: "retry", text: `${lead}: la bandeja muestra ${from}.` };
  }
  if (input.sources !== null && !input.sources.sources.some((entry) => entry.rank)) {
    return {
      _tag: "sources",
      text: "Ninguna fuente cuenta para tus tendencias: la revisión no tiene dónde buscar.",
    };
  }
  if (input.model.tone === "warning" || input.model.tone === "error") {
    return {
      _tag: "model",
      text: "Falta el modelo local: sin él, la revisión no puede agrupar las publicaciones.",
    };
  }
  if (input.draft.tone === "error") {
    return {
      _tag: "budget",
      text: `Tope de redacción alcanzado: las tendencias nuevas llegan sin resumen hasta el ${input.budgetReset}.`,
    };
  }
  return null;
}
