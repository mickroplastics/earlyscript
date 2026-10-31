import type { RssFeed, SourceDescriptor, SourceId } from "@earlyscript/editorial-contracts/source";

import type { DayResult, SourceAdapter } from "./adapter.ts";
import { createHttpClient, type GetResponse, type HttpOptions } from "./http.ts";
import { followRedirects, robotsGate, type RobotsGate, type RobotsRule } from "./robots.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";
import { HF_SELECTION, huggingfaceCollector } from "./huggingface.ts";
import { collectLobstersDay } from "./lobsters.ts";
import { collectRssDay, type CachedFeed } from "./rss.ts";
import { RSS_FEEDS } from "./rss-feeds.ts";

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
};

export const isSampleSource = (id: SourceId): boolean => SOURCES[id].coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, SOURCES[id]));

export type { DayResult, SourceAdapter } from "./adapter.ts";

export { collectHnDay } from "./hn.ts";
export { collectGithubDay } from "./github.ts";
export { huggingfaceCollector } from "./huggingface.ts";

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
