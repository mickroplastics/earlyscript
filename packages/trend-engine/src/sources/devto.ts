// @effect-diagnostics globalDate:off - plain async library with native fetch and UTC timestamps.
// dev.to (Forem API v1): articles of the day with one of the tags below and some reader response.
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
/** Articles kept per day, by present-day reactions. */
export const DEVTO_PER_DAY = 500;
/** Bridge pages use another page size, so another CDN cache key, across a suspected gap. */
const BRIDGE_PAGE = 200;
const MAX_BRIDGE_PAGES = 3;

export const DEVTO_SELECTION =
  `articles/latest walked past the day start; articles of the UTC day with at least one ` +
  `reaction or comment and any tag of ${DEVTO_TAGS.join(",")}; up to ${DEVTO_PER_DAY} by ` +
  `present-day positive reactions, then comments; body = listing description`;

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
    positive_reactions_count: Schema.optionalKey(Schema.Number),
    comments_count: Schema.optionalKey(Schema.Number),
    user: Schema.Struct({ username: Schema.String }),
  }),
);
const isArticles = Schema.is(DevtoArticles);
type Article = (typeof DevtoArticles.Type)[number];

export function devtoLatestUrl(page: number, perPage = PAGE): string {
  const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  return `https://dev.to/api/articles/latest?${params}`;
}

interface Tagged {
  readonly item: Item;
  readonly tags: ReadonlyArray<string>;
  readonly reactions: number;
  readonly comments: number;
}

/** Instant the page content was produced: observation minus the time it sat in a CDN. */
const snapshotOf = (observedAt: string, age = 0) => Date.parse(observedAt) - age * 1000;
const publishedOf = (article: Article) => Date.parse(article.published_at);

/**
 * One walk of the listing serves a range of days; only tagged articles stay in memory. A CDN
 * page older than the previous one (`Age`) can hide the articles between them: bridge pages of
 * another size are asked across that range, and a range they do not cover stays in the note.
 */
/** A failed bridge leaves its gap open; it does not fail the walk. */
const passFailure = (error: unknown) => {
  if (error instanceof SourceFailure) return false;
  throw error;
};

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
  let previousSnapshot = -Infinity;
  let bridgePages = 0;
  /** Published-time ranges that may have fallen between a page and an older cached next page. */
  const gaps: Array<{ from: number; to: number }> = [];
  function remember(article: Article, observedAt: string) {
    const published = publishedOf(article);
    const tags = article.tag_list.filter((tag) => wanted.has(tag));
    if (!Number.isFinite(published) || !tags.length) return;
    const text = plainText(article.description ?? "");
    const canonical = article.canonical_url ?? null;
    const external = canonical && !canonical.startsWith("https://dev.to/") ? canonical : null;
    // A later sighting carries newer reaction counts; the item keeps its first retrieval.
    const item = tagged.get(article.id)?.item ?? {
      id: `itm_devto_${article.id}`,
      source: "devto" as const,
      permalink: article.url,
      external_url: external,
      published_at: new Date(published).toISOString(),
      author: article.user.username,
      title: plainText(article.title),
      ...itemBody(text),
      retrieved_at: observedAt,
      entities: githubEntity(external),
    };
    tagged.set(article.id, {
      item,
      tags,
      reactions: article.positive_reactions_count ?? 0,
      comments: article.comments_count ?? 0,
    });
  }
  /**
   * Pages of BRIDGE_PAGE from the one holding the last position of page `before`. The range
   * (`to` newest, `from` oldest) is covered when a bridge starts at or above `to`, reaches
   * `from`, and no bridge page is older than the one before it without sharing an article.
   */
  async function bridge(before: number, gap: { from: number; to: number }, get: GetResponse) {
    let first = Math.floor((before * PAGE - 1) / BRIDGE_PAGE) + 1;
    let startsAbove = false;
    let seen = new Set<number>();
    let snapshot = -Infinity;
    for (let n = 0; n < MAX_BRIDGE_PAGES; n++, first++) {
      bridgePages++;
      const response = await get(devtoLatestUrl(first, BRIDGE_PAGE));
      if (response.status !== 200 || !isArticles(response.body) || !response.body.length)
        return false;
      const current = snapshotOf(response.observed_at, response.age);
      const ids = new Set(response.body.map((article) => article.id));
      if (n === 0) startsAbove = publishedOf(response.body[0]!) >= gap.to;
      else if (current < snapshot && !response.body.some((article) => seen.has(article.id)))
        return false;
      seen = ids;
      snapshot = current;
      for (const article of response.body) remember(article, response.observed_at);
      if (response.body.some((article) => publishedOf(article) <= gap.from)) return startsAbove;
    }
    return false;
  }
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
      const snapshot = snapshotOf(response.observed_at, response.age);
      const first = Date.parse(response.body[0]?.published_at ?? "");
      // Only an older next page without a repeat of this one can hide articles between them.
      const overlaps = response.body.some((article) => seen.has(article.id));
      if (snapshot < previousSnapshot && !overlaps && Number.isFinite(first) && oldest !== Infinity) {
        const gap = { from: Math.min(first, oldest), to: Math.max(first, oldest) };
        if (!(await bridge(page - 1, gap, get).catch(passFailure))) gaps.push(gap);
      }
      previousSnapshot = snapshot;
      for (const article of response.body) {
        const published = publishedOf(article);
        if (!Number.isFinite(published)) continue;
        // Repeats from the previous page are the only articles allowed to be newer.
        if (published > oldest && !seen.has(article.id))
          throw new SourceFailure("dev.to listing is not newest first");
        oldest = Math.min(oldest, published);
        newestSeen ??= article.published_at;
        remember(article, response.observed_at);
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
    const eligible = [...tagged.values()].filter(({ item, reactions, comments }) => {
      const published = Date.parse(item.published_at);
      return published >= start && published < start + DAY_MS && (reactions >= 1 || comments >= 1);
    });
    const inDay = eligible
      .toSorted(
        (a, b) =>
          b.reactions - a.reactions || b.comments - a.comments || a.item.id.localeCompare(b.item.id),
      )
      .slice(0, DEVTO_PER_DAY);
    const perTag = DEVTO_TAGS.map(
      (tag) => `${tag}=${inDay.filter(({ tags }) => tags.includes(tag)).length}`,
    ).join(",");
    // Complete only when the walk passed the day start and the day had ended before it began.
    const notes: Array<string> = [];
    if (failure) notes.push(failure);
    for (const gap of gaps)
      if (gap.from < start + DAY_MS && gap.to >= start)
        notes.push(
          `possible gap ${new Date(gap.from).toISOString()}..${new Date(gap.to).toISOString()}: cached page older than the previous one`,
        );
    if (ended && oldest >= start) notes.push("listing ended before the day start");
    if (firstObserved !== null && firstObserved < start + DAY_MS) notes.push("day not over");
    if (newestSeen === null && !failure) notes.push("empty listing");
    const items = sortItems(inDay.map(({ item }) => item));
    // A sample by design; `complete` only when every eligible article of a whole walk fits.
    const capped = eligible.length > DEVTO_PER_DAY;
    return {
      items,
      coverage: {
        source: "devto",
        day,
        status: notes.length
          ? items.length
            ? "partial"
            : "unavailable"
          : capped
            ? "partial"
            : "complete",
        items: items.length,
        retrieved_at:
          items
            .map((item) => item.retrieved_at)
            .toSorted()
            .at(-1) ?? new Date(firstObserved ?? Date.now()).toISOString(),
        note: [
          ...notes,
          `eligible=${eligible.length}, kept=${items.length}; tags ${perTag}; pages walked=${page}` +
            (bridgePages ? `, bridge pages=${bridgePages}` : ""),
        ].join("; "),
      },
    };
  };
}
