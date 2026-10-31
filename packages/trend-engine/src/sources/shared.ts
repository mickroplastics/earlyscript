// Ported from Earlywindow src/engine/sources/shared.ts (engine.v0.02).
import { MAX_ITEM_BODY_CHARS, type Item } from "@earlyscript/editorial-contracts/item";
import { SourceFailure, type GetResponse } from "./http.ts";
import type { RobotsGate } from "./robots.ts";
export function plainText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (match, code: string) => {
      const n = code.toLowerCase().startsWith("x") ? parseInt(code.slice(1), 16) : Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    })
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/g,
      (_, entity: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[entity] ?? " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}
export function githubEntity(url: string | null): string[] {
  if (!url) return [];
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return [];
    const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
    return owner && repo
      ? [`github:${owner.toLowerCase()}/${repo.replace(/\.git$/, "").toLowerCase()}`]
      : [];
  } catch {
    return [];
  }
}
export function sortItems(items: Item[]): Item[] {
  return items.sort(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
  );
}
/** Body fields of an item: plain text cut to the corpus/1 maximum, with its full length. */
export function bodyFields(text: string) {
  return {
    body: text.slice(0, MAX_ITEM_BODY_CHARS),
    body_length: text.length,
    truncated: text.length > MAX_ITEM_BODY_CHARS,
  };
}
/** GitHub repositories named anywhere in free text, such as an abstract or a post. */
export function githubEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const [url] of text.matchAll(/https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/gi))
    for (const entity of githubEntity(url.replace(/\/\/www\./i, "//").replace(/\.+$/, "")))
      entities.add(entity);
  return [...entities].toSorted();
}
/** Failure notes joined once each; null when there are none. */
export function joinNotes(notes: ReadonlyArray<string | null>): string | null {
  return [...new Set(notes.filter((note): note is string => Boolean(note)))].join("; ") || null;
}
/** Asks robots.txt before each request; a refusal fails the request with the gate's reason. */
export function gatedGet(get: GetResponse, robots: RobotsGate): GetResponse {
  return async (url, headers) => {
    const refusal = await robots(url);
    if (refusal) throw new SourceFailure(refusal);
    return get(url, headers);
  };
}
