// @effect-diagnostics globalDate:off - plain async library with UTC timestamps.
// Ported from Earlywindow src/engine/sources/wikipedia.ts: the Wikimedia pageviews top list.
// No article text: en.wikipedia.org/robots.txt disallows /api/ (REST summaries) and /w/
// (api.php) for every agent except action=mobileview, which this adapter does not use.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { gatedGet, itemBody, joinNotes, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

const isTop = Schema.is(
  Schema.Struct({
    items: Schema.Tuple([
      Schema.Struct({
        articles: Schema.Array(
          Schema.Struct({
            article: Schema.NonEmptyString,
            views: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
            rank: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
          }),
        ),
      }),
    ]),
  }),
);

/** Rows of a whole top list; a shorter list is a partial day. */
export const WIKIPEDIA_TOP_ROWS = 1000;

/** Main_Page and pages outside the article namespace, as they appear in the top list. */
const NON_ARTICLE =
  /^(Main_Page|-|Undefined)$|^(Special|Wikipedia|Portal|File|Help|User|Category|Template|Draft|MediaWiki|Module|Talk|[A-Za-z]+_talk):/;

export function wikipediaTopUrl(day: string): string {
  dayStart(day);
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${day.replaceAll("-", "/")}`;
}

export async function collectWikipediaDay(
  day: string,
  ungated: GetResponse,
  robots: RobotsGate,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const get = gatedGet(ungated, robots);
  // Page views have no instant within the day: every item is filed at the day's first millisecond.
  const published = new Date(dayStart(day)).toISOString();
  const items: Array<Item> = [];
  const failures: Array<string> = [];
  let retrievedAt = now;
  let note: string | null = null;
  try {
    const response = await get(wikipediaTopUrl(day));
    retrievedAt = response.observed_at;
    // Wikimedia publishes a day's top list some hours after it ends; before that it answers 404.
    if (response.status === 404) throw new SourceFailure("Top list not published yet (HTTP 404)");
    if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
    if (!isTop(response.body)) throw new SourceFailure("Invalid Wikipedia top response");
    const ranked = response.body.items[0].articles;
    // The list is checked whole before non-article pages leave it.
    if (ranked.length !== WIKIPEDIA_TOP_ROWS)
      failures.push(`Top list has ${ranked.length} of ${WIKIPEDIA_TOP_ROWS} rows`);
    // Ranks tie, so the position in the API list is what makes the item id unique.
    const articles = ranked
      .map((article, index) => ({ ...article, position: index + 1 }))
      .filter((article) => !NON_ARTICLE.test(article.article));
    for (const { article, views, rank, position } of articles) {
      const text = `English Wikipedia page views on ${day}: ${views}. Rank ${rank} of the ${ranked.length} most viewed pages.`;
      items.push({
        id: `itm_wikipedia_${day}_p${String(position).padStart(4, "0")}`,
        source: "wikipedia",
        permalink: `https://en.wikipedia.org/wiki/${encodeURIComponent(article)}`,
        external_url: null,
        published_at: published,
        author: null,
        title: article.replaceAll("_", " "),
        ...itemBody(text),
        retrieved_at: response.observed_at,
        entities: [`wikipedia:${article}`],
      });
    }
    note = `${ranked.length} ranked, ${ranked.length - articles.length} non-article pages excluded; title, URL, views and rank only (no summaries: robots.txt)`;
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error;
    failures.push(error.message);
  }
  return {
    items: sortItems(items),
    coverage: {
      source: "wikipedia",
      day,
      status: failures.length ? (items.length ? "partial" : "unavailable") : "complete",
      items: items.length,
      retrieved_at: retrievedAt,
      note: joinNotes([note, ...failures]),
    },
  };
}
