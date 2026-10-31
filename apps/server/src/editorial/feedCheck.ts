import { robotsAllows, robotsRules } from "@earlyscript/trend-engine/sources/robots";
import {
  element,
  elements,
  parseXml,
  textOf,
  type XmlElement,
} from "@earlyscript/trend-engine/sources/xml";
import { EditorialSourcesError, type EditorialFeedCheck } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient } from "effect/http";

import { nowIso } from "./persistence/support.ts";

// The engine's collector identity (trend-engine sources/http.ts on es/sources-lobsters-rss).
export const FEED_USER_AGENT = "Earlyscript/0.1 (+https://github.com/miwgel)";
const FEED_TIMEOUT = Duration.seconds(10);
const FEED_MAX_BYTES = 4 * 1024 * 1024;

export interface FetchedPage {
  readonly status: number;
  readonly body: string;
}

/** One GET with the engine's User-Agent; fails only when nothing usable answered. */
export class EditorialFeedFetcher extends Context.Service<
  EditorialFeedFetcher,
  { readonly get: (url: string) => Effect.Effect<FetchedPage, string> }
>()("t3/editorial/feedCheck/EditorialFeedFetcher") {}

export const layerFetch = Layer.effect(
  EditorialFeedFetcher,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const get = Effect.fn("EditorialFeedFetcher.get")(
      function* (url: string) {
        const response = yield* client.get(url, {
          headers: {
            "User-Agent": FEED_USER_AGENT,
            Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          },
        });
        const bytes = yield* response.arrayBuffer;
        if (bytes.byteLength > FEED_MAX_BYTES) return yield* Effect.fail("response over 4 MiB");
        return { status: response.status, body: new TextDecoder().decode(bytes) };
      },
      Effect.mapError((error) => (typeof error === "string" ? error : error.message)),
      Effect.timeoutOrElse({
        duration: FEED_TIMEOUT,
        orElse: () => Effect.fail("no answer in 10 s"),
      }),
    );
    return EditorialFeedFetcher.of({ get });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

const failure = (reason: EditorialSourcesError["reason"], message: string) =>
  new EditorialSourcesError({ reason, message });

export function normalizeFeedUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const entryDate = (entry: XmlElement, ...names: ReadonlyArray<string>): number | null => {
  for (const name of names) {
    const value = textOf(element(entry, name)).trim();
    if (!value) continue;
    const parsed = DateTime.make(value);
    if (Option.isSome(parsed)) return DateTime.toEpochMillis(parsed.value);
  }
  return null;
};

const absolute = (href: string, base: string): string | null => {
  try {
    return new URL(href.trim(), base).href;
  } catch {
    return null;
  }
};

interface FeedSummary {
  readonly format: "rss" | "atom";
  readonly title: string | null;
  readonly siteUrl: string | null;
  readonly entries: number;
  readonly latestMillis: number | null;
}

/**
 * Title, site and entry dates of an RSS 2.0, RSS 1.0 or Atom document; null when it is
 * neither. Temporary: `parseFeed` of trend-engine's rss.ts replaces it once that is on main.
 */
function summarizeFeed(text: string, feedUrl: string): FeedSummary | null {
  let root: XmlElement;
  try {
    root = parseXml(text);
  } catch {
    return null;
  }
  const latest = (dates: ReadonlyArray<number | null>) =>
    dates.reduce<number | null>(
      (max, date) => (date !== null && (max === null || date > max) ? date : max),
      null,
    );
  if (root.name === "rss" || root.name === "rdf:RDF") {
    const channel = element(root, "channel");
    if (!channel) return null;
    const items = [...elements(channel, "item"), ...elements(root, "item")];
    const link = textOf(element(channel, "link")).trim();
    return {
      format: "rss",
      title: textOf(element(channel, "title")).trim() || null,
      siteUrl: link ? absolute(link, feedUrl) : null,
      entries: items.length,
      latestMillis: latest(items.map((item) => entryDate(item, "pubDate", "dc:date"))),
    };
  }
  if (root.name === "feed" || root.name === "atom:feed") {
    const entries = elements(root, "entry", "atom:entry");
    const links = elements(root, "link", "atom:link");
    const alternate = links.find((link) => (link.attrs.rel ?? "alternate") === "alternate");
    return {
      format: "atom",
      title: textOf(element(root, "title", "atom:title")).trim() || null,
      siteUrl: alternate?.attrs.href ? absolute(alternate.attrs.href, feedUrl) : null,
      entries: entries.length,
      latestMillis: latest(
        entries.map((entry) => entryDate(entry, "updated", "published", "atom:updated")),
      ),
    };
  }
  return null;
}

/**
 * robots.txt first, as the engine does (RFC 9309: a 4xx means no rules, an unreachable or 5xx
 * file disallows), and only then one download of the feed.
 */
export const checkFeed = Effect.fn("EditorialFeedCheck.check")(function* (input: string) {
  const fetcher = yield* EditorialFeedFetcher;
  const feedUrl = normalizeFeedUrl(input);
  if (feedUrl === null) {
    return yield* failure("invalid-url", `Not an http or https URL: ${input}`);
  }
  const robotsUrl = `${new URL(feedUrl).origin}/robots.txt`;
  const robots = yield* fetcher
    .get(robotsUrl)
    .pipe(
      Effect.mapError((message) =>
        failure("robots-unavailable", `${robotsUrl} did not answer: ${message}`),
      ),
    );
  if (robots.status >= 500 || (robots.status !== 200 && robots.status < 400)) {
    return yield* failure("robots-unavailable", `${robotsUrl} answered HTTP ${robots.status}`);
  }
  const rules = robots.status === 200 ? robotsRules(robots.body) : [];
  if (!robotsAllows(rules, feedUrl)) {
    return yield* failure(
      "robots-disallowed",
      `${robotsUrl} disallows ${new URL(feedUrl).pathname} for Earlyscript`,
    );
  }
  const page = yield* fetcher
    .get(feedUrl)
    .pipe(Effect.mapError((message) => failure("unreachable", `${feedUrl}: ${message}`)));
  if (page.status !== 200) {
    return yield* failure("unreachable", `${feedUrl} answered HTTP ${page.status}`);
  }
  const summary = summarizeFeed(page.body, feedUrl);
  if (summary === null) {
    return yield* failure("not-a-feed", `${feedUrl} is not an RSS or Atom document`);
  }
  return {
    feedUrl,
    format: summary.format,
    title: summary.title,
    siteUrl: summary.siteUrl,
    entries: summary.entries,
    latestAt:
      summary.latestMillis === null
        ? null
        : DateTime.formatIso(DateTime.makeUnsafe(summary.latestMillis)),
    checkedAt: yield* nowIso,
  } satisfies EditorialFeedCheck;
});
