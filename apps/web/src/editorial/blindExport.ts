import type { EditorialRunSummary, EditorialTrendSummary } from "@t3tools/contracts";

import {
  cardCoverageLine,
  cardCurveLine,
  cardFitLine,
  cardMovementLine,
  cardTitle,
  SECTION_TITLES,
} from "./trendCard.logic";

// Blind export of a run's cards for the reviewers of the pairs (contract §1 and §5b, `--blind`).
// A whitelist: the card's text and its evidence. No judge opinion, no arm, no position or rank,
// no provenance (run, dossier, trend key, engine, model, drafting provider) and no decision of
// the operator. Cards are sorted by an opaque reference, so the order tells nothing either.

const BLIND_EXPORT_SCHEMA = "earlyscript.cards-blind/1";

export interface BlindCardItem {
  readonly item_id: string | null;
  readonly source: string;
  readonly title: string;
  readonly day: string | null;
  readonly url: string | null;
}

export interface BlindCard {
  readonly ref: string;
  readonly section: string | null;
  readonly title: string;
  readonly movement: string | null;
  readonly curve: string;
  readonly fit: string;
  readonly coverage: string | null;
  readonly evidence: ReadonlyArray<BlindCardItem>;
}

export interface BlindExport {
  readonly schema: typeof BLIND_EXPORT_SCHEMA;
  readonly cards: ReadonlyArray<BlindCard>;
}

/** FNV-1a, 32 bits: a stable reference that does not reveal the run or the dossier. */
function opaqueRef(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `t-${hash.toString(16).padStart(8, "0")}`;
}

export function blindCards(
  run: Pick<EditorialRunSummary, "cutoffAt">,
  trends: ReadonlyArray<EditorialTrendSummary>,
): BlindExport {
  const cards = trends.flatMap((trend): ReadonlyArray<BlindCard> => {
    const card = trend.card;
    if (card === undefined) return [];
    return [
      {
        ref: opaqueRef(`${trend.runId}/${trend.dossierId}`),
        section: card.section === null ? null : SECTION_TITLES[card.section],
        title: cardTitle(trend),
        movement: cardMovementLine(card, run.cutoffAt),
        curve: cardCurveLine(card, run.cutoffAt),
        fit: cardFitLine(card),
        coverage: cardCoverageLine(card),
        evidence: card.evidence.map((item) => ({
          item_id: item.itemId,
          source: item.source,
          title: item.title,
          day: item.day,
          url: item.url,
        })),
      },
    ];
  });
  return {
    schema: BLIND_EXPORT_SCHEMA,
    cards: cards.toSorted((a, b) => a.ref.localeCompare(b.ref)),
  };
}

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim();

export function blindCardsMarkdown(exported: BlindExport): string {
  const lines = [
    "# Tarjetas de tendencias, exportación ciega",
    "",
    `Esquema \`${exported.schema}\`. Solo el texto de cada tarjeta y su evidencia; el orden es el de su referencia. Los títulos son material de las fuentes.`,
    "",
  ];
  for (const card of exported.cards) {
    lines.push(`## ${card.ref} · ${oneLine(card.title)}`, "");
    if (card.section !== null) lines.push(`- Sección: ${card.section}`);
    if (card.movement !== null) lines.push(`- ${card.movement}`);
    lines.push(`- ${card.curve}`);
    if (card.fit.length > 0) lines.push(`- ${card.fit}`);
    if (card.coverage !== null) lines.push(`- ${card.coverage}`);
    lines.push("", "Evidencia:", "");
    for (const item of card.evidence) {
      lines.push(
        `- [${item.item_id ?? "sin id"}] ${oneLine(item.title)} · ${item.source}${item.day === null ? "" : ` · ${item.day}`}${item.url === null ? "" : ` · ${item.url}`}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function downloadTextFile(filename: string, contents: string, type: string): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
