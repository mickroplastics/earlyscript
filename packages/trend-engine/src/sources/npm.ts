// @effect-diagnostics globalDate:off - plain async library with UTC timestamps.
// Ported from Earlywindow src/engine/sources/npm.ts: registry keyword search, releases of the day.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { bodyFields, gatedGet, githubEntity, joinNotes, plainText, sortItems } from "./shared.ts";
import type { RobotsGate } from "./robots.ts";
import type { DayResult } from "./adapter.ts";

export const NPM_QUERIES = [
  "keywords:ai",
  "keywords:llm",
  "keywords:agent",
  "keywords:mcp",
  "keywords:cli",
] as const;
const PAGE = 250;
/** The registry serves results 0..5249; a larger offset silently returns the first page again. */
const MAX_FROM = 5000;
export const NPM_MAX_ITEMS = 100;
/**
 * Known-package rule (Earlywindow M28): a release enters its day only if the package has at
 * least this many present-day weekly downloads. Keyword search returns thousands of packages
 * with a handful of downloads (mirrors and bots); 500 a week keeps released tools someone uses.
 */
export const NPM_MIN_WEEKLY_DOWNLOADS = 500;
const SELECTION_NOTE =
  "Registry search is ranked by relevance, not date; packages whose latest version moved past this day are missing; weekly downloads are present-day";

const isSearch = Schema.is(
  Schema.Struct({
    total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    objects: Schema.Array(Schema.Unknown),
  }),
);
const isObject = Schema.is(
  Schema.Struct({
    package: Schema.Struct({
      name: Schema.NonEmptyString,
      version: Schema.NonEmptyString,
      date: Schema.String,
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      publisher: Schema.optionalKey(
        Schema.Struct({
          username: Schema.optionalKey(Schema.String),
          trustedPublisher: Schema.optionalKey(Schema.Unknown),
        }),
      ),
      maintainers: Schema.optionalKey(Schema.Array(Schema.Struct({ username: Schema.String }))),
      links: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    downloads: Schema.optionalKey(
      Schema.Struct({ weekly: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
    ),
  }),
);

/** Registry links are free-form: a homepage may be "" and a repository "git@github.com:owner/repo.git". */
function link(value: unknown): string | null {
  return typeof value === "string" && value
    ? value
        .replace(/^git\+/, "")
        .replace(/^(ssh:\/\/)?git@github\.com[:/]/, "https://github.com/")
        .replace(/^git:\/\//, "https://")
        .replace(/\.git$/, "")
    : null;
}

export function npmSearchUrl(text: string, from: number): string {
  const params = new URLSearchParams({ text, size: String(PAGE), from: String(from) });
  return `https://registry.npmjs.org/-/v1/search?${params}`;
}

export async function collectNpmDay(
  day: string,
  ungated: GetResponse,
  robots: RobotsGate,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const get = gatedGet(ungated, robots);
  const start = dayStart(day);
  const candidates = new Map<string, { item: Item; weekly: number }>();
  const failures: Array<string> = [];
  const counts: Array<string> = [];
  let retrievedAt = now;
  let invalid = 0;
  const below = new Set<string>();
  for (const query of NPM_QUERIES) {
    let received = 0;
    let total = 0;
    try {
      for (let from = 0; from <= MAX_FROM; from += PAGE) {
        const response = await get(npmSearchUrl(query, from));
        retrievedAt = response.observed_at;
        if (response.status !== 200) throw new SourceFailure(`${query} HTTP ${response.status}`);
        if (!isSearch(response.body))
          throw new SourceFailure(`${query} invalid npm search response`);
        total = response.body.total;
        received += response.body.objects.length;
        for (const object of response.body.objects) {
          if (!isObject(object)) {
            invalid++;
            continue;
          }
          const { package: pkg, downloads } = object;
          const published = Date.parse(pkg.date);
          if (!Number.isFinite(published) || published < start || published >= start + DAY_MS)
            continue;
          const weekly = downloads?.weekly ?? 0;
          if (weekly < NPM_MIN_WEEKLY_DOWNLOADS) {
            below.add(pkg.name);
            continue;
          }
          const description = plainText(pkg.description ?? "");
          const repository = link(pkg.links?.repository);
          candidates.set(pkg.name, {
            weekly,
            item: {
              id: `itm_npm_${pkg.name}@${pkg.version}`,
              source: "npm",
              permalink: `https://www.npmjs.com/package/${pkg.name}`,
              external_url: repository ?? link(pkg.links?.homepage),
              published_at: new Date(published).toISOString(),
              // CI releases publish as "GitHub Actions"; the first maintainer keeps authors countable.
              author:
                (pkg.publisher?.trustedPublisher
                  ? pkg.maintainers?.[0]?.username
                  : pkg.publisher?.username) ?? null,
              title: `${pkg.name} ${pkg.version}`,
              ...bodyFields(
                [description, `weekly downloads: ${weekly}`].filter(Boolean).join("\n"),
              ),
              retrieved_at: response.observed_at,
              entities: githubEntity(repository),
            },
          });
        }
        if (response.body.objects.length < PAGE || from + PAGE >= total) break;
      }
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      failures.push(error.message);
    }
    counts.push(`${query} total=${total} received=${received}`);
  }
  const kept = [...candidates.values()]
    .toSorted((a, b) => b.weekly - a.weekly || a.item.id.localeCompare(b.item.id))
    .slice(0, NPM_MAX_ITEMS);
  return {
    items: sortItems(kept.map((candidate) => candidate.item)),
    coverage: {
      source: "npm",
      day,
      // Present-day downloads and relevance ranking make every npm day a sample: never complete.
      status: failures.length && !kept.length ? "unavailable" : "partial",
      items: kept.length,
      retrieved_at: retrievedAt,
      note: joinNotes([
        SELECTION_NOTE,
        ...counts,
        `released on day with >=${NPM_MIN_WEEKLY_DOWNLOADS} weekly downloads=${candidates.size}, below=${below.size}, kept=${kept.length} (cap ${NPM_MAX_ITEMS}), invalid rows skipped=${invalid}`,
        ...failures,
      ]),
    },
  };
}
