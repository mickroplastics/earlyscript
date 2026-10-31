// @effect-diagnostics globalDate:off - plain async library with native fetch and UTC timestamps.
// Curated RSS 2.0 and Atom feeds (rss-feeds.ts). A feed only lists its latest entries, so a
// day counts as covered by a feed when the feed reaches back before that day.
import type { Item } from "@earlyscript/editorial-contracts/item";
import { DAY_MS, dayStart } from "../days.ts";
import { sha256 } from "../hash.ts";
import { createHttpClient, SourceFailure, type GetResponse, type HttpOptions } from "./http.ts";
import { followRedirects, robotsGate, type RobotsGate } from "./robots.ts";
import type { RssFeed } from "./rss-feeds.ts";
import { githubEntity, plainText, sortItems } from "./shared.ts";
import {
  decodeEntities,
  element,
  elements,
  parseXml,
  textOf,
  XmlError,
  type XmlElement,
} from "./xml.ts";
import type { DayResult } from "./adapter.ts";

export interface FeedEntry {
  readonly key: string;
  readonly link: string | null;
  readonly title: string;
  /** `description` (RSS) or `summary` (Atom): what the publisher offers as a teaser. */
  readonly summary: string;
  /** `content:encoded` (RSS) or `content` (Atom): often the whole article; never stored whole. */
  readonly content: string;
  /** Epoch milliseconds; null when the entry has no parseable date. */
  readonly published: number | null;
  readonly author: string | null;
}

/** RSS `author` is an e-mail address, optionally with a name in parentheses; keep only the name. */
function rssAuthor(value: string): string | null {
  const named = /\(([^)]+)\)\s*$/.exec(value)?.[1]?.trim();
  if (named) return named;
  return value.includes("@") || !value.trim() ? null : value.trim();
}

function date(...values: ReadonlyArray<string>): number | null {
  for (const value of values) {
    const ms = Date.parse(value.trim());
    if (value.trim() && Number.isFinite(ms)) return ms;
  }
  return null;
}

function absolute(href: string, base: string): string | null {
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function atomLink(entry: XmlElement, base: string): string | null {
  const links = elements(entry, "link", "atom:link");
  const alternate =
    links.find((link) => (link.attrs.rel ?? "alternate") === "alternate") ?? links[0];
  return alternate?.attrs.href ? absolute(alternate.attrs.href, base) : null;
}

export interface FeedDocument {
  readonly title: string;
  readonly entries: Array<FeedEntry>;
}

/** Entries of an RSS 2.0 or Atom document; throws XmlError when it is neither. */
export const parseFeed = (text: string, feedUrl: string): Array<FeedEntry> =>
  parseFeedDocument(text, feedUrl).entries;

export function parseFeedDocument(text: string, feedUrl: string): FeedDocument {
  const root = parseXml(text);
  if (root.name === "rss" || root.name === "rdf:RDF") {
    const channel = element(root, "channel");
    if (!channel) throw new XmlError("RSS without channel");
    const title = feedText(textOf(element(channel, "title")));
    // RSS 1.0 keeps items beside the channel; RSS 2.0 inside it.
    const items = [...elements(channel, "item"), ...elements(root, "item")];
    return {
      title,
      entries: items.map((item) => {
        const guid = textOf(element(item, "guid")).trim();
        const link =
          absolute(textOf(element(item, "link")), feedUrl) ??
          (/^https?:\/\//.test(guid) ? guid : null);
        return {
          key: guid || link || textOf(element(item, "title")),
          link,
          title: textOf(element(item, "title")),
          summary: textOf(element(item, "description")),
          content: textOf(element(item, "content:encoded")),
          published: date(textOf(element(item, "pubDate")), textOf(element(item, "dc:date"))),
          author:
            textOf(element(item, "dc:creator")).trim() ||
            rssAuthor(textOf(element(item, "author"))),
        };
      }),
    };
  }
  if (root.name === "feed" || root.name === "atom:feed") {
    const title = feedText(textOf(element(root, "title", "atom:title")));
    return {
      title,
      entries: elements(root, "entry", "atom:entry").map((entry) => {
        const link = atomLink(entry, feedUrl);
        return {
          key: textOf(element(entry, "id", "atom:id")).trim() || link || "",
          link,
          title: textOf(element(entry, "title", "atom:title")),
          summary: textOf(element(entry, "summary", "atom:summary")),
          content: textOf(element(entry, "content", "atom:content")),
          published: date(
            textOf(element(entry, "published", "atom:published")),
            textOf(element(entry, "updated", "atom:updated")),
          ),
          author:
            textOf(
              element(element(entry, "author", "atom:author") ?? entry, "name", "atom:name"),
            ).trim() || null,
        };
      }),
    };
  }
  throw new XmlError(`Not an RSS or Atom document: <${root.name}>`);
}

/** Last 200 body per feed URL, replayed when the server answers 304. */
export interface CachedFeed {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly text: string;
}

/**
 * Longest body kept from a feed. Summaries can be whole posts (simonwillison.net puts the
 * full text in Atom `summary`), so every body is an excerpt of at most this many characters.
 */
export const EXCERPT_CHARS = 500;

/** Plain text of feed HTML, with the HTML entities plainText leaves behind decoded. */
const feedText = (html: string) => decodeEntities(plainText(html)).trim();

/**
 * The stored body: the summary, else the content; cut to EXCERPT_CHARS either way.
 * `body_kind` says where the text came from; `truncated` says whether it was cut.
 */
export function feedBody(entry: Pick<FeedEntry, "summary" | "content">) {
  const summary = feedText(entry.summary);
  const text = summary || feedText(entry.content);
  const cut = text.length > EXCERPT_CHARS;
  return {
    body: cut ? text.slice(0, EXCERPT_CHARS) : text,
    body_length: text.length,
    truncated: cut,
    body_kind: summary ? ("summary" as const) : ("content" as const),
  };
}

export interface RssDeps {
  readonly feeds: ReadonlyArray<RssFeed>;
  /** Routes each URL to its host's client and gates every redirect hop (followRedirects). */
  readonly get: GetResponse;
  readonly robots: RobotsGate;
  readonly cache: Map<string, CachedFeed>;
}

export async function collectRssDay(
  day: string,
  deps: RssDeps,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const start = dayStart(day);
  const end = start + DAY_MS;
  const items = new Map<string, Item>();
  const failed: Array<string> = [];
  const short: Array<string> = [];
  let responded = 0;
  let retrievedAt = now;
  for (const feed of deps.feeds) {
    let text: string;
    let observed: string;
    try {
      const refusal = await deps.robots(feed.feedUrl);
      if (refusal) throw new SourceFailure(refusal);
      const cached = deps.cache.get(feed.feedUrl);
      const response = await deps.get(feed.feedUrl, {
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
        ...(cached?.lastModified ? { "If-Modified-Since": cached.lastModified } : {}),
      });
      observed = retrievedAt = response.observed_at;
      if (response.status === 304 && cached) text = cached.text;
      else if (response.status === 200 && typeof response.body === "string") {
        text = response.body;
        deps.cache.set(feed.feedUrl, {
          etag: response.etag ?? null,
          lastModified: response.last_modified ?? null,
          text,
        });
      } else throw new SourceFailure(`HTTP ${response.status}`);
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      failed.push(`${feed.id} (${error.message})`);
      continue;
    }
    let entries: Array<FeedEntry>;
    try {
      entries = parseFeed(text, feed.feedUrl);
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
      failed.push(`${feed.id} (invalid feed: ${error.message})`);
      continue;
    }
    responded++;
    const dated = entries.flatMap((entry) => (entry.published === null ? [] : [entry.published]));
    // Entries older than the oldest listed one have rotated out: the day may be missing some.
    if (dated.length < entries.length || !dated.length || Math.min(...dated) >= start)
      short.push(feed.id);
    for (const entry of entries) {
      if (entry.published === null || entry.published < start || entry.published >= end) continue;
      const body = feedBody(entry);
      const link = entry.link ?? feed.siteUrl;
      const id = `itm_rss_${feed.id}_${sha256(entry.key || link).slice(7, 23)}`;
      if (!items.has(id))
        items.set(id, {
          id,
          source: "rss",
          permalink: link,
          external_url: entry.link,
          published_at: new Date(entry.published).toISOString(),
          author: entry.author ?? feed.name,
          title: feedText(entry.title) || body.body.slice(0, 120),
          ...body,
          feed_url: feed.feedUrl,
          retrieved_at: observed,
          entities: githubEntity(entry.link),
        });
    }
  }
  const notes = [`feeds=${deps.feeds.length} responded=${responded}`];
  if (failed.length) notes.push(`failed: ${failed.join(", ")}`);
  if (short.length) notes.push(`window_short: ${short.join(", ")}`);
  const unfinished = end > Date.parse(retrievedAt);
  if (unfinished) notes.push("Day not finished at retrieval");
  const status =
    responded === 0
      ? "unavailable"
      : failed.length || short.length || unfinished
        ? "partial"
        : "complete";
  return {
    items: sortItems([...items.values()]),
    coverage: {
      source: "rss",
      day,
      status,
      items: items.size,
      retrieved_at: retrievedAt,
      note: notes.join("; "),
    },
  };
}

export type FeedValidationError = "not-a-feed" | "robots-disallowed" | "unreachable";

export type FeedValidation =
  | {
      readonly ok: true;
      readonly url: string;
      readonly title: string;
      readonly entries: number;
      /** ISO instant of the newest dated entry; null when no entry has a date. */
      readonly latest: string | null;
    }
  | {
      readonly ok: false;
      readonly url: string;
      readonly error: FeedValidationError;
      readonly message: string;
    };

/**
 * Checks a feed URL before it joins a user's list: robots.txt, one download with the
 * collector's User-Agent, and a parse. Never throws for network or content problems.
 */
export async function validateFeed(
  url: string,
  options: HttpOptions = {},
): Promise<FeedValidation> {
  const fail = (error: FeedValidationError, message: string): FeedValidation => ({
    ok: false,
    url,
    error,
    message,
  });
  try {
    const { protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:")
      return fail("unreachable", "Only http and https URLs are supported");
  } catch {
    return fail("unreachable", "Invalid URL");
  }
  // One request per call; a settings form should answer in seconds, not minutes.
  const get = createHttpClient("rss", {
    dayTimeoutMs: 60_000,
    requestTimeoutMs: 15_000,
    ...options,
    text: true,
  });
  const robots = robotsGate(() => get, new Map());
  const refused = (message: string) =>
    fail(message.startsWith("robots_disallowed") ? "robots-disallowed" : "unreachable", message);
  let response;
  try {
    const refusal = await robots(url);
    if (refusal) return refused(refusal);
    response = await followRedirects(() => get, robots)(url);
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error;
    return refused(error.message);
  }
  if (response.status !== 200 || typeof response.body !== "string")
    return fail("unreachable", `HTTP ${response.status}`);
  let document: FeedDocument;
  try {
    document = parseFeedDocument(response.body, url);
  } catch (error) {
    if (!(error instanceof XmlError)) throw error;
    return fail("not-a-feed", error.message);
  }
  const dates = document.entries.flatMap((entry) =>
    entry.published === null ? [] : [entry.published],
  );
  return {
    ok: true,
    url,
    title: document.title,
    entries: document.entries.length,
    latest: dates.length ? new Date(Math.max(...dates)).toISOString() : null,
  };
}
