// @effect-diagnostics globalDate:off - plain async library with UTC timestamps.
// Ported from Earlywindow src/engine/sources/wikipedia.ts: Wikimedia pageviews top list plus page summaries.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { bodyFields, gatedGet, joinNotes, plainText, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

/** Summaries cost one request per article, so only the most viewed articles of each day get one, and only where robots.txt allows. */
export const SUMMARY_LIMIT = 50;

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
const isSummary = Schema.is(
  Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    extract: Schema.optionalKey(Schema.String),
  }),
);

/** Main_Page and pages outside the article namespace, as they appear in the top list. */
const NON_ARTICLE =
  /^(Main_Page|-|Undefined)$|^(Special|Wikipedia|Portal|File|Help|User|Category|Template|Draft|MediaWiki|Module|Talk|[A-Za-z]+_talk):/;

export function wikipediaTopUrl(day: string): string {
  dayStart(day);
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${day.replaceAll("-", "/")}`;
}
export function wikipediaSummaryUrl(article: string): string {
  return `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(article)}`;
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
    // Ranks tie, so the position in the API list is what makes the item id unique.
    const articles = ranked
      .map((article, index) => ({ ...article, position: index + 1 }))
      .filter((article) => !NON_ARTICLE.test(article.article));
    let summarized = 0;
    let missing = 0;
    // Summaries live on en.wikipedia.org, whose robots.txt disallows /api/ for every agent
    // (31 October 2026): a refusal skips them and leaves the top list whole.
    const refusal = articles[0] ? await robots(wikipediaSummaryUrl(articles[0].article)) : null;
    for (const [index, { article, views, rank, position }] of articles.entries()) {
      let text = `English Wikipedia page views on ${day}: ${views}. Rank ${rank} of the ${ranked.length} most viewed pages.`;
      let itemRetrievedAt = response.observed_at;
      if (index < SUMMARY_LIMIT && !refusal && !failures.length) {
        try {
          const summary = await get(wikipediaSummaryUrl(article));
          if (summary.status === 404) missing++;
          else if (summary.status !== 200 || !isSummary(summary.body))
            throw new SourceFailure(`Invalid summary for ${article}: HTTP ${summary.status}`);
          else {
            summarized++;
            itemRetrievedAt = summary.observed_at;
            const parts = [summary.body.description, summary.body.extract].filter(Boolean);
            text += ` ${parts.map((part) => plainText(part ?? "")).join(". ")}`;
          }
        } catch (error) {
          if (!(error instanceof SourceFailure)) throw error;
          failures.push(error.message);
        }
      }
      items.push({
        id: `itm_wikipedia_${day}_p${String(position).padStart(4, "0")}`,
        source: "wikipedia",
        permalink: `https://en.wikipedia.org/wiki/${encodeURIComponent(article)}`,
        external_url: null,
        published_at: published,
        author: null,
        title: article.replaceAll("_", " "),
        ...bodyFields(text),
        retrieved_at: itemRetrievedAt,
        entities: [`wikipedia:${article}`],
      });
    }
    note = `${ranked.length} ranked, ${ranked.length - articles.length} non-article pages excluded, ${refusal ? `summaries skipped: ${refusal}` : `summaries ${summarized}/${Math.min(SUMMARY_LIMIT, articles.length)}, ${missing} not found`}`;
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error;
    failures.push(error.message);
  }
  return {
    items: sortItems(items),
    coverage: {
      source: "wikipedia",
      day,
      // A failed summary leaves the ranked list whole; only the text of later items is shorter.
      status: failures.length ? (items.length ? "partial" : "unavailable") : "complete",
      items: items.length,
      retrieved_at: retrievedAt,
      note: joinNotes([note, ...failures]),
    },
  };
}
