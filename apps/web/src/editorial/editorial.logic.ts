import type {
  EditorialEvidenceItem,
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

/** Accessible name of a space tab, whole even when its label is truncated or an icon. */
export function spaceTabName(label: string, newCount: number | null): string {
  return newCount === null ? label : `${label}, ${newCount} ${newCount === 1 ? "nueva" : "nuevas"}`;
}

/** The new-trends counter on the tab: two digits at most. */
export function compactCount(count: number): string {
  return count > 99 ? "99+" : String(count);
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

/**
 * Decides whether the root lands in an editorial space. `claim` records what this session
 * already decided: `"editorial"` keeps the claim while the redirect resolves, `"upstream"` and
 * `"done"` give "/" back to upstream for the rest of the session. Shared by `EditorialLanding`
 * and by the bootstrap-thread guard in `__root.tsx`, so both read the same rule.
 */
export type RootLandingClaim = "pending" | "editorial" | "upstream" | "done";

export function editorialClaimsRoot(input: {
  readonly pathname: string;
  readonly claim: RootLandingClaim;
  readonly state: EnvironmentSpaceState;
}): boolean {
  if (input.pathname !== "/") return false;
  switch (input.claim) {
    case "pending":
      return resolveLandingTarget(input.state) !== null;
    case "editorial":
      return true;
    case "upstream":
    case "done":
      return false;
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

/** Evidence opens outside the app: only `http:` and `https:` URLs are links. */
function webUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The title link prefers the external URL and falls back to the permalink; the discussion link
 * shows only when both are valid and differ. The server already drops other schemes; this
 * revalidates in case an older server answers.
 */
export function evidenceLinks(item: Pick<EditorialEvidenceItem, "permalink" | "externalUrl">): {
  readonly title: string | null;
  readonly discussion: string | null;
} {
  const permalink = webUrl(item.permalink);
  const external = webUrl(item.externalUrl);
  return {
    title: external ?? permalink,
    discussion:
      external !== null && permalink !== null && permalink !== external ? permalink : null,
  };
}

/** "Evidencia seleccionada (10) · 9 sept 2026 – 16 oct 2026": the selection, not the window. */
export function evidenceHeading(
  total: number,
  range: { readonly from: string; readonly to: string } | null,
): string {
  const heading = `Evidencia seleccionada (${total})`;
  if (range === null) return heading;
  const from = formatDate(range.from);
  const to = formatDate(range.to);
  return `${heading} · ${from === to ? from : `${from} – ${to}`}`;
}

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

/**
 * Bands of the engine's growth component (`growth`, log scale of the recent rate against the
 * earlier one): below 0 "en descenso"; 0 up to 0.3 "estable"; 0.3 up to 1.0 "crece"; above 1.0
 * "crece rápido". A band names the measured value, never a cause or a forecast.
 */
export type GrowthBand = "en descenso" | "estable" | "crece" | "crece rápido";

export function growthBand(growth: number): GrowthBand {
  if (growth < 0) return "en descenso";
  if (growth < 0.3) return "estable";
  if (growth <= 1) return "crece";
  return "crece rápido";
}

/** The growth component as words and value for the score metric. */
export function growthText(growth: number | null): string {
  if (growth === null) return "crecimiento sin dato";
  return `${growthBand(growth)} (${formatDecimal(growth)})`;
}

/**
 * "Por qué está aquí": plain rules over the deterministic numbers. Each bullet states one
 * measured fact (volume, authors, affinity against its threshold, growth band and value, score
 * position, coverage, sources) and never a cause, a consequence or an anticipation claim.
 */
export function whyHereReasons(input: {
  readonly trend: EditorialTrendSummary;
  readonly affinityThreshold: number;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
}): ReadonlyArray<string> {
  const { trend, affinityThreshold } = input;
  const reasons: Array<string> = [];

  reasons.push(`${trend.items7d} publicaciones esta semana: #${trend.volumeRank} por volumen.`);

  if (trend.items7d > 0) {
    reasons.push(
      `${trend.authors7d} ${trend.authors7d === 1 ? "autor distinto" : "autores distintos"} en las publicaciones de la semana.`,
    );
  }

  if (trend.affinity !== null) {
    const affinity = formatDecimal(trend.affinity);
    const threshold = formatDecimal(affinityThreshold);
    reasons.push(
      trend.affinity >= affinityThreshold
        ? `Afinidad con el perfil del canal ${affinity}, sobre el umbral ${threshold}.`
        : `Afinidad con el perfil del canal ${affinity}, bajo el umbral ${threshold}.`,
    );
  }

  if (trend.growth !== null) {
    reasons.push(
      `Crecimiento ${formatDecimal(trend.growth)} en escala logarítmica: ${growthBand(trend.growth)}.`,
    );
  }
  reasons.push(`#${trend.scoreRank} por puntaje (${formatDecimal(trend.score)}).`);

  const partial = input.coverage.filter((entry) => coverageStatus(entry) !== "complete");
  if (partial.length > 0) {
    reasons.push(
      `Cobertura incompleta en ${partial.map((entry) => sourceLabel(entry.source)).join(", ")}.`,
    );
  }
  if (trend.sourceCount <= 1 && trend.sources.length > 0) {
    reasons.push(`Solo aparece en ${sourceLabel(trend.sources[0] ?? "")}.`);
  }
  return reasons;
}
