import type {
  ContextMenuItem,
  EditorialEvidenceItem,
  EditorialRunSummary,
  EditorialSnoozeMetric,
  EditorialSourceCoverage,
  EditorialTrendInboxState,
  EditorialTrendSummary,
} from "@t3tools/contracts";

import type { EditorialSpace, EnvironmentSpaceState } from "./spaceStore";

/** Decision 5 of doc 04: up to ten new trends visible, the rest folded behind "ver N más". */
const INBOX_VISIBLE_COUNT = 10;

const THREAD_ROUTE_IDS: ReadonlySet<string> = new Set([
  "/_chat/$environmentId/$threadId",
  "/_chat/draft/$draftId",
]);

const RESULTS_ROUTE_ID = "/_chat/editorial/$environmentId/results";

/**
 * The space a route belongs to; `null` for pages that keep the last space's list in the
 * sidebar (Results, Settings, Usage).
 */
export function resolveRouteSpace(routeId: string | undefined): EditorialSpace | null {
  if (routeId === undefined) return null;
  if (routeId.startsWith("/_chat/editorial/$environmentId/trends")) return "trends";
  if (THREAD_ROUTE_IDS.has(routeId)) return "threads";
  return null;
}

export function isResultsRouteId(routeId: string | undefined): boolean {
  return routeId === RESULTS_ROUTE_ID;
}

/**
 * The space a tab press opens: another space, or the one shown when the page on screen is not
 * one of its own (Results, Settings), so its tab still leads to it. `null` stays put.
 */
export function spaceTabTarget(input: {
  readonly pressed: EditorialSpace | undefined;
  readonly shown: EditorialSpace;
  readonly routeSpace: EditorialSpace | null;
}): EditorialSpace | null {
  // Pressing the pressed tab of a toggle group deselects it: that press names the shown space.
  const target = input.pressed ?? input.shown;
  return target !== input.shown || input.routeSpace !== input.shown ? target : null;
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

export type EditorialLandingTarget = {
  readonly space: "trends";
  readonly trend: EnvironmentSpaceState["trend"];
};

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

type InboxTrend = Pick<EditorialTrendSummary, "isNew" | "inbox">;

/**
 * The inbox as the sidebar shows it, in the server's order: the active list (its first ten
 * visible, the rest folded), then "En observación" and "Descartadas". A dismissed trend that
 * was also snoozed counts as dismissed; a trend in production stays in the active list.
 */
export function inboxSections<T extends InboxTrend>(trends: ReadonlyArray<T>) {
  const active: Array<T> = [];
  const snoozed: Array<T> = [];
  const dismissed: Array<T> = [];
  for (const trend of trends) {
    if (trend.inbox?.dismissed) dismissed.push(trend);
    else if (trend.inbox?.snoozed) snoozed.push(trend);
    else active.push(trend);
  }
  return {
    ...splitInbox(active),
    snoozed,
    dismissed,
    newCount: active.filter((trend) => trend.isNew).length,
  };
}

const SNOOZE_METRIC_LABELS: Readonly<Record<EditorialSnoozeMetric, string>> = {
  items7d: "publicaciones en 7 días",
  authors7d: "autores en 7 días",
  items28d: "publicaciones en 28 días",
  score: "de puntaje",
};

const wakeFormat = new Intl.DateTimeFormat("es", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** "En observación: vuelve con 14 publicaciones en 7 días (hoy 11)." The wake time is local. */
export function snoozeStateText(snoozed: NonNullable<EditorialTrendInboxState["snoozed"]>) {
  const growth = snoozed.returnWhen
    ? `vuelve con ${formatMetric(snoozed.returnWhen.atLeast)} ${SNOOZE_METRIC_LABELS[snoozed.returnWhen.metric]} (hoy ${formatMetric(snoozed.returnWhen.baseline)})`
    : null;
  const until = snoozed.until
    ? `vuelve el ${wakeFormat.format(new Date(snoozed.until)).replaceAll(".", "")}`
    : null;
  const parts = [growth, until].filter((part) => part !== null);
  return parts.length === 0 ? "En observación." : `En observación: ${parts.join(" o ")}.`;
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : formatDecimal(value);
}

const SNOOZE_LABELS_ES: Readonly<Record<string, string>> = {
  "This morning": "Esta mañana",
  "This afternoon": "Esta tarde",
  "This evening": "Esta noche",
  Tomorrow: "Mañana",
  "Next week": "La próxima semana",
};

const WEEKDAYS_ES: Readonly<Record<string, string>> = {
  Sunday: "domingo",
  Monday: "lunes",
  Tuesday: "martes",
  Wednesday: "miércoles",
  Thursday: "jueves",
  Friday: "viernes",
  Saturday: "sábado",
};

const DURATION_UNITS_ES: Readonly<Record<string, readonly [string, string]>> = {
  minute: ["minuto", "minutos"],
  hour: ["hora", "horas"],
  day: ["día", "días"],
};

/**
 * A thread snooze preset label (`resolveSnoozePresets`, in English) in the editorial space's
 * Spanish. The presets, their times and their order stay T3's; a label this table does not
 * know is shown as T3 wrote it.
 */
export function snoozePresetLabel(label: string): string {
  const duration = /^In (\d+) (minute|hour|day)s?$/.exec(label);
  if (duration) {
    const count = Number(duration[1]);
    const units = ownValue(DURATION_UNITS_ES, duration[2] ?? "");
    if (units) return `En ${count} ${count === 1 ? units[0] : units[1]}`;
  }
  const next = /^Next (\w+)$/.exec(label);
  const nextDay = next ? ownValue(WEEKDAYS_ES, next[1] ?? "") : undefined;
  if (nextDay) return `El próximo ${nextDay}`;
  const day = ownValue(WEEKDAYS_ES, label);
  if (day) return `El ${day}`;
  return ownValue(SNOOZE_LABELS_ES, label) ?? label;
}

/** A table's own entry: `constructor` or `toString` are not labels. */
function ownValue<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export type TrendMenuAction =
  | "create-video"
  | "open-video"
  | "keep-watching"
  | `snooze:${string}`
  | "return-to-inbox"
  | "dismiss"
  | "reopen";

/**
 * The row's context menu: the dossier's three exits, each replaced by its way back once taken.
 * "Seguir observando" waits for growth or for one of the thread snooze times. There is no
 * "mark unread": the server keeps no command that forgets a read.
 */
export function trendMenuItems(
  state: EditorialTrendInboxState | undefined,
  snoozePresets: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly whenLabel: string;
  }>,
): ReadonlyArray<ContextMenuItem<TrendMenuAction>> {
  const items: Array<ContextMenuItem<TrendMenuAction>> = [
    state?.production
      ? { id: "open-video", label: "Abrir hilo de video", icon: "message-square" }
      : { id: "create-video", label: "Crear hilo de video", icon: "message-square-plus" },
  ];
  if (state?.snoozed) {
    items.push({ id: "return-to-inbox", label: "Volver a la bandeja", icon: "clock" });
  } else if (!state?.dismissed) {
    items.push({
      id: "keep-watching",
      label: "Seguir observando",
      icon: "clock",
      children: [
        { id: "keep-watching", label: "Hasta que crezca" },
        ...snoozePresets.map((preset, index) => ({
          id: `snooze:${preset.id}` as const,
          label: `${snoozePresetLabel(preset.label)} (${preset.whenLabel})`,
          separatorBefore: index === 0,
        })),
        { id: "snooze:custom", label: "Personalizado…", separatorBefore: true },
      ],
    });
  }
  items.push(
    state?.dismissed
      ? { id: "reopen", label: "Reabrir", icon: "refresh-cw", separatorBefore: true }
      : { id: "dismiss", label: "Descartar…", icon: "archive", separatorBefore: true },
  );
  return items;
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

function formatDecimal(value: number): string {
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
  // The inbox never shows an invalid run, the only kind without a cutoff.
  const cutoff = run.cutoffAt === null ? "sin corte" : formatDay(run.cutoffAt);
  return `${today ? "Hoy" : "Más reciente"} · corrida ${cutoff}`;
}

export type CoverageStatus = "complete" | "partial" | "unavailable";

export function coverageStatus(coverage: EditorialSourceCoverage): CoverageStatus {
  if (coverage.daysComplete >= coverage.windowDays) return "complete";
  if (coverage.daysComplete === 0 && coverage.daysPartial === 0) return "unavailable";
  return "partial";
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

export type CitationSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "citation";
      readonly itemId: string;
      /** 1-based position in the dossier's evidence, as the evidence list numbers it. */
      readonly number: number;
      readonly item: EditorialEvidenceItem;
    };

/** Same marker the server validates: `[itemId]`, without spaces or nested brackets. */
const INLINE_CITATION = /\[([^[\]\s]+)\]/g;

/**
 * Splits an assistant summary into text and `[itemId]` citations of known evidence. A marker
 * for an id the dossier does not list stays as written; the server already warned about it.
 * The space before a citation is dropped so the number sits against its claim.
 */
export function citationSegments(
  text: string,
  evidence: ReadonlyArray<EditorialEvidenceItem>,
): ReadonlyArray<CitationSegment> {
  const known = new Map(evidence.map((item, index) => [item.itemId, { item, number: index + 1 }]));
  const segments: CitationSegment[] = [];
  let cursor = 0;
  const pushText = (value: string) => {
    if (value.length === 0) return;
    const last = segments.at(-1);
    if (last?.kind === "text")
      segments[segments.length - 1] = { kind: "text", text: last.text + value };
    else segments.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(INLINE_CITATION)) {
    const itemId = match[1] ?? "";
    const entry = known.get(itemId);
    const start = match.index;
    if (entry === undefined) {
      pushText(text.slice(cursor, start + match[0].length));
    } else {
      pushText(text.slice(cursor, start).replace(/\s+$/, ""));
      segments.push({ kind: "citation", itemId, number: entry.number, item: entry.item });
    }
    cursor = start + match[0].length;
  }
  pushText(text.slice(cursor));
  return segments;
}

/** "3/18 redactadas" while drafting a run; counts ready ones, failures are listed apart. */
export function runPresentationProgressText(progress: {
  readonly total: number;
  readonly ready: number;
  readonly failed: number;
}): string {
  const base = `${progress.ready}/${progress.total} ${progress.total === 1 ? "redactada" : "redactadas"}`;
  return progress.failed > 0
    ? `${base} · ${progress.failed} ${progress.failed === 1 ? "falló" : "fallaron"}`
    : base;
}
