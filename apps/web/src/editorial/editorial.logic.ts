import type {
  EditorialRunSummary,
  EditorialSourceCoverage,
  EditorialTrendSummary,
} from "@t3tools/contracts";

import type { EditorialSpace, EnvironmentSpaceState } from "./spaceStore";

/** Decision 5 of doc 04: up to ten new trends visible, the rest folded behind "ver N más". */
const INBOX_VISIBLE_COUNT = 10;

const THREAD_ROUTE_IDS: ReadonlySet<string> = new Set([
  "/_chat/$environmentId/$threadId",
  "/_chat/draft/$draftId",
]);

/** The space a route belongs to; `null` for pages that keep the last space (Settings, Usage). */
export function resolveRouteSpace(routeId: string | undefined): EditorialSpace | null {
  if (routeId === undefined) return null;
  if (routeId.startsWith("/_chat/editorial/$environmentId/trends")) return "trends";
  if (routeId === "/_chat/editorial/$environmentId/results") return "results";
  if (THREAD_ROUTE_IDS.has(routeId)) return "threads";
  return null;
}

export function isThreadRouteId(routeId: string | undefined): boolean {
  return routeId !== undefined && THREAD_ROUTE_IDS.has(routeId);
}

export type EditorialLandingTarget =
  | { readonly space: "trends"; readonly trend: EnvironmentSpaceState["trend"] }
  | { readonly space: "results" };

/**
 * Where the root opens. Today: the space left last. Extension point for read state (U3):
 * a run newer than the last one seen opens Trends regardless, once, at startup.
 */
export function resolveLandingTarget(state: EnvironmentSpaceState): EditorialLandingTarget | null {
  switch (state.space) {
    case "threads":
      return null;
    case "trends":
      return { space: "trends", trend: state.trend };
    case "results":
      return { space: "results" };
  }
}

export function splitInbox<T>(trends: ReadonlyArray<T>, visibleCount = INBOX_VISIBLE_COUNT) {
  return { visible: trends.slice(0, visibleCount), folded: trends.slice(visibleCount) };
}

const decimalFormat = new Intl.NumberFormat("es", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dayMonthFormat = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const fullDateFormat = new Intl.DateTimeFormat("es", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDecimal(value: number): string {
  return decimalFormat.format(value);
}

/** "19 oct": the cutoff is a UTC day boundary, so it is read in UTC. */
export function formatDay(isoDate: string): string {
  return dayMonthFormat.format(new Date(isoDate)).replace(".", "");
}

export function formatDate(isoDate: string): string {
  return fullDateFormat.format(new Date(isoDate)).replace(".", "");
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  hn: "HN",
  github: "GitHub",
  reddit: "Reddit",
  x: "X",
  youtube: "YouTube",
  bluesky: "Bluesky",
  arxiv: "arXiv",
  npm: "npm",
  stackexchange: "Stack Exchange",
  wikipedia: "Wikipedia",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * Group header of the run in the inbox: "Hoy · corrida 19 oct" when it finished today.
 * `nowMinute` is the app's UTC minute tick (`YYYY-MM-DDTHH:mm`); "today" is the local day.
 */
export function runGroupLabel(run: EditorialRunSummary, nowMinute: string): string {
  const now = new Date(`${nowMinute}:00.000Z`);
  const finished = run.finishedAt === null ? null : new Date(run.finishedAt);
  const today =
    finished !== null &&
    finished.getFullYear() === now.getFullYear() &&
    finished.getMonth() === now.getMonth() &&
    finished.getDate() === now.getDate();
  return `${today ? "Hoy" : "Más reciente"} · corrida ${formatDay(run.cutoffAt)}`;
}

export type CoverageStatus = "complete" | "partial" | "unavailable";

export function coverageStatus(coverage: EditorialSourceCoverage): CoverageStatus {
  if (coverage.daysComplete >= coverage.windowDays) return "complete";
  if (coverage.daysComplete === 0 && coverage.daysPartial === 0) return "unavailable";
  return "partial";
}

export function coverageText(coverage: EditorialSourceCoverage): string {
  const label = sourceLabel(coverage.source);
  switch (coverageStatus(coverage)) {
    case "complete":
      return `${label} · ${coverage.daysComplete} de ${coverage.windowDays} días completos`;
    case "partial":
      return `${label} · ${coverage.daysComplete} de ${coverage.windowDays} días completos, ${coverage.daysPartial} parciales${coverage.daysUnavailable > 0 ? `, ${coverage.daysUnavailable} sin captura` : ""}`;
    case "unavailable":
      return `${label} · sin captura en la ventana`;
  }
}

export function trendSourceText(trend: Pick<EditorialTrendSummary, "sourceCount" | "sources">) {
  if (trend.sourceCount <= 1 && trend.sources.length === 1) {
    return `solo ${sourceLabel(trend.sources[0] ?? "")}`;
  }
  return trend.sources.map(sourceLabel).join(", ");
}

/** The engine's growth component (log scale), as words for the score metric. */
export function growthText(growth: number | null): string {
  if (growth === null) return "crecimiento sin dato";
  if (growth >= 1.5) return "crece rápido";
  if (growth >= 1) return "crece";
  return "crece despacio";
}

/**
 * "Por qué está aquí": plain rules over the deterministic numbers, so the block never says
 * more than the engine measured.
 */
export function whyHereReasons(input: {
  readonly trend: EditorialTrendSummary;
  readonly affinityThreshold: number;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
}): ReadonlyArray<string> {
  const { trend, affinityThreshold } = input;
  const reasons: Array<string> = [];

  reasons.push(
    trend.volumeRank <= 3
      ? `Entre las de más volumen esta semana: ${trend.items7d} publicaciones, #${trend.volumeRank} por volumen.`
      : `Volumen moderado esta semana: ${trend.items7d} publicaciones, #${trend.volumeRank} por volumen.`,
  );

  if (trend.items7d > 0 && trend.authors7d >= Math.max(3, trend.items7d * 0.8)) {
    reasons.push(
      `Muchos autores distintos: ${trend.authors7d} en la semana, no es una sola cuenta.`,
    );
  } else if (trend.authors7d <= 2) {
    reasons.push(
      `Pocos autores: ${trend.authors7d} en la semana; puede ser una sola conversación.`,
    );
  }

  if (trend.affinity !== null) {
    const affinity = formatDecimal(trend.affinity);
    const threshold = formatDecimal(affinityThreshold);
    reasons.push(
      trend.affinity >= affinityThreshold + 0.1
        ? `Afinidad alta con el perfil del canal: ${affinity}, umbral ${threshold}.`
        : trend.affinity >= affinityThreshold
          ? `Pasa el umbral de afinidad con el perfil por poco: ${affinity} frente a ${threshold}.`
          : `No alcanza el umbral de afinidad con el perfil: ${affinity} frente a ${threshold}.`,
    );
  }

  if (trend.growth !== null) {
    const growth = formatDecimal(trend.growth);
    reasons.push(
      trend.growth >= 1
        ? `Crecimiento semanal ${growth}: por puntaje queda #${trend.scoreRank}.`
        : `Crece despacio (${growth}), así que por puntaje queda #${trend.scoreRank}: ya es tema, no anticipación.`,
    );
  }

  const partial = input.coverage.filter((entry) => coverageStatus(entry) !== "complete");
  if (partial.length > 0) {
    reasons.push(
      `Cobertura incompleta en ${partial.map((entry) => sourceLabel(entry.source)).join(", ")}: los conteos de esa fuente son un piso.`,
    );
  }
  if (trend.sourceCount <= 1 && trend.sources.length > 0) {
    reasons.push(
      `Solo aparece en ${sourceLabel(trend.sources[0] ?? "")}: sin corroboración de otra fuente.`,
    );
  }
  return reasons;
}
