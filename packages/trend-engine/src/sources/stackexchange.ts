// @effect-diagnostics globalDate:off - plain async library with UTC timestamps.
// Ported from Earlywindow src/engine/sources/stackexchange.ts: questions per creation day, by votes.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type DeclaredThrottle, type GetResponse } from "./http.ts";
import { bodyFields, gatedGet, joinNotes, plainText, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

export const STACKEXCHANGE_SITES = ["stackoverflow", "ai"] as const;
type Site = (typeof STACKEXCHANGE_SITES)[number];
/** 3 pages of 100: at most 300 questions per site and UTC day, highest score first. */
const MAX_PAGES = 3;

const isPage = Schema.is(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        question_id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
        creation_date: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        title: Schema.String,
        link: Schema.String,
        tags: Schema.Array(Schema.String),
        body: Schema.optionalKey(Schema.String),
        owner: Schema.optionalKey(
          Schema.Struct({ display_name: Schema.optionalKey(Schema.String) }),
        ),
      }),
    ),
    has_more: Schema.Boolean,
  }),
);

/** Stack Exchange throttles in the body: `backoff` seconds, a daily `quota_remaining` and error 502 `throttle_violation`. */
export function stackExchangeThrottle(body: unknown): DeclaredThrottle {
  const se: {
    backoff?: unknown;
    quota_remaining?: unknown;
    error_name?: unknown;
    error_message?: unknown;
  } = typeof body === "object" && body !== null ? body : {};
  const available =
    typeof se.error_message === "string" ? /available in (\d+) seconds/.exec(se.error_message) : null;
  return {
    blockMs: Math.max(
      0,
      typeof se.backoff === "number" ? se.backoff * 1000 + 500 : 0,
      se.quota_remaining === 0 ? DAY_MS : 0,
      available ? Number(available[1]) * 1000 + 1500 : 0,
    ),
    limited: se.error_name === "throttle_violation",
  };
}

export function stackExchangeUrl(site: Site, from: number, until: number, page: number): string {
  // todate is inclusive; items outside [from, until) are rejected below either way.
  const params = new URLSearchParams({
    fromdate: String(from / 1000),
    todate: String(until / 1000 - 1),
    order: "desc",
    sort: "votes",
    site,
    filter: "withbody",
    pagesize: "100",
    page: String(page),
  });
  return `https://api.stackexchange.com/2.3/questions?${params}`;
}

export async function collectStackExchangeDay(
  day: string,
  ungated: GetResponse,
  robots: RobotsGate,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const get = gatedGet(ungated, robots);
  const start = dayStart(day);
  const end = start + DAY_MS;
  const items = new Map<string, Item>();
  const failures: Array<string> = [];
  const capped: Array<string> = [];
  const counts: Array<string> = [];
  let retrievedAt = now;
  for (const site of STACKEXCHANGE_SITES) {
    let received = 0;
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await get(stackExchangeUrl(site, start, end, page));
        retrievedAt = response.observed_at;
        if (response.status !== 200) throw new SourceFailure(`${site}: HTTP ${response.status}`);
        if (!isPage(response.body))
          throw new SourceFailure(`${site}: invalid Stack Exchange response`);
        for (const question of response.body.items) {
          const published = question.creation_date * 1000;
          if (published < start || published >= end) {
            failures.push(`${site} returned a question outside its requested day`);
            continue;
          }
          const id = `itm_se_${site}_${question.question_id}`;
          if (items.has(id)) continue;
          received++;
          const tags = question.tags.length ? `Tags: ${question.tags.join(", ")}. ` : "";
          const name = question.owner?.display_name;
          items.set(id, {
            id,
            source: "stackexchange",
            permalink: question.link,
            external_url: null,
            published_at: new Date(published).toISOString(),
            author: name ? plainText(name) : null,
            title: plainText(question.title),
            ...bodyFields(tags + plainText(question.body ?? "")),
            retrieved_at: response.observed_at,
            entities: [],
          });
        }
        if (!response.body.has_more) break;
        if (page === MAX_PAGES) capped.push(`${site} capped at ${MAX_PAGES * 100} questions by score`);
      }
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      failures.push(error.message);
    }
    counts.push(`${site}=${received}`);
  }
  return {
    items: sortItems([...items.values()]),
    coverage: {
      source: "stackexchange",
      day,
      // The 300-question cap is part of the declared sample; a failed request is not.
      status: failures.length
        ? items.size
          ? "partial"
          : "unavailable"
        : capped.length
          ? "partial"
          : "complete",
      items: items.size,
      retrieved_at: retrievedAt,
      note: joinNotes([`questions ${counts.join(", ")}`, ...capped, ...failures]),
    },
  };
}
