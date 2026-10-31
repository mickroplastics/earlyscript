// Ported from Earlywindow src/engine/sources/shared.ts (engine.v0.02).
import { MAX_ITEM_BODY_CHARS, type Item } from "@earlyscript/editorial-contracts/item";
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
/**
 * Markdown (model cards, READMEs) to plain text: front matter, fenced code, images and
 * table rules are dropped; links keep their text. Not a parser: enough for embeddings.
 */
export function markdownText(value: string): string {
  return plainText(
    value
      .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/, "")
      .replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2[^\n]*|(?![\s\S]))/g, "$1 ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*\|?\s*:?-{3,}.*$/gm, " ")
      .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
      .replace(/[*_`|]+/g, " "),
  );
}
/** Body fields of an Item: plain text cut to the corpus/1 limit. */
export function itemBody(text: string): { body: string; body_length: number; truncated: boolean } {
  return {
    body: text.slice(0, MAX_ITEM_BODY_CHARS),
    body_length: text.length,
    truncated: text.length > MAX_ITEM_BODY_CHARS,
  };
}
