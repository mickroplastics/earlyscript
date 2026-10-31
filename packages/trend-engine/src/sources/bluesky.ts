// @effect-diagnostics globalDate:off - plain async library with UTC timestamps.
// Ported from Earlywindow src/engine/sources/bluesky.ts: anonymous searchPosts over fixed terms.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { bodyFields, gatedGet, githubEntity, joinNotes, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

/**
 * searchPosts requires a query, so a fixed developer-term list stands in for a daily census.
 * `ai` is left out (Earlywindow M29): it alone doubled the volume with posts off the niche.
 */
export const BLUESKY_TERMS = [
  "llm",
  "agent",
  "open source",
  "github",
  "developer",
  "python",
  "typescript",
  "rust",
] as const;
/** Anonymous requests with a cursor get HTTP 403, so each window returns one page and busy windows are split. */
export const BLUESKY_PAGE = 100;
/** 8 terms x 20 requests at one per second fit the five-minute day budget of the HTTP client. */
export const BLUESKY_MAX_REQUESTS_PER_TERM = 20;
const TARGET_HITS = 80;
const SELECTION_NOTE = `Keyword search, lang=en, sort=latest, terms=${BLUESKY_TERMS.join("|")}; one page of ${BLUESKY_PAGE} per time window, at most ${BLUESKY_MAX_REQUESTS_PER_TERM} requests per term; not a census of the day`;

const AT_URI = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9._:~-]+)$/;
const ExternalUri = Schema.optionalKey(Schema.Struct({ uri: Schema.String }));
const External = Schema.Struct({ external: ExternalUri });
const isSearch = Schema.is(
  Schema.Struct({
    posts: Schema.Array(
      Schema.Struct({
        uri: Schema.String.check(Schema.isPattern(AT_URI)),
        indexedAt: Schema.String,
        author: Schema.Struct({ did: Schema.String, handle: Schema.String }),
        record: Schema.Struct({
          text: Schema.String,
          createdAt: Schema.String,
          facets: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                features: Schema.Array(Schema.Struct({ uri: Schema.optionalKey(Schema.String) })),
              }),
            ),
          ),
          embed: Schema.optionalKey(
            Schema.Struct({
              external: ExternalUri,
              media: Schema.optionalKey(External),
            }),
          ),
        }),
      }),
    ),
    cursor: Schema.optionalKey(Schema.String),
    hitsTotal: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
);

/** The item permalink of a post's at:// URI; null for anything that is not a post URI. */
export function blueskyPermalink(atUri: string): string | null {
  const [, did, rkey] = AT_URI.exec(atUri) ?? [];
  return did && rkey ? `https://bsky.app/profile/${did}/post/${rkey}` : null;
}

export function blueskySearchUrl(term: string, from: number, until: number): string {
  const params = new URLSearchParams({
    q: term.includes(" ") ? `"${term}"` : term,
    lang: "en",
    sort: "latest",
    since: new Date(from).toISOString(),
    until: new Date(until).toISOString(),
    limit: String(BLUESKY_PAGE),
  });
  return `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?${params}`;
}

/** The provider also matches alt text and link cards; keep only posts whose own text names a term. */
const MENTIONS = new RegExp(
  `\\b(${BLUESKY_TERMS.map((term) => term.replace(" ", "\\s+")).join("|")})\\b`,
  "i",
);

export async function collectBlueskyDay(
  day: string,
  ungated: GetResponse,
  robots: RobotsGate,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const get = gatedGet(ungated, robots);
  const start = dayStart(day);
  const items = new Map<string, Item>();
  const offText = new Set<string>();
  const failures: Array<string> = [];
  const sampled: Array<string> = [];
  let retrievedAt = now;
  let requests = 0;
  let received = 0;
  let boundary = 0;
  for (const term of BLUESKY_TERMS) {
    // Breadth-first: the first split spends the term's remaining budget evenly across the day.
    const queue: Array<[number, number]> = [[start, start + DAY_MS]];
    let termRequests = 0;
    let crowdedSeconds = 0;
    while (queue.length && termRequests < BLUESKY_MAX_REQUESTS_PER_TERM) {
      const [from, until] = queue.shift()!;
      termRequests++;
      try {
        const response = await get(blueskySearchUrl(term, from, until));
        retrievedAt = response.observed_at;
        if (response.status !== 200)
          throw new SourceFailure(`HTTP ${response.status} for term "${term}"`);
        if (!isSearch(response.body))
          throw new SourceFailure(`Invalid Bluesky response for term "${term}"`);
        const body = response.body;
        received += body.posts.length;
        for (const post of body.posts) {
          // AppView filters since/until on sortAt, the earlier of createdAt and indexedAt.
          const published = Math.min(
            ...[post.record.createdAt, post.indexedAt].map(Date.parse).filter(Number.isFinite),
          );
          if (!(published >= from && published < until)) {
            // AppView compares until at one-second precision; the next window owns that second.
            if (published >= until && published < until + 1000) boundary++;
            else failures.push("Bluesky returned a post outside its requested window");
            continue;
          }
          const [, did = "", rkey = ""] = AT_URI.exec(post.uri) ?? [];
          const id = `itm_bsky_${did.replace(/^did:/, "").replace(/[^A-Za-z0-9]/g, "_")}_${rkey}`;
          if (items.has(id)) continue;
          if (!MENTIONS.test(post.record.text)) {
            offText.add(id);
            continue;
          }
          const embed = post.record.embed;
          const embedded = embed?.external?.uri ?? embed?.media?.external?.uri;
          const links = [
            ...(embedded ? [embedded] : []),
            ...(post.record.facets ?? []).flatMap((facet) =>
              facet.features.flatMap((feature) => (feature.uri ? [feature.uri] : [])),
            ),
          ];
          items.set(id, {
            id,
            source: "bluesky",
            // The permalink keeps the DID, so a purge by DID still finds posts after a handle change.
            permalink: blueskyPermalink(post.uri)!,
            external_url: links[0] ?? null,
            published_at: new Date(published).toISOString(),
            author: post.author.handle,
            title: "",
            ...bodyFields(post.record.text.replace(/\s+/g, " ").trim()),
            retrieved_at: response.observed_at,
            entities: [...new Set(links.flatMap(githubEntity))].toSorted(),
          });
        }
        const hits = body.hitsTotal ?? Number.POSITIVE_INFINITY;
        if (body.cursor === undefined || hits <= BLUESKY_PAGE) continue;
        if (until - from <= 1000) {
          crowdedSeconds++;
          continue;
        }
        const budget = BLUESKY_MAX_REQUESTS_PER_TERM - termRequests - queue.length;
        const pieces = Math.min(Math.ceil(hits / TARGET_HITS), Math.ceil((until - from) / 1000), budget);
        if (pieces < 2) {
          sampled.push(`term "${term}": a window kept only its latest ${BLUESKY_PAGE} posts`);
          continue;
        }
        for (let i = 0; i < pieces; i++)
          queue.push([
            from + Math.floor(((until - from) * i) / pieces),
            from + Math.floor(((until - from) * (i + 1)) / pieces),
          ]);
      } catch (error) {
        if (!(error instanceof SourceFailure)) throw error;
        failures.push(error.message);
      }
    }
    requests += termRequests;
    if (queue.length)
      failures.push(`term "${term}": request budget reached with ${queue.length} windows unfetched`);
    if (crowdedSeconds)
      sampled.push(`term "${term}": ${crowdedSeconds} one-second windows exceeded one page`);
  }
  return {
    items: sortItems([...items.values()]),
    coverage: {
      source: "bluesky",
      day,
      status: failures.length
        ? items.size
          ? "partial"
          : "unavailable"
        : sampled.length
          ? "partial"
          : "complete",
      items: items.size,
      retrieved_at: retrievedAt,
      note: joinNotes([
        SELECTION_NOTE,
        `requests=${requests}, received=${received}, dropped_without_term_in_text=${offText.size}, boundary_duplicates=${boundary}`,
        ...sampled,
        ...failures,
      ]),
    },
  };
}
