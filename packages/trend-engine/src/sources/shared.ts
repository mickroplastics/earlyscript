// Ported from Earlywindow src/engine/sources/shared.ts (engine.v0.02).
import type { Item } from "@earlyscript/editorial-contracts/item";
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
