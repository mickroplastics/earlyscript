import {
  agoText,
  cardMovementText,
  curveRowText,
  firstSourceText,
  fitText,
  incompleteCoverageText,
  saturatedText,
  sourceCountText,
  type EditorialCardItem,
  type EditorialTrendCard,
  type EditorialTrendSummary,
  trendTitle,
} from "@t3tools/contracts";

// Pure half of the brief trend card (engine v3, contract §1): its three lines, its sections and
// its evidence by source. The words come from `editorialCard.ts` in the contracts, so the card
// and the dossier file (`expediente.md`) say the same thing.

type CardTrend = Pick<EditorialTrendSummary, "label" | "presentation" | "card">;

export const cardTitle = (trend: CardTrend): string => trendTitle(trend);

/** Line 1 after the title: movement, since when, perennial mark. */
export const cardMovementLine = (card: EditorialTrendCard, cutoffAt: string | null) =>
  cardMovementText(card, cutoffAt);

/** Line 2: the curve by source, the number of sources and where it appeared first. */
export function cardCurveLine(card: EditorialTrendCard, cutoffAt: string | null): string {
  return [
    ...card.curve.map(curveRowText),
    sourceCountText(card.sourceCount),
    card.firstSource === null ? null : firstSourceText(card.firstSource, cutoffAt),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
}

/** Line 3 before the headlines: fit with the profile and saturation. */
export function cardFitLine(card: EditorialTrendCard): string {
  return [fitText(card.fit), saturatedText(card.saturated)]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export const cardCoverageLine = (card: EditorialTrendCard) =>
  incompleteCoverageText(card.incompleteSources);

/** "en npm hace 12 días": the second source, in the detail. */
export const secondSourceText = (card: EditorialTrendCard, cutoffAt: string | null) =>
  card.secondSource === null
    ? null
    : `después en ${card.secondSource.source} ${agoText(card.secondSource.day, cutoffAt)}`;

/** Evidence by source, sources in order of their first item (W0 first), items kept in order. */
export function evidenceBySource(
  items: ReadonlyArray<EditorialCardItem>,
): ReadonlyArray<{ readonly source: string; readonly items: ReadonlyArray<EditorialCardItem> }> {
  const groups = new Map<string, Array<EditorialCardItem>>();
  for (const item of items) {
    const group = groups.get(item.source);
    if (group === undefined) groups.set(item.source, [item]);
    else group.push(item);
  }
  return [...groups].map(([source, grouped]) => ({ source, items: grouped }));
}

/**
 * "En movimiento" and "De fondo" in the engine's order. A run whose cards have no section (an
 * older run) gives `null`: the inbox keeps its single list.
 */
export function cardSections<T extends Pick<EditorialTrendSummary, "card" | "dossierId">>(
  trends: ReadonlyArray<T>,
): { readonly moving: ReadonlyArray<T>; readonly background: ReadonlyArray<T> } | null {
  if (!trends.some((trend) => trend.card?.section != null)) return null;
  const byPosition = (a: T, b: T) =>
    (a.card?.position ?? Number.MAX_SAFE_INTEGER) - (b.card?.position ?? Number.MAX_SAFE_INTEGER) ||
    a.dossierId.localeCompare(b.dossierId);
  return {
    moving: trends.filter((trend) => trend.card?.section !== "background").toSorted(byPosition),
    background: trends.filter((trend) => trend.card?.section === "background").toSorted(byPosition),
  };
}

export const SECTION_TITLES = { moving: "En movimiento", background: "De fondo" } as const;
