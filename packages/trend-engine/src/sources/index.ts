import type {
  CoverageRecord,
  RobotsOverride,
  RssFeed,
  SourceDescriptor,
  SourceId,
} from "@earlyscript/editorial-contracts/source";

import type { DayResult, SourceAdapter } from "./adapter.ts";
import {
  createHttpClient,
  MAX_RESPONSE_BYTES,
  type FrozenResponse,
  type GetResponse,
  type HttpOptions,
  type HttpSource,
} from "./http.ts";
import {
  followRedirects,
  robotsGate,
  type RobotsDecision,
  type RobotsGate,
  type RobotsRule,
} from "./robots.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";
import { HF_SELECTION, huggingfaceCollector } from "./huggingface.ts";
import { collectLobstersDay } from "./lobsters.ts";
import { collectRssDay, type CachedFeed } from "./rss.ts";
import { RSS_FEEDS } from "./rss-feeds.ts";
import { collectArxivDay } from "./arxiv.ts";
import { collectWikipediaDay } from "./wikipedia.ts";
import { collectNpmDay, NPM_MIN_WEEKLY_DOWNLOADS } from "./npm.ts";
import { collectStackExchangeDay } from "./stackexchange.ts";
import { collectBlueskyDay } from "./bluesky.ts";

import { fixtureAdapter } from "./fixture.ts";

// Partial: the catalog lists sources whose adapter has not landed yet.
export const SOURCES: Readonly<Partial<Record<SourceId, SourceDescriptor>>> = {
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
  arxiv: {
    id: "arxiv",
    label: "arXiv",
    selection: {
      arxiv:
        "cs.AI, cs.CL, cs.SE and cs.LG submissions per UTC day by submittedDate; first 1000; complete only 4 days after the day",
    },
    coverage_policy: "census",
    // export.arxiv.org/robots.txt disallows every path; the API terms authorise this use.
    robots_override: {
      reason:
        "arXiv API Terms of Use allow the legacy API at one request every three seconds on a single connection, though export.arxiv.org/robots.txt disallows /",
      terms_url: "https://info.arxiv.org/help/api/tou.html",
    },
  },
  wikipedia: {
    id: "wikipedia",
    label: "Wikipedia",
    selection: {
      wikipedia:
        "en.wikipedia all-access top 1000 per UTC day; non-article pages excluded; no summaries (robots.txt): title, URL, views and rank only",
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
const COLLECTORS: Readonly<
  Partial<Record<Exclude<SourceId, "lobsters" | "rss">, () => Collector>>
> = {
  hn: () => (day, get) => collectHnDay(day, get),
  github: () => (day, get) => collectGithubDay(day, get),
  huggingface: huggingfaceCollector,
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

export function sourceDescriptor(id: SourceId): SourceDescriptor {
  const descriptor = SOURCES[id];
  if (!descriptor) throw new Error(`No adapter for source: ${id}`);
  return descriptor;
}

export const isSampleSource = (id: SourceId): boolean =>
  sourceDescriptor(id).coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, sourceDescriptor(id)));

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
function lobstersAdapter(given: HttpOptions): SourceAdapter {
  const { options, onDecision } = tracedRobots(given);
  const state = { nextStart: 0, blockedUntil: 0 };
  const rules = new Map<string, ReadonlyArray<RobotsRule>>();
  return {
    descriptor: sourceDescriptor("lobsters"),
    collectDay: (day) => {
      const text = createHttpClient("lobsters", { ...options, text: true, anonymous: true }, state);
      const json = createHttpClient("lobsters", options, state);
      const robots = robotsGate(() => text, rules, undefined, onDecision);
      return collectLobstersDay(
        day,
        followRedirects(() => json, robots),
        robots,
      );
    },
  };
}

/** RSS, paced per host; validators and robots rules last for the whole collect run. */
function rssAdapter(given: HttpOptions, feeds: ReadonlyArray<RssFeed>): SourceAdapter {
  const { options, onDecision } = tracedRobots(given);
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
      const robots = robotsGate(getFor, rules, undefined, onDecision);
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

const isHttpSource = (id: SourceId): id is HttpSource => id in MAX_RESPONSE_BYTES;

/**
 * Traces each request with the robots.txt decision its gate took. The decision is looked up
 * by URL when the request is sent; robots.txt itself is labelled as such.
 */
function tracedRobots(options: HttpOptions): {
  readonly options: HttpOptions;
  readonly onDecision: (url: string, decision: RobotsDecision) => void;
} {
  const decisions = new Map<string, RobotsDecision>();
  return {
    options: options.trace
      ? {
          ...options,
          robotsDecision: (url) =>
            new URL(url).pathname === "/robots.txt"
              ? "robots.txt"
              : (decisions.get(url) ?? "not-gated"),
        }
      : options,
    onDecision: (url, decision) => {
      if (!options.trace) return;
      // A collect run asks for a few thousand URLs at most; keep the map bounded anyway.
      if (decisions.size >= 10_000) decisions.clear();
      decisions.set(url, decision);
    },
  };
}

/** The coverage note's prefix for a day collected under a robots.txt exception. */
export const robotsOverrideNote = (override: RobotsOverride): string =>
  `robots_override: ${override.reason} (terms: ${override.terms_url})`;

/** Records the exception on a day's coverage: in the note and as a structured field. */
export function withRobotsOverride(
  coverage: CoverageRecord,
  override: RobotsOverride,
): CoverageRecord {
  const note = [robotsOverrideNote(override), coverage.note].filter(Boolean).join("; ");
  return { ...coverage, note, robots_override: override };
}

export function liveSources(
  ids: ReadonlyArray<SourceId>,
  given: HttpOptions = {},
  config: LiveSourceConfig = {},
): Array<SourceAdapter> {
  return ids.map((id) => {
    if (id === "lobsters") return lobstersAdapter(given);
    if (id === "rss") return rssAdapter(given, config.rssFeeds ?? RSS_FEEDS);
    const { options, onDecision } = tracedRobots(given);
    const descriptor = sourceDescriptor(id);
    const makeCollector = COLLECTORS[id];
    if (!makeCollector || !isHttpSource(id)) throw new Error(`No live adapter for source: ${id}`);
    const state = { nextStart: 0, blockedUntil: 0 };
    const rules = new Map<string, ReadonlyArray<RobotsRule>>();
    const collect = makeCollector();
    return {
      descriptor,
      collectDay: async (day) => {
        // Collectors gate their own URLs; a redirect away from them is gated per hop.
        // robots.txt goes without credentials; model cards carry them on their own origin only.
        const anonymous = createHttpClient(id, { ...options, text: true, anonymous: true }, state);
        const text = createHttpClient(id, { ...options, text: true }, state);
        const json = createHttpClient(id, options, state);
        const override = descriptor.robots_override;
        let overridden = false;
        const robots = robotsGate(
          () => anonymous,
          rules,
          override
            ? {
                override,
                onOverride: () => {
                  overridden = true;
                },
              }
            : undefined,
          onDecision,
        );
        const result = await collect(
          day,
          followRedirects(() => json, robots),
          robots,
          followRedirects(() => text, robots),
        );
        // A day collected past a robots.txt Disallow records the documented exception.
        if (!overridden || !override || !result.coverage) return result;
        return { ...result, coverage: withRobotsOverride(result.coverage, override) };
      },
    };
  });
}
