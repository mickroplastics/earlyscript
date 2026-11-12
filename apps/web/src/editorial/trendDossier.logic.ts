import {
  decisionActionText,
  shortTopic,
  type EditorialCardDecision,
  type EditorialEvidenceItem,
  type EditorialSourceCoverage,
  type EditorialTrendCard,
  type EditorialTrendMovement,
  type EditorialTrendSummary,
} from "@t3tools/contracts";

import {
  coverageStatus,
  dayRangeText,
  formatDate,
  snoozeStateText,
  sourceName,
} from "./editorial.logic";

// Pure half of the trend dossier page (ficha v2): the weekly movement, the decision panel and
// the evidence it shows. Words only; no scores, ranks, growth or affinity reach the screen.

const WEEKS = 4;
const DAY_MS = 86_400_000;

export interface MovementSeries {
  /** Source code, "hn"; "total" for an older dossier without a curve by source. */
  readonly source: string;
  readonly name: string;
  readonly partial: boolean;
  /** W3..W0; `null` is a week the source did not capture. */
  readonly weeks: ReadonlyArray<number | null>;
}

export interface MovementChart {
  /** Rows with at least one week above zero. */
  readonly series: ReadonlyArray<MovementSeries>;
  /** Comparable or partial sources without a single item in the four weeks. */
  readonly quiet: ReadonlyArray<string>;
  /** Captured but not clustered (Wikipedia). */
  readonly unused: ReadonlyArray<string>;
  /** Items per week over the series; `null` when any series misses that week. */
  readonly totals: ReadonlyArray<number | null>;
  /** Highest weekly value of a series, at least 1. */
  readonly max: number;
}

const weeksOf = (weeks: ReadonlyArray<number | null>) =>
  Array.from({ length: WEEKS }, (_, index) => weeks[index] ?? null);

export function movementChart(card: Pick<EditorialTrendCard, "curve">): MovementChart {
  const series: Array<MovementSeries> = [];
  const quiet: Array<string> = [];
  const unused: Array<string> = [];
  for (const row of card.curve) {
    if (row.status === "unused") {
      unused.push(row.source);
      continue;
    }
    const weeks = weeksOf(row.weeks);
    if (weeks.some((week) => week !== null && week > 0)) {
      series.push({
        source: row.source,
        name: sourceName(row.source),
        partial: row.status === "partial",
        weeks,
      });
    } else {
      quiet.push(row.source);
    }
  }
  const totals = Array.from({ length: WEEKS }, (_, index) => {
    let total = 0;
    for (const entry of series) {
      const week = entry.weeks[index] ?? null;
      if (week === null) return null;
      total += week;
    }
    return total;
  });
  const max = Math.max(1, ...series.flatMap((entry) => entry.weeks.map((week) => week ?? 0)));
  return { series, quiet, unused, totals, max };
}

/**
 * W3..W0 as day ranges. W0 is the seven days ending the day before the cutoff's UTC day, as
 * `packages/trend-engine/src/comparable.ts` counts them.
 */
export function weekRangeLabels(cutoffAt: string | null): ReadonlyArray<string> {
  const cutoffDay =
    cutoffAt === null ? Number.NaN : Date.parse(`${cutoffAt.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(cutoffDay)) {
    return ["Hace 3 sem.", "Hace 2 sem.", "Semana anterior", "Última semana"];
  }
  return Array.from({ length: WEEKS }, (_, index) => {
    const k = WEEKS - 1 - index;
    const end = cutoffDay - (7 * k + 1) * DAY_MS;
    return dayRangeText(new Date(end - 6 * DAY_MS), new Date(end));
  });
}

/** The figure next to the chart: W0's items and how W1 compares in words. */
export function movementHeadline(chart: Pick<MovementChart, "totals">): {
  readonly count: number | null;
  readonly last: string;
  readonly previous: string | null;
} {
  const last = chart.totals[WEEKS - 1] ?? null;
  const previous = chart.totals[WEEKS - 2] ?? null;
  return {
    count: last,
    last: last === null ? "Última semana sin captura completa" : "en la última semana",
    previous: previous === null ? "la anterior sin captura" : `${previous} la anterior`,
  };
}

const listFormat = new Intl.ListFormat("es", { type: "conjunction" });
const names = (sources: ReadonlyArray<string>) => listFormat.format(sources.map(sourceName));

/**
 * "Sin publicaciones en GitHub y npm." for the quiet sources, with the caveat when one of them
 * was not fully captured: a zero there does not confirm absence.
 */
export function quietSourcesText(
  chart: Pick<MovementChart, "quiet">,
  coverage: ReadonlyArray<EditorialSourceCoverage>,
  incompleteSources: ReadonlyArray<string>,
): {
  readonly text: string;
  readonly caveat: string | null;
  readonly caveatSources: ReadonlyArray<string>;
} | null {
  if (chart.quiet.length === 0) return null;
  const partial = chart.quiet.filter((source) => {
    if (incompleteSources.includes(source)) return true;
    const entry = coverage.find((candidate) => candidate.source === source);
    return entry !== undefined && coverageStatus(entry) !== "complete";
  });
  return {
    text: `Sin publicaciones en ${names(chart.quiet)}.`,
    caveat:
      partial.length === 0
        ? null
        : `Captura parcial en ${names(partial)}: un cero no confirma ausencia.`,
    caveatSources: partial,
  };
}

/** `incompleteSources` the quiet-sources caveat did not already name. */
export function incompleteSourcesText(
  incompleteSources: ReadonlyArray<string>,
  alreadySaid: ReadonlyArray<string>,
): string | null {
  const rest = incompleteSources.filter((source) => !alreadySaid.includes(source));
  return rest.length === 0
    ? null
    : `Cobertura incompleta en ${names(rest)}: alguna semana tiene días sin captura.`;
}

/** "28 de 28", "7 de 28 · 21 parciales": the days a source captured in the window. */
export function coverageDaysText(entry: EditorialSourceCoverage): string {
  const partial =
    entry.daysPartial === 0
      ? ""
      : ` · ${entry.daysPartial} ${entry.daysPartial === 1 ? "parcial" : "parciales"}`;
  return `${entry.daysComplete} de ${entry.windowDays}${partial}`;
}

export type MovementBadgeVariant = "info" | "warning" | "outline" | "secondary";

const MOVEMENT_BADGES: Readonly<
  Record<EditorialTrendMovement, { readonly label: string; readonly variant: MovementBadgeVariant }>
> = {
  new: { label: "Nueva", variant: "info" },
  rebound: { label: "Rebote", variant: "warning" },
  strong: { label: "Señal fuerte", variant: "info" },
  weak: { label: "Señal débil", variant: "outline" },
  stable: { label: "Estable", variant: "secondary" },
  falling: { label: "En caída", variant: "secondary" },
};

export function movementBadge(
  card: Pick<EditorialTrendCard, "movement">,
): { readonly label: string; readonly variant: MovementBadgeVariant } | null {
  return card.movement === null ? null : MOVEMENT_BADGES[card.movement];
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Editado · utilidad 4 de 5", "Aceptado". */
function decisionHeadline(decision: Pick<EditorialCardDecision, "action" | "utility">) {
  const action = capitalize(decisionActionText(decision.action));
  return decision.utility === null ? action : `${action} · utilidad ${decision.utility} de 5`;
}

export type DecisionPrimary =
  | { readonly kind: "open"; readonly threadId: string; readonly prepare: boolean }
  | { readonly kind: "create" }
  | { readonly kind: "reopen" };

export interface DecisionPanelState {
  readonly headline: string;
  /** The operator's reason, shown between quotes. */
  readonly reason: string | null;
  readonly meta: string | null;
  /** Snooze state, below the decision. */
  readonly stateLine: string | null;
  /** A decision on the same topic from another thread than `card.decision`. */
  readonly prior: EditorialCardDecision | null;
  /** "Antes lo decidiste el …" when the trend has its own decision too. */
  readonly priorLine: string | null;
  /** `null`: a server without trend keys, nothing to decide with. */
  readonly primary: DecisionPrimary | null;
  readonly badge: {
    readonly label: string;
    readonly variant: "success" | "info" | "secondary" | "outline";
  } | null;
}

type PanelTrend = Pick<EditorialTrendSummary, "trendKey" | "inbox" | "card">;

const UNDECIDED_META = "Lee la evidencia y decide si merece un video.";

/** What the decision panel says and offers for a trend's state (spec §3.2). */
export function decisionPanelState(trend: PanelTrend): DecisionPanelState {
  if (trend.trendKey === undefined) {
    return {
      headline:
        "Este servidor no identifica la tendencia entre corridas; actualízalo para decidir.",
      reason: null,
      meta: null,
      stateLine: null,
      prior: null,
      priorLine: null,
      primary: null,
      badge: null,
    };
  }
  const state = trend.inbox;
  const decision = trend.card?.decision ?? null;
  const priorDecision = trend.card?.priorDecision ?? null;
  const prior =
    priorDecision !== null && priorDecision.threadId !== decision?.threadId ? priorDecision : null;
  const production = state?.production ?? null;
  const snoozed = state?.snoozed ?? null;
  const dismissed = state?.dismissed ?? null;

  const badge: DecisionPanelState["badge"] = dismissed
    ? { label: "Descartada", variant: "outline" }
    : decision
      ? { label: "Decidida", variant: "success" }
      : production
        ? { label: "En producción", variant: "info" }
        : snoozed
          ? { label: "En observación", variant: "secondary" }
          : null;

  const primary: DecisionPrimary = dismissed
    ? { kind: "reopen" }
    : decision
      ? {
          kind: "open",
          threadId: decision.threadId,
          prepare: production?.threadId === decision.threadId,
        }
      : production
        ? { kind: "open", threadId: production.threadId, prepare: true }
        : { kind: "create" };

  const priorLine =
    prior !== null && (decision !== null || dismissed !== null)
      ? `Antes lo decidiste el ${formatDate(prior.decidedAt)}: ${decisionActionText(prior.action)}.`
      : null;
  const stateLine = snoozed && !dismissed ? snoozeStateText(snoozed) : null;
  const base = { stateLine, prior, priorLine, primary, badge };

  if (dismissed) {
    return {
      ...base,
      headline: `Descartada el ${formatDate(dismissed.at)}`,
      reason: dismissed.reason,
      meta: null,
    };
  }
  if (decision) {
    return {
      ...base,
      headline: decisionHeadline(decision),
      reason: decision.reason,
      meta: `Tu decisión · ${formatDate(decision.decidedAt)}`,
    };
  }
  if (production) {
    return {
      ...base,
      headline: `En producción desde el ${formatDate(production.linkedAt)}`,
      reason: null,
      meta: null,
    };
  }
  if (prior) {
    return {
      ...base,
      headline: `Ya decidiste este tema el ${formatDate(prior.decidedAt)}`,
      reason: null,
      meta: [decisionHeadline(prior), prior.reason === null ? null : `«${prior.reason}»`]
        .filter((part) => part !== null)
        .join(" · "),
    };
  }
  return { ...base, headline: "Sin decidir", reason: null, meta: UNDECIDED_META };
}

/** `alsoIn` of the card's evidence by item id; the dossier's own evidence does not carry it. */
export function evidenceAlsoIn(
  card: Pick<EditorialTrendCard, "evidence"> | undefined,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const map = new Map<string, ReadonlyArray<string>>();
  for (const item of card?.evidence ?? []) {
    if (item.itemId !== null && item.alsoIn && item.alsoIn.length > 0) {
      map.set(item.itemId, item.alsoIn);
    }
  }
  return map;
}

export const EVIDENCE_PREVIEW_COUNT = 3;

/** The first three items, or every loaded one once the operator asked for all. */
export function shownEvidence(
  first: ReadonlyArray<EditorialEvidenceItem>,
  all: ReadonlyArray<EditorialEvidenceItem> | null,
  expanded: boolean,
): ReadonlyArray<EditorialEvidenceItem> {
  if (!expanded) return first.slice(0, EVIDENCE_PREVIEW_COUNT);
  return all ?? first;
}

/** "Tema del perfil: developer tooling · términos: agent, agents", or its absence. */
export function profileFitText(fit: EditorialTrendCard["fit"]): string {
  if (fit.topic === null) return "Sin tema del perfil cercano.";
  const terms = fit.terms.slice(0, 3);
  return `Tema del perfil: ${shortTopic(fit.topic)}${terms.length === 0 ? "" : ` · términos: ${terms.join(", ")}`}`;
}
