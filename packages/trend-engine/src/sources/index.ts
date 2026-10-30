import type { SourceDescriptor, SourceId } from "@earlyscript/editorial-contracts/source";

import type { SourceAdapter } from "./adapter.ts";
import { createHttpClient, type HttpOptions } from "./http.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";

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
};

export const isSampleSource = (id: SourceId): boolean => SOURCES[id].coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, SOURCES[id]));

export type { DayResult, SourceAdapter } from "./adapter.ts";

export { collectHnDay } from "./hn.ts";
export { collectGithubDay } from "./github.ts";

export function liveSources(
  ids: ReadonlyArray<SourceId>,
  options: HttpOptions = {},
): Array<SourceAdapter> {
  return ids.map((id) => ({
    descriptor: SOURCES[id],
    collectDay: (day) =>
      (id === "hn" ? collectHnDay : collectGithubDay)(day, createHttpClient(id, options)),
  }));
}
