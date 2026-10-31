// @effect-diagnostics globalDate:off - plain async library with native fetch and UTC timestamps.
// Lobste.rs public JSON: /newest/page/N.json lists every story newest first, 25 per page.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { LobstersPage } from "@earlyscript/editorial-contracts/source";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import type { RobotsGate } from "./robots.ts";
import { githubEntity, plainText, sortItems } from "./shared.ts";
import type { DayResult } from "./adapter.ts";
const isPage = Schema.is(LobstersPage);

/** About a month of stories at ~35 a day; a day further back stays `partial`. */
export const LOBSTERS_MAX_PAGES = 40;

export const lobstersPageUrl = (page: number) => `https://lobste.rs/newest/page/${page}.json`;

export async function collectLobstersDay(
  day: string,
  get: GetResponse,
  robots: RobotsGate,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const start = dayStart(day);
  const end = start + DAY_MS;
  const items = new Map<string, Item>();
  const notes: Array<string> = [];
  let retrievedAt = now;
  let reached = false;
  let failed = false;
  try {
    for (let page = 1; page <= LOBSTERS_MAX_PAGES && !reached; page++) {
      const url = lobstersPageUrl(page);
      const refusal = await robots(url);
      if (refusal) throw new SourceFailure(refusal);
      const response = await get(url);
      retrievedAt = response.observed_at;
      if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
      if (!isPage(response.body)) throw new SourceFailure("Invalid Lobsters response");
      // An empty page is the end of the site's history.
      if (response.body.length === 0) reached = true;
      for (const story of response.body) {
        const created = Date.parse(story.created_at);
        if (!Number.isFinite(created)) {
          failed = true;
          notes.push("Lobsters story with an invalid created_at");
          continue;
        }
        if (created < start) reached = true;
        if (created < start || created >= end) continue;
        const description = plainText(story.description_plain ?? "");
        const text = [description, story.tags.length ? `Tags: ${story.tags.join(", ")}` : ""]
          .filter(Boolean)
          .join("\n\n");
        const external = story.url || null;
        const id = `itm_lob_${story.short_id}`;
        // Pages shift while paginating; a story seen twice keeps its first capture.
        if (!items.has(id))
          items.set(id, {
            id,
            source: "lobsters",
            permalink: story.comments_url,
            external_url: external,
            published_at: new Date(created).toISOString(),
            author: story.submitter_user,
            title: plainText(story.title),
            body: text.slice(0, 4000),
            body_length: text.length,
            truncated: text.length > 4000,
            retrieved_at: response.observed_at,
            entities: githubEntity(external),
          });
      }
    }
    if (!reached) {
      failed = true;
      notes.push(`Pagination stopped after ${LOBSTERS_MAX_PAGES} pages before the day start`);
    }
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error;
    failed = true;
    notes.push(error.message);
  }
  const unfinished = end > Date.parse(retrievedAt);
  if (unfinished) notes.push("Day not finished at retrieval");
  const status = failed
    ? items.size
      ? "partial"
      : "unavailable"
    : unfinished
      ? "partial"
      : "complete";
  return {
    items: sortItems([...items.values()]),
    coverage: {
      source: "lobsters",
      day,
      status,
      items: items.size,
      retrieved_at: retrievedAt,
      note: notes.length ? [...new Set(notes)].join("; ") : null,
    },
  };
}
