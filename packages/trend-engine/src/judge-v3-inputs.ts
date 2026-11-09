// Builds the closed CardInputV3 from the P2 partition cards, the maqueta of Opus M and A's list
// files. Expected list file (until A delivers the v3 dossier): { cutoff, arm, moving: Entry[] },
// where Entry is a CardInputV3 with topic_id, or { topic_id, card_v3 }, or a maqueta card.
// Only fields of the closed list are copied; a field the source lacks stays absent.
import type { CardInputV3, CurveRowV3, Movement } from "./card-text-v3.ts";

/** A P2 card row (prueba-retro.jsonl): terms and headlines with absolute timestamps. */
export interface P2CardRow {
  readonly card_id: string;
  readonly topic_id: string;
  readonly cutoff: string;
  readonly terms: ReadonlyArray<string>;
  readonly headlines: ReadonlyArray<{
    readonly title: string;
    readonly source: string;
    readonly published_at: string;
  }>;
}

export const fromP2Card = (card: P2CardRow): CardInputV3 => ({
  cutoff: card.cutoff,
  terms: card.terms,
  headlines: card.headlines.map((h, k) => ({
    id: `${card.card_id}#${k}`,
    title: h.title,
    source: h.source,
    published_at: h.published_at,
  })),
});

const MAQUETA_MOVEMENT: Record<string, Movement> = {
  nueva: "new",
  "señal débil": "weak",
  "señal fuerte": "strong",
  rebote: "rebound",
  "en caída": "falling",
  estable: "stable",
};

const MAQUETA_STATUS: Record<string, CurveRowV3["status"]> = {
  comparable: "comparable",
  parcial: "partial",
  "no usada": "unused",
};

/** A card of maqueta-cortes.json (cuts[].cards[] or background[]). */
export interface MaquetaCard {
  readonly signal_id: string;
  readonly label: string;
  readonly state: string;
  readonly since?: string | null;
  readonly weeks_by_source?: ReadonlyArray<{
    readonly source: string;
    readonly status: string;
    readonly weeks: ReadonlyArray<number | null> | null;
  }>;
  readonly first_source?: string | null;
  readonly first_day?: string | null;
  readonly second_source?: string | null;
  readonly second_day?: string | null;
  readonly perennial_antecedent?: boolean;
  readonly keyword_hits?: ReadonlyArray<{ readonly term: string; readonly items: number }>;
  readonly life?: number;
  readonly headlines: ReadonlyArray<{
    readonly title: string;
    readonly source: string;
    readonly url?: string;
    readonly day: string;
  }>;
}

export function fromMaquetaCard(card: MaquetaCard, cutoff: string): CardInputV3 {
  const movement = MAQUETA_MOVEMENT[card.state];
  if (!movement && card.state !== "otro") throw new Error(`unknown maqueta state ${card.state}`);
  return {
    cutoff,
    terms: card.label.split(/\s+/).filter(Boolean),
    movement: movement ?? null,
    entered_at: card.since ?? null,
    first_at: card.first_day ?? null,
    perennial: card.perennial_antecedent ?? null,
    curve: (card.weeks_by_source ?? []).map((row) => {
      const status = MAQUETA_STATUS[row.status];
      if (!status) throw new Error(`unknown maqueta source status ${row.status}`);
      return { source: row.source, status, weeks: row.weeks };
    }),
    first_source:
      card.first_source && card.first_day
        ? { source: card.first_source, at: card.first_day }
        : null,
    second_source:
      card.second_source && card.second_day
        ? { source: card.second_source, at: card.second_day }
        : null,
    matched_terms: card.keyword_hits ?? null,
    life_items: card.life ?? null,
    // The maqueta has no item ids: the URL (or position) names the item. A day is read as the
    // start of that UTC day, so an item of the day before t is "1 day ago".
    headlines: card.headlines.map((h, k) => ({
      id: h.url ?? `${card.signal_id}#${k}`,
      title: h.title,
      source: h.source,
      published_at: h.day,
    })),
  };
}

export interface ListEntry {
  readonly topic_id: string;
  readonly card: CardInputV3;
}

const isMaqueta = (x: Record<string, unknown>) =>
  typeof x.signal_id === "string" && Array.isArray(x.headlines) && typeof x.state === "string";

/** Reads one entry of a list file in A's interface or in the maqueta's shape. */
export function listEntry(raw: unknown, cutoff: string): ListEntry {
  const x = raw as Record<string, unknown>;
  if (x && typeof x === "object") {
    if (x.card_v3 && typeof x.topic_id === "string")
      return { topic_id: x.topic_id, card: x.card_v3 as CardInputV3 };
    if (isMaqueta(x))
      return { topic_id: x.signal_id as string, card: fromMaquetaCard(x as never, cutoff) };
    if (typeof x.topic_id === "string" && Array.isArray(x.terms) && Array.isArray(x.headlines))
      return { topic_id: x.topic_id, card: x as unknown as CardInputV3 };
  }
  throw new Error("list entry is neither A's card_v3 nor a maqueta card");
}
