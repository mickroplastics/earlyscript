import type { RssFeed, SourceDescriptor, SourceId } from "@earlyscript/editorial-contracts/source";

import type { DayResult, SourceAdapter } from "./adapter.ts";
import {
  createHttpClient,
  type FrozenResponse,
  type GetResponse,
  type HttpOptions,
} from "./http.ts";
import { followRedirects, robotsGate, type RobotsGate, type RobotsRule } from "./robots.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";
import { HF_SELECTION, huggingfaceCollector } from "./huggingface.ts";
import { DEVTO_SELECTION, devtoCollector } from "./devto.ts";
import { collectLobstersDay } from "./lobsters.ts";
import { collectRssDay, type CachedFeed } from "./rss.ts";
import { RSS_FEEDS } from "./rss-feeds.ts";
import { collectArxivDay } from "./arxiv.ts";
import { collectWikipediaDay } from "./wikipedia.ts";
import { collectNpmDay, NPM_MIN_WEEKLY_DOWNLOADS } from "./npm.ts";
import { collectStackExchangeDay } from "./stackexchange.ts";
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
  huggingface: {
    id: "huggingface",
    label: "Hugging Face",
    selection: { huggingface: HF_SELECTION },
    // Models are chosen by present-day likes: a declared sample, as GitHub.
    coverage_policy: "sample",
  },
  devto: {
    id: "devto",
    label: "DEV Community",
    selection: { devto: DEVTO_SELECTION },
    // Up to 500 articles a day by present-day reactions: a declared sample.
    coverage_policy: "sample",
  },
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

type Collector = (
  day: string,
  get: GetResponse,
  robots: RobotsGate,
  getText: GetResponse,
) => Promise<DayResult>;
/** A fresh collector per adapter: listings walked once are kept between that adapter's days. */
const COLLECTORS: Readonly<Record<Exclude<SourceId, "lobsters" | "rss">, () => Collector>> = {
  hn: () => (day, get) => collectHnDay(day, get),
  github: () => (day, get) => collectGithubDay(day, get),
  huggingface: huggingfaceCollector,
  devto: devtoCollector,
  // Ported from Earlywindow (es/sources-earlywindow): each gates its own URLs with robots.
  // The arXiv API answers Atom XML, read through the text client.
  arxiv: () => (day, _get, robots, getText) => collectArxivDay(day, getText, robots),
  wikipedia: () => (day, get, robots) => collectWikipediaDay(day, get, robots),
  // npm search pages do not depend on the day: one collect run reads each once.
  npm: () => {
    const pages = new Map<string, FrozenResponse>();
    return (day, get, robots) => collectNpmDay(day, memoized(get, pages), robots);
  },
  stackexchange: () => (day, get, robots) => collectStackExchangeDay(day, get, robots),
  bluesky: () => (day, get, robots) => collectBlueskyDay(day, get, robots),
};

export const isSampleSource = (id: SourceId): boolean => SOURCES[id].coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, SOURCES[id]));

export type { DayResult, SourceAdapter } from "./adapter.ts";

export { collectHnDay } from "./hn.ts";
export { collectGithubDay } from "./github.ts";
export { huggingfaceCollector } from "./huggingface.ts";
export { devtoCollector } from "./devto.ts";

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

export function liveSources(
  ids: ReadonlyArray<SourceId>,
  options: HttpOptions = {},
  config: LiveSourceConfig = {},
): Array<SourceAdapter> {
  return ids.map((id) => {
    if (id === "lobsters") return lobstersAdapter(options);
    if (id === "rss") return rssAdapter(options, config.rssFeeds ?? RSS_FEEDS);
    const state = { nextStart: 0, blockedUntil: 0 };
    const rules = new Map<string, ReadonlyArray<RobotsRule>>();
    const collect = COLLECTORS[id]();
    return {
      descriptor: SOURCES[id],
      collectDay: (day) => {
        // Collectors gate their own URLs; a redirect away from them is gated per hop.
        // robots.txt goes without credentials; model cards carry them on their own origin only.
        const anonymous = createHttpClient(id, { ...options, text: true, anonymous: true }, state);
        const text = createHttpClient(id, { ...options, text: true }, state);
        const json = createHttpClient(id, options, state);
        const robots = robotsGate(() => anonymous, rules);
        return collect(
          day,
          followRedirects(() => json, robots),
          robots,
          followRedirects(() => text, robots),
        );
      },
    };
  });
}
