import type { RssFeed, SourceDescriptor, SourceId } from "@earlyscript/editorial-contracts/source";

import type { DayResult, SourceAdapter } from "./adapter.ts";
import {
  createHttpClient,
  type FrozenResponse,
  type GetResponse,
  type HttpOptions,
} from "./http.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";
import { collectLobstersDay } from "./lobsters.ts";
import { followRedirects, robotsGate, type RobotsGate, type RobotsRule } from "./robots.ts";
import { collectRssDay, type CachedFeed } from "./rss.ts";
import { RSS_FEEDS } from "./rss-feeds.ts";
import { collectArxivDay } from "./arxiv.ts";
import { collectWikipediaDay } from "./wikipedia.ts";
import { collectNpmDay, NPM_MIN_WEEKLY_DOWNLOADS } from "./npm.ts";
import { collectStackExchangeDay, stackExchangeThrottle } from "./stackexchange.ts";
import { collectBlueskyDay } from "./bluesky.ts";

import { fixtureAdapter } from "./fixture.ts";

export const SOURCES: Readonly<Record<SourceId, SourceDescriptor>> = {
  hn: {
    id: "hn",
    label: "Hacker News",
    selection: { hn: "All stories per UTC day; no score or keyword filter" },
    coverage_policy: "census",
  },
  github: {
    id: "github",
    label: "GitHub",
    selection: {
      github:
        "created:day-7..day stars:>=20 fork:false; sort:stars; first 100; present-day metadata",
    },
    // The first 100 repositories by stars per window: a declared sample, never a census.
    coverage_policy: "sample",
  },
  lobsters: {
    id: "lobsters",
    label: "Lobsters",
    selection: {
      lobsters: "All stories created per UTC day from /newest/page/N.json; tags kept in body",
    },
    coverage_policy: "census",
  },
  rss: rssDescriptor(RSS_FEEDS),
  arxiv: {
    id: "arxiv",
    label: "arXiv",
    selection: {
      arxiv:
        "cs.AI, cs.CL, cs.SE and cs.LG submissions per UTC day by submittedDate; first 1000; complete only 4 days after the day",
    },
    coverage_policy: "census",
  },
  wikipedia: {
    id: "wikipedia",
    label: "Wikipedia",
    selection: {
      wikipedia:
        "en.wikipedia all-access top 1000 per UTC day; non-article pages excluded; summaries for the first 50 where en.wikipedia.org robots.txt allows /api/",
    },
    coverage_policy: "sample",
  },
  npm: {
    id: "npm",
    label: "npm",
    selection: {
      npm: `Registry search keywords:ai,llm,agent,mcp,cli; first 1,250 results per query; latest version date on the day; at least ${NPM_MIN_WEEKLY_DOWNLOADS} present weekly downloads; top 100 by them`,
    },
    coverage_policy: "sample",
  },
  stackexchange: {
    id: "stackexchange",
    label: "Stack Exchange",
    selection: {
      stackexchange:
        "stackoverflow and ai questions per UTC creation day; sort:votes; first 300 per site; anonymous quota; capture only, not for the writer",
    },
    coverage_policy: "sample",
  },
  bluesky: {
    id: "bluesky",
    label: "Bluesky",
    selection: {
      bluesky:
        "searchPosts lang=en over llm|agent|open source|github|developer|python|typescript|rust per UTC day; one page per window; purge by author or URI",
    },
    coverage_policy: "sample",
  },
};

/** The feed list is the selection: adding a feed changes the corpus hash. */
export function rssDescriptor(feeds: ReadonlyArray<RssFeed>): SourceDescriptor {
  return {
    id: "rss",
    label: "RSS/Atom",
    selection: { rss: feeds.map((feed) => feed.feedUrl).join(" ") },
    coverage_policy: "census",
  };
}

export const isSampleSource = (id: SourceId): boolean => SOURCES[id].coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, SOURCES[id]));

export type { DayResult, SourceAdapter } from "./adapter.ts";

export { collectHnDay } from "./hn.ts";
export { collectGithubDay } from "./github.ts";

export { collectLobstersDay } from "./lobsters.ts";
export {
  collectRssDay,
  validateFeed,
  type FeedValidation,
  type FeedValidationError,
} from "./rss.ts";
export { RSS_FEEDS, readRssFeedList } from "./rss-feeds.ts";

export interface LiveSourceConfig {
  /** Feeds of the `rss` source; the built-in RSS_FEEDS when absent. */
  readonly rssFeeds?: ReadonlyArray<RssFeed>;
}

/** Lobsters, with its robots.txt read through the same paced client. */
function lobstersAdapter(options: HttpOptions): SourceAdapter {
  const state = { nextStart: 0, blockedUntil: 0 };
  const rules = new Map<string, ReadonlyArray<RobotsRule>>();
  return {
    descriptor: SOURCES.lobsters,
    collectDay: (day) => {
      const text = createHttpClient("lobsters", { ...options, text: true, anonymous: true }, state);
      const json = createHttpClient("lobsters", options, state);
      const robots = robotsGate(() => text, rules);
      return collectLobstersDay(
        day,
        followRedirects(() => json, robots),
        robots,
      );
    },
  };
}

/** RSS, paced per host; validators and robots rules last for the whole collect run. */
function rssAdapter(options: HttpOptions, feeds: ReadonlyArray<RssFeed>): SourceAdapter {
  const states = new Map<string, { nextStart: number; blockedUntil: number }>();
  const rules = new Map<string, ReadonlyArray<RobotsRule>>();
  const cache = new Map<string, CachedFeed>();
  return {
    descriptor: rssDescriptor(feeds),
    collectDay: (day) => {
      const clients = new Map<string, ReturnType<typeof createHttpClient>>();
      const getFor = (url: string) => {
        const host = new URL(url).host;
        let client = clients.get(host);
        if (!client) {
          let state = states.get(host);
          if (!state) states.set(host, (state = { nextStart: 0, blockedUntil: 0 }));
          clients.set(host, (client = createHttpClient("rss", options, state)));
        }
        return client;
      };
      const robots = robotsGate(getFor, rules);
      return collectRssDay(day, { feeds, get: followRedirects(getFor, robots), robots, cache });
    },
  };
}

type GatedSource = "arxiv" | "wikipedia" | "npm" | "stackexchange" | "bluesky";
/** Sources ported from Earlywindow: each asks robots.txt before its requests. */
const GATED: Readonly<
  Record<GatedSource, (day: string, get: GetResponse, robots: RobotsGate) => Promise<DayResult>>
> = {
  arxiv: collectArxivDay,
  wikipedia: collectWikipediaDay,
  npm: collectNpmDay,
  stackexchange: collectStackExchangeDay,
  bluesky: collectBlueskyDay,
};
const isGated = (id: SourceId): id is GatedSource => Object.hasOwn(GATED, id);

/** Caches 200 responses for the life of one adapter (one collect run). */
function memoized(get: GetResponse, memo: Map<string, FrozenResponse>): GetResponse {
  return async (url, headers) => {
    const hit = memo.get(url);
    if (hit) return hit;
    const response = await get(url, headers);
    if (response.status === 200) memo.set(url, response);
    return response;
  };
}

/**
 * One paced client per source shared by its data and its robots.txt requests. robots.txt is
 * read again each day: the rules map lives for one collectDay call. npm search pages do not
 * depend on the day, so one collect run reads them once for all its days.
 */
function gatedAdapter(id: GatedSource, options: HttpOptions): SourceAdapter {
  const state = { nextStart: 0, blockedUntil: 0 };
  const pages = new Map<string, FrozenResponse>();
  const own = {
    ...options,
    ...(id === "stackexchange" ? { throttle: stackExchangeThrottle } : {}),
  };
  return {
    descriptor: SOURCES[id],
    collectDay: (day) => {
      const text = createHttpClient(id, { ...own, text: true, anonymous: true }, state);
      const robots = robotsGate(() => text, new Map<string, ReadonlyArray<RobotsRule>>());
      // The arXiv API answers Atom XML, read as text like robots.txt.
      const client = createHttpClient(id, id === "arxiv" ? { ...own, text: true } : own, state);
      const data = id === "npm" ? memoized(client, pages) : client;
      return GATED[id](
        day,
        followRedirects(() => data, robots),
        robots,
      );
    },
  };
}

export function liveSources(
  ids: ReadonlyArray<SourceId>,
  options: HttpOptions = {},
  config: LiveSourceConfig = {},
): Array<SourceAdapter> {
  return ids.map((id) => {
    if (id === "lobsters") return lobstersAdapter(options);
    if (id === "rss") return rssAdapter(options, config.rssFeeds ?? RSS_FEEDS);
    if (isGated(id)) return gatedAdapter(id, options);
    const state = { nextStart: 0, blockedUntil: 0 };
    const rules = new Map<string, ReadonlyArray<RobotsRule>>();
    return {
      descriptor: SOURCES[id],
      collectDay: (day) => {
        // API URLs are not robots-gated, but a redirect away from them is.
        const text = createHttpClient(id, { ...options, text: true, anonymous: true }, state);
        const json = createHttpClient(id, options, state);
        const get = followRedirects(
          () => json,
          robotsGate(() => text, rules),
        );
        return (id === "hn" ? collectHnDay : collectGithubDay)(day, get);
      },
    };
  });
}
