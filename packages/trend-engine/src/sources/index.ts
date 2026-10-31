import type { SourceDescriptor, SourceId } from "@earlyscript/editorial-contracts/source";

import type { DayResult, SourceAdapter } from "./adapter.ts";
import { createHttpClient, type GetResponse, type HttpOptions } from "./http.ts";
import { robotsGate, type RobotsGate, type RobotsRule } from "./robots.ts";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay } from "./github.ts";
import { HF_SELECTION, huggingfaceCollector } from "./huggingface.ts";
import { DEVTO_SELECTION, devtoCollector } from "./devto.ts";

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
    coverage_policy: "census",
  },
};

type Collector = (
  day: string,
  get: GetResponse,
  robots: RobotsGate,
  getText: GetResponse,
) => Promise<DayResult>;
/** A fresh collector per adapter: listings walked once are kept between that adapter's days. */
const COLLECTORS: Readonly<Record<SourceId, () => Collector>> = {
  hn: () => (day, get) => collectHnDay(day, get),
  github: () => (day, get) => collectGithubDay(day, get),
  huggingface: huggingfaceCollector,
  devto: devtoCollector,
};

export const isSampleSource = (id: SourceId): boolean => SOURCES[id].coverage_policy === "sample";

export const fixtureSources = (corpusDir: string, ids: ReadonlyArray<SourceId>) =>
  ids.map((id) => fixtureAdapter(corpusDir, SOURCES[id]));

export type { DayResult, SourceAdapter } from "./adapter.ts";

export { collectHnDay } from "./hn.ts";
export { collectGithubDay } from "./github.ts";
export { huggingfaceCollector } from "./huggingface.ts";
export { devtoCollector } from "./devto.ts";

export function liveSources(
  ids: ReadonlyArray<SourceId>,
  options: HttpOptions = {},
): Array<SourceAdapter> {
  return ids.map((id) => {
    const state = { nextStart: 0, blockedUntil: 0 };
    const rules = new Map<string, ReadonlyArray<RobotsRule>>();
    const collect = COLLECTORS[id]();
    return {
      descriptor: SOURCES[id],
      collectDay: (day) => {
        // robots.txt and model cards are text, read through the same paced client state.
        const text = createHttpClient(id, { ...options, text: true }, state);
        return collect(
          day,
          createHttpClient(id, options, state),
          robotsGate(() => text, rules),
          text,
        );
      },
    };
  });
}
