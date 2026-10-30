// @effect-diagnostics globalDate:off nodeBuiltinImport:off - plain async library with native fetch and UTC timestamps.
// Ported from Earlywindow src/engine/sources/hn.ts (engine.v0.02): Algolia stories, subdivided UTC windows.
import * as Schema from "effect/Schema";
import type { Item } from "@earlyscript/editorial-contracts/item";
import { HnSearch } from "@earlyscript/editorial-contracts/source";
import { DAY_MS, dayStart } from "../days.ts";
import { SourceFailure, type GetResponse } from "./http.ts";
import { githubEntity, plainText, sortItems } from "./shared.ts";
import type { DayResult } from "./adapter.ts";
const isSearch = Schema.is(HnSearch);

export function hnUrl(from: number, until: number): string {
  const params = new URLSearchParams({
    tags: "story",
    numericFilters: `created_at_i>=${from / 1000},created_at_i<${until / 1000}`,
    hitsPerPage: "1000",
    typoTolerance: "false",
    removeWordsIfNoResults: "none",
  });
  return `https://hn.algolia.com/api/v1/search_by_date?${params}`;
}

export async function collectHnDay(
  day: string,
  get: GetResponse,
  now = new Date().toISOString(),
): Promise<DayResult> {
  const start = dayStart(day);
  const items = new Map<string, Item>();
  const failures: { status: string; note: string }[] = [];
  let retrievedAt = now;
  let requests = 0;
  async function window(from: number, until: number): Promise<void> {
    try {
      if (++requests > 4096) throw new SourceFailure("Window subdivision limit reached");
      const response = await get(hnUrl(from, until));
      retrievedAt = response.observed_at;
      if (response.status !== 200) throw new SourceFailure(`HTTP ${response.status}`);
      if (!isSearch(response.body)) throw new SourceFailure("Invalid HN response");
      const body = response.body;
      const exhaustive = body.exhaustiveNbHits !== false && body.exhaustive?.nbHits !== false;
      // The spike partitions capped windows; continue to one second instead of stopping at one hour.
      if ((body.nbHits > body.hits.length || !exhaustive) && until - from > 1000) {
        const middle = Math.floor((from + until) / 2000) * 1000;
        await window(from, middle);
        await window(middle, until);
        return;
      }
      const ids = new Set<string>();
      for (const hit of body.hits) {
        const published = hit.created_at_i * 1000;
        if (published < from || published >= until) {
          failures.push({
            status: "partial",
            note: "HN returned an item outside its requested window",
          });
          continue;
        }
        ids.add(hit.objectID);
        const text = plainText(hit.story_text ?? "");
        const id = `itm_hn_${hit.objectID}`;
        if (!items.has(id))
          items.set(id, {
            id,
            source: "hn",
            permalink: `https://news.ycombinator.com/item?id=${hit.objectID}`,
            external_url: hit.url ?? null,
            published_at: new Date(published).toISOString(),
            author: hit.author,
            title: plainText(hit.title ?? ""),
            body: text.slice(0, 4000),
            body_length: text.length,
            truncated: text.length > 4000,
            retrieved_at: response.observed_at,
            entities: githubEntity(hit.url ?? null),
          });
      }
      if (!exhaustive || ids.size !== body.nbHits)
        failures.push({
          status: "partial",
          note: `HN window incomplete: ${ids.size}/${body.nbHits}, exhaustive=${exhaustive}`,
        });
    } catch (error) {
      if (!(error instanceof SourceFailure)) throw error;
      // corpus/1 coverage has no reason field: quota and size failures keep their reason in note.
      failures.push({ status: "unavailable", note: error.message });
    }
  }
  await window(start, start + DAY_MS);
  const status = failures.length ? (items.size ? "partial" : "unavailable") : "complete";
  return {
    items: sortItems([...items.values()]),
    coverage: {
      source: "hn",
      day,
      status,
      items: items.size,
      retrieved_at: retrievedAt,
      note: failures.length ? [...new Set(failures.map((f) => f.note))].join("; ") : null,
    },
  };
}
