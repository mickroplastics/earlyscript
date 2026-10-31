// @effect-diagnostics globalDate:off - plain async library with UTC timestamps.
// Ported from Earlywindow src/engine/sources/arxiv.ts: export API Atom feed, submittedDate per UTC day.
import type { Item } from "@earlyscript/editorial-contracts/item";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { bodyFields, gatedGet, githubEntities, joinNotes, plainText, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

export const ARXIV_CATEGORIES = ["cs.AI", "cs.CL", "cs.SE", "cs.LG"] as const;
const PAGE_SIZE = 200;
export const ARXIV_DAY_CAP = 1000;
/** The API lists announced submissions only; a Friday afternoon (ET) submission is announced on Monday evening ET. */
export const ARXIV_ANNOUNCEMENT_LAG_MS = 4 * DAY_MS;

const compactDay = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");

/** submittedDate ranges are GMT to the minute and inclusive; items at the next midnight are dropped below. */
export function arxivUrl(day: string, start: number): string {
  const from = dayStart(day);
  const categories = ARXIV_CATEGORIES.map((category) => `cat:${category}`).join(" OR ");
  const params = new URLSearchParams({
    search_query: `(${categories}) AND submittedDate:[${compactDay(from)}0000 TO ${compactDay(from + DAY_MS)}0000]`,
    start: String(start),
    max_results: String(PAGE_SIZE),
    sortBy: "submittedDate",
    sortOrder: "ascending",
  });
  return `https://export.arxiv.org/api/query?${params}`;
}

function element(xml: string, name: string): string | null {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] ?? null;
}

export async function collectArxivDay(
  day: string,
  ungated: GetResponse,
  robots: RobotsGate,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const get = gatedGet(ungated, robots);
  const start = dayStart(day);
  const end = start + DAY_MS;
  const items = new Map<string, Item>();
  const notes: Array<string> = [];
  let failed = false;
  let retrievedAt = now;
  let total: number | null = null;
  let later = 0;
  try {
    for (
      let offset = 0;
      offset < Math.min(total ?? PAGE_SIZE, ARXIV_DAY_CAP);
      offset += PAGE_SIZE
    ) {
      const response = await get(arxivUrl(day, offset));
      retrievedAt = response.observed_at;
      if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
      const feed = typeof response.body === "string" ? response.body : "";
      const reported = element(feed, "opensearch:totalResults")?.trim() ?? "";
      if (!feed.includes("<feed") || !/^\d+$/.test(reported))
        throw new SourceFailure("Invalid arXiv response");
      total = Number(reported);
      const entries = [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1] ?? "");
      if (!entries.length && offset < total) {
        notes.push(`arXiv returned an empty page at start=${offset}`);
        failed = true;
        break;
      }
      for (const entry of entries) {
        const id = /^https?:\/\/arxiv\.org\/abs\/(.+?)(v\d+)?$/.exec(
          element(entry, "id")?.trim() ?? "",
        );
        const published = Date.parse(element(entry, "published") ?? "");
        const title = element(entry, "title");
        const summary = element(entry, "summary");
        if (!id?.[1] || !Number.isFinite(published) || title === null || summary === null) {
          notes.push("Unparsable arXiv entry");
          failed = true;
          continue;
        }
        if (published >= end) {
          later++;
          continue;
        }
        if (published < start) {
          notes.push("arXiv returned an item before its requested day");
          failed = true;
          continue;
        }
        const text = plainText(summary);
        const itemId = `itm_arxiv_${id[1]}`;
        if (!items.has(itemId))
          items.set(itemId, {
            id: itemId,
            source: "arxiv",
            permalink: `https://arxiv.org/abs/${id[1]}${id[2] ?? ""}`,
            external_url: null,
            published_at: new Date(published).toISOString(),
            author: plainText(element(element(entry, "author") ?? "", "name") ?? "") || null,
            title: plainText(title),
            ...bodyFields(text),
            retrieved_at: response.observed_at,
            entities: githubEntities(`${text} ${plainText(element(entry, "arxiv:comment") ?? "")}`),
          });
      }
    }
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error;
    notes.push(error.message);
    failed = true;
  }
  if (total !== null && items.size + later < total) {
    notes.push(
      `arXiv in-day items ${items.size} of totalResults=${total}${total > ARXIV_DAY_CAP ? `; daily cap ${ARXIV_DAY_CAP}` : ""}`,
    );
    failed = true;
  }
  // Rule: a day is complete only once the announcement lag has passed; earlier it stays partial.
  if (Date.parse(retrievedAt) < end + ARXIV_ANNOUNCEMENT_LAG_MS) {
    notes.push(
      "Observed before the 4-day announcement lag elapsed; later announcements may add items",
    );
    failed = true;
  }
  return {
    items: sortItems([...items.values()]),
    coverage: {
      source: "arxiv",
      day,
      status: failed ? (items.size ? "partial" : "unavailable") : "complete",
      items: items.size,
      retrieved_at: retrievedAt,
      note: joinNotes(notes),
    },
  };
}
