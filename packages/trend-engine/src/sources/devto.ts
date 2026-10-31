// @effect-diagnostics globalDate:off - plain async library with native fetch and UTC timestamps.
// dev.to (Forem API v1): every article published on the day that carries one of the tags below.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { githubEntity, itemBody, plainText, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

/** Tags close to the channel profile; an article enters when it carries at least one. */
export const DEVTO_TAGS = [
  "ai",
  "llm",
  "agents",
  "machinelearning",
  "programming",
  "devtools",
  "opensource",
  "python",
  "typescript",
  "rust",
] as const;
const PAGE = 1000;
/** About 5000 articles are published per day, so this bounds one run to roughly two months back. */
const MAX_PAGES = 300;

export const DEVTO_SELECTION =
  `articles/latest (newest first) walked past the day start; articles published in the UTC day ` +
  `with any tag of ${DEVTO_TAGS.join(",")}; body = listing description`;

// `/articles?tag=` is ordered by popularity, not by date, so it cannot tell when a day is
// exhausted; `/articles/latest` is strictly newest first and the tag filter runs here.
const DevtoArticles = Schema.Array(
  Schema.Struct({
    id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    title: Schema.String,
    description: Schema.optionalKey(Schema.NullOr(Schema.String)),
    url: Schema.String,
    canonical_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
    published_at: Schema.String,
    tag_list: Schema.Array(Schema.String),
    user: Schema.Struct({ username: Schema.String }),
  }),
);
const isArticles = Schema.is(DevtoArticles);

export function devtoLatestUrl(page: number): string {
  const params = new URLSearchParams({ per_page: String(PAGE), page: String(page) });
  return `https://dev.to/api/articles/latest?${params}`;
}

interface Tagged {
  readonly item: Item;
  readonly tags: ReadonlyArray<string>;
}

/**
 * The listing is walked once for a range of days and kept between days; only tagged articles
 * stay in memory. Page numbers shift while new articles arrive: repeats are merged by id, and
 * an article deleted during the walk can push one unseen article back a page.
 */
export function devtoCollector(): (
  day: string,
  get: GetResponse,
  robots: RobotsGate,
) => Promise<DayResult> {
  const tagged = new Map<number, Tagged>();
  const wanted = new Set<string>(DEVTO_TAGS);
  let page = 0;
  let oldest = Infinity;
  let newestSeen: string | null = null;
  let ended = false;
  let firstObserved: number | null = null;
  let previousPage = new Set<number>();
  async function reachBefore(start: number, get: GetResponse) {
    while (oldest >= start && !ended) {
      if (page >= MAX_PAGES) throw new SourceFailure("Listing page limit reached before the day");
      const response = await get(devtoLatestUrl(page + 1));
      if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
      if (!isArticles(response.body)) throw new SourceFailure("Invalid dev.to listing");
      page++;
      firstObserved ??= Date.parse(response.observed_at);
      if (!response.body.length) ended = true;
      const seen = previousPage;
      previousPage = new Set(response.body.map((article) => article.id));
      for (const article of response.body) {
        const published = Date.parse(article.published_at);
        if (!Number.isFinite(published)) continue;
        // Repeats from the previous page are the only articles allowed to be newer.
        if (published > oldest && !seen.has(article.id))
          throw new SourceFailure("dev.to listing is not newest first");
        oldest = Math.min(oldest, published);
        newestSeen ??= article.published_at;
        const tags = article.tag_list.filter((tag) => wanted.has(tag));
        if (!tags.length || tagged.has(article.id)) continue;
        const text = plainText(article.description ?? "");
        const canonical = article.canonical_url ?? null;
        const external = canonical && !canonical.startsWith("https://dev.to/") ? canonical : null;
        tagged.set(article.id, {
          tags,
          item: {
            id: `itm_devto_${article.id}`,
            source: "devto",
            permalink: article.url,
            external_url: external,
            published_at: new Date(published).toISOString(),
            author: article.user.username,
            title: plainText(article.title),
            ...itemBody(text),
            retrieved_at: response.observed_at,
            entities: githubEntity(external),
          },
        });
      }
    }
  }
  return async (day, get, robots) => {
    const start = dayStart(day);
    // Every request of the walk is on this path: one robots.txt check before the day's first.
    const refusal = await robots(devtoLatestUrl(1));
    if (refusal)
      return {
        items: [],
        coverage: {
          source: "devto",
          day,
          status: "unavailable",
          items: 0,
          retrieved_at: new Date().toISOString(),
          note: refusal,
        },
      };
    let failure: string | null = null;
    try {
      await reachBefore(start, get);
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      failure = error.message;
    }
    const inDay = [...tagged.values()].filter(({ item }) => {
      const published = Date.parse(item.published_at);
      return published >= start && published < start + DAY_MS;
    });
    const perTag = DEVTO_TAGS.map(
      (tag) => `${tag}=${inDay.filter(({ tags }) => tags.includes(tag)).length}`,
    ).join(",");
    // Complete only when the walk passed the day start and the day had ended before it began.
    const notes: Array<string> = [];
    if (failure) notes.push(failure);
    if (ended && oldest >= start) notes.push("listing ended before the day start");
    if (firstObserved !== null && firstObserved < start + DAY_MS) notes.push("day not over");
    if (newestSeen === null && !failure) notes.push("empty listing");
    const items = sortItems(inDay.map(({ item }) => item));
    return {
      items,
      coverage: {
        source: "devto",
        day,
        status: notes.length ? (items.length ? "partial" : "unavailable") : "complete",
        items: items.length,
        retrieved_at:
          items
            .map((item) => item.retrieved_at)
            .toSorted()
            .at(-1) ?? new Date(firstObserved ?? Date.now()).toISOString(),
        note: [...notes, `tags ${perTag}; pages walked=${page}`].join("; "),
      },
    };
  };
}
