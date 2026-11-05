// Topic identity, one rule for v2's emission (run.ts) and eval-editorial: cosine > 0.80 and two
// shared rare top terms or half the smaller's members (cosine alone merged unrelated clusters).
// A term is rare when at most 1 % of the items of the 30 days before the cutoff contain it.
import type { Item } from "@earlyscript/editorial-contracts/item";

import { dot } from "./cluster.ts";
import { DAY_MS, dayStart } from "./days.ts";

export const TOPIC_IDENTITY = {
  rule: "cosine > 0.80 and (at least 2 shared rare top terms or at least half the smaller's members shared)",
  centroid_cosine_above: 0.8,
  rare_terms_min_shared: 2,
  shared_items_min_fraction: 0.5,
  rare_term_max_item_share: 0.01,
  rare_term_window_days: 30,
  terms: "the trend's top terms (dossier top_terms: topTerms over title and cleaned body, 10)",
  text: "item title and body, lower-cased tokens [a-z][a-z0-9]{2,}",
} as const;

export interface TopicMember {
  readonly key: string;
  readonly trendId: string;
  readonly centroid: Float32Array;
  readonly itemIds: ReadonlySet<string>;
  readonly terms: ReadonlyArray<string>;
}

/** TOPIC_IDENTITY for two trends, given which terms are rare at the (later) cutoff. */
export function sameTopic(
  a: TopicMember,
  b: TopicMember,
  rare: (term: string) => boolean,
): boolean {
  if (dot(a.centroid, b.centroid) <= TOPIC_IDENTITY.centroid_cosine_above) return false;
  const bTerms = new Set(b.terms);
  const sharedRare = new Set(a.terms.filter((t) => bTerms.has(t) && rare(t)));
  if (sharedRare.size >= TOPIC_IDENTITY.rare_terms_min_shared) return true;
  const [small, large] = a.itemIds.size <= b.itemIds.size ? [a, b] : [b, a];
  if (small.itemIds.size === 0) return false;
  let shared = 0;
  for (const id of small.itemIds) if (large.itemIds.has(id)) shared++;
  return shared >= TOPIC_IDENTITY.shared_items_min_fraction * small.itemIds.size;
}

const termTokens = (text: string): Array<string> =>
  text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [];

/**
 * Item document frequency of the candidate terms in the window before each cutoff; a term is
 * rare at a cutoff when its share is at most TOPIC_IDENTITY.rare_term_max_item_share.
 */
export function rareTermsByCutoff(
  items: ReadonlyArray<Pick<Item, "published_at" | "title" | "body">>,
  terms: ReadonlySet<string>,
  cutoffDays: ReadonlyArray<string>,
): Map<string, Set<string>> {
  const tokens = items.map((item) => ({
    ms: Date.parse(item.published_at),
    terms: new Set(termTokens(`${item.title} ${item.body}`).filter((t) => terms.has(t))),
  }));
  return new Map(
    cutoffDays.map((day) => {
      const end = dayStart(day);
      const start = end - TOPIC_IDENTITY.rare_term_window_days * DAY_MS;
      const df = new Map<string, number>();
      let n = 0;
      for (const t of tokens) {
        if (t.ms < start || t.ms >= end) continue;
        n++;
        for (const term of t.terms) df.set(term, (df.get(term) ?? 0) + 1);
      }
      const rare = new Set(
        [...terms].filter(
          (term) => (df.get(term) ?? 0) <= TOPIC_IDENTITY.rare_term_max_item_share * n,
        ),
      );
      return [day, rare] as const;
    }),
  );
}
