import type { SourceDescriptor, SourceId } from "@earlyscript/editorial-contracts/source";

import type { SourceAdapter } from "./adapter.ts";
import { createHttpClient, type HttpOptions } from "./http.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";
import { collectLobstersDay } from "./lobsters.ts";
import { robotsGate, type RobotsRule } from "./robots.ts";
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
  rss: {
    id: "rss",
    label: "RSS/Atom",
    // The feed list is the selection: adding a feed changes the corpus hash.
    selection: { rss: RSS_FEEDS.map((feed) => feed.feedUrl).join(" ") },
    coverage_policy: "census",
  },
};

export const isSampleSource = (id: SourceId): boolean => SOURCES[id].coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, SOURCES[id]));

export type { DayResult, SourceAdapter } from "./adapter.ts";

export { collectHnDay } from "./hn.ts";
export { collectGithubDay } from "./github.ts";

export { collectLobstersDay } from "./lobsters.ts";
export { collectRssDay } from "./rss.ts";

/** Lobsters, with its robots.txt read through the same paced client. */
function lobstersAdapter(options: HttpOptions): SourceAdapter {
  const state = { nextStart: 0, blockedUntil: 0 };
  const rules = new Map<string, ReadonlyArray<RobotsRule>>();
  return {
    descriptor: SOURCES.lobsters,
    collectDay: (day) => {
      const text = createHttpClient("lobsters", { ...options, text: true }, state);
      return collectLobstersDay(
        day,
        createHttpClient("lobsters", options, state),
        robotsGate(() => text, rules),
      );
    },
  };
}

/** RSS, paced per host; validators and robots rules last for the whole collect run. */
function rssAdapter(options: HttpOptions): SourceAdapter {
  const states = new Map<string, { nextStart: number; blockedUntil: number }>();
  const rules = new Map<string, ReadonlyArray<RobotsRule>>();
  const cache = new Map<string, CachedFeed>();
  return {
    descriptor: SOURCES.rss,
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
      return collectRssDay(day, {
        feeds: RSS_FEEDS,
        getFor,
        robots: robotsGate(getFor, rules),
        cache,
      });
    },
  };
}

export function liveSources(
  ids: ReadonlyArray<SourceId>,
  options: HttpOptions = {},
): Array<SourceAdapter> {
  return ids.map((id) => {
    if (id === "lobsters") return lobstersAdapter(options);
    if (id === "rss") return rssAdapter(options);
    const state = { nextStart: 0, blockedUntil: 0 };
    return {
      descriptor: SOURCES[id],
      collectDay: (day) =>
        (id === "hn" ? collectHnDay : collectGithubDay)(day, createHttpClient(id, options, state)),
    };
  });
}
