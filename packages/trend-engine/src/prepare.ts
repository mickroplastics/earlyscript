// Steps 1 to 3 of Earlywindow's method (src/engine/run.ts, prepare): text, English
// filter and duplicate URLs, unchanged so runs stay comparable with engine.v0.02.
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { dayOf } from "./days.ts";

export type ExclusionReason = "not_english" | "duplicate_url";

export interface PreparedItem extends Item {
  readonly publishedMs: number;
  readonly day: string;
  /** What is embedded: title, then up to max_body_chars of the cleaned body. */
  readonly text: string;
  readonly cleanBody: string;
  excluded: ExclusionReason | null;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
  "&#x2F;": "/",
  "&nbsp;": " ",
};

const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#x27|#39|#x2F|nbsp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/\s+/g, " ")
    .trim();

function asciiLetterRatio(text: string): number {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  return letters === 0 ? 0 : (text.match(/[A-Za-z]/g)?.length ?? 0) / letters;
}

export function prepare(
  items: ReadonlyArray<Item>,
  cfg: EngineConfig["text"],
): Array<PreparedItem> {
  const prepared = items
    .map((item): PreparedItem => {
      const cleanBody = stripHtml(item.body);
      const text =
        cleanBody === ""
          ? item.title
          : `${item.title}\n\n${cleanBody.slice(0, cfg.max_body_chars)}`;
      const publishedMs = Date.parse(item.published_at);
      if (Number.isNaN(publishedMs)) throw new Error(`item ${item.id} has an invalid published_at`);
      const excluded =
        asciiLetterRatio(`${item.title} ${cleanBody}`) < cfg.min_ascii_letter_ratio
          ? "not_english"
          : null;
      return { ...item, publishedMs, day: dayOf(publishedMs), text, cleanBody, excluded };
    })
    .toSorted((a, b) => a.publishedMs - b.publishedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seenUrls = new Set<string>();
  for (const item of prepared) {
    if (item.excluded || item.external_url === null) continue;
    if (seenUrls.has(item.external_url)) item.excluded = "duplicate_url";
    else seenUrls.add(item.external_url);
  }
  return prepared;
}
