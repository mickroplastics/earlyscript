// @effect-diagnostics globalDate:off nodeBuiltinImport:off - plain async library with native fetch and UTC timestamps.
// Ported from Earlywindow src/engine/sources/github.ts (engine.v0.02); discovery is always a sample.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { GithubSearch } from "@earlyscript/editorial-contracts/source";
import { DAY_MS, dayStart, dayOf } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { githubEntity, plainText, sortItems } from "./shared.ts";
import type { DayResult } from "./adapter.ts";
const isSearch = Schema.is(GithubSearch);

const SELECTION_NOTE =
  "Discovery uses present-day stars >=20 and present-day descriptions; not a historical activity census";

export function githubSearchUrl(day: string): string {
  const lower = dayOf(dayStart(day) - 7 * DAY_MS);
  const params = new URLSearchParams({
    q: `created:${lower}..${day} stars:>=20 fork:false`,
    sort: "stars",
    order: "desc",
    per_page: "100",
    page: "1",
  });
  return `https://api.github.com/search/repositories?${params}`;
}
export async function collectGithubDay(
  day: string,
  get: GetResponse,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const start = dayStart(day);
  let retrievedAt = now;
  try {
    const response = await get(githubSearchUrl(day));
    retrievedAt = response.observed_at;
    if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
    if (!isSearch(response.body)) throw new SourceFailure("Invalid GitHub search response");
    const body = response.body;
    const items = new Map<string, Item>();
    let invalid = false;
    for (const repo of body.items) {
      const created = Date.parse(repo.created_at);
      if (!Number.isFinite(created) || created < start - 7 * DAY_MS || created >= start + DAY_MS) {
        invalid = true;
        continue;
      }
      if (created < start || created >= start + DAY_MS) continue;
      const text = plainText(repo.description ?? "");
      const id = `itm_gh_${repo.id}`;
      if (!items.has(id))
        items.set(id, {
          id,
          source: "github",
          permalink: repo.html_url,
          external_url: repo.html_url,
          published_at: new Date(created).toISOString(),
          author: repo.owner.login,
          title: repo.full_name,
          body: text.slice(0, 4000),
          body_length: text.length,
          truncated: text.length > 4000,
          retrieved_at: retrievedAt,
          entities: githubEntity(repo.html_url),
        });
    }

    return {
      items: sortItems([...items.values()]),
      coverage: {
        source: "github",
        day,
        status: "partial",
        items: items.size,
        retrieved_at: retrievedAt,
        note: `${SELECTION_NOTE}; query matches=${body.total_count}, received=${body.items.length}, invalid=${invalid}, incomplete_results=${body.incomplete_results}`,
      },
    };
  } catch (error) {
    if (!(error instanceof SourceFailure)) throw error;
    return {
      items: [],
      coverage: {
        source: "github",
        day,
        status: "unavailable",
        items: 0,
        retrieved_at: retrievedAt,
        note: `${SELECTION_NOTE}; no verified zero: ${error.message}`,
      },
    };
  }
}
