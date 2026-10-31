import type { SourceDescriptor, SourceId } from "@earlyscript/editorial-contracts/source";

import type { DayResult, SourceAdapter } from "./adapter.ts";
import { createHttpClient, type GetResponse, type HttpOptions } from "./http.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";
import { robotsGate, type RobotsGate, type RobotsRule } from "./robots.ts";
import { collectArxivDay } from "./arxiv.ts";
import { collectWikipediaDay } from "./wikipedia.ts";
import { collectNpmDay, NPM_MIN_WEEKLY_DOWNLOADS } from "./npm.ts";
import { collectStackExchangeDay, stackExchangeThrottle } from "./stackexchange.ts";
import { collectBlueskyDay } from "./bluesky.ts";

import { fixtureAdapter } from "./fixture.ts";

/**
 * Every source with an adapter. A new source adds its id to `SourceId`, one entry here and
 * its pause and size limit in `http.ts`; the compiler rejects an id without them.
 */
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
      npm: `Registry search keywords:ai,llm,agent,mcp,cli; first 5,250 results per query; latest version date on the day; at least ${NPM_MIN_WEEKLY_DOWNLOADS} present weekly downloads; top 100 by them`,
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

export const isSampleSource = (id: SourceId): boolean => SOURCES[id].coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, SOURCES[id]));

export type { DayResult, SourceAdapter } from "./adapter.ts";

export { collectHnDay } from "./hn.ts";
export { collectGithubDay } from "./github.ts";

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

/**
 * One paced client per source shared by its data and its robots.txt requests. robots.txt is
 * read again each day: the rules map lives for one collectDay call.
 */
function gatedAdapter(id: GatedSource, options: HttpOptions): SourceAdapter {
  const state = { nextStart: 0, blockedUntil: 0 };
  const own = {
    ...options,
    ...(id === "stackexchange" ? { throttle: stackExchangeThrottle } : {}),
  };
  return {
    descriptor: SOURCES[id],
    collectDay: (day) => {
      const text = createHttpClient(id, { ...own, text: true }, state);
      const rules = new Map<string, ReadonlyArray<RobotsRule>>();
      // The arXiv API answers Atom XML, read as text like robots.txt.
      const data = id === "arxiv" ? text : createHttpClient(id, own, state);
      return GATED[id](day, data, robotsGate(() => text, rules));
    },
  };
}

export function liveSources(
  ids: ReadonlyArray<SourceId>,
  options: HttpOptions = {},
): Array<SourceAdapter> {
  return ids.map((id) => {
    if (isGated(id)) return gatedAdapter(id, options);
    const state = { nextStart: 0, blockedUntil: 0 };
    return {
      descriptor: SOURCES[id],
      collectDay: (day) =>
        (id === "hn" ? collectHnDay : collectGithubDay)(day, createHttpClient(id, options, state)),
    };
  });
}
