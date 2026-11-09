// @effect-diagnostics nodeBuiltinImport:off - test fixture writer.
// The live corpus Gertrudis had on 9 Nov 2026 and the long corpus meant to fill it, in small:
// hn and github captured live since 3 Oct; huggingface, npm, wikipedia, rss and arxiv only since
// 3 Nov; the long corpus has 30 Aug to 31 Oct for all of them but arxiv, and rss only from 3 Oct.
import * as NodePath from "node:path";

import type { Item } from "@earlyscript/editorial-contracts/item";
import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { daysBetween } from "../days.ts";
import { item, syntheticItems, writeSyntheticCorpus } from "./syntheticCorpus.ts";

export const GERTRUDIS = {
  sourceFrom: "2026-08-30",
  sourceTo: "2026-11-01",
  rssFrom: "2026-10-03",
  liveFrom: "2026-10-03",
  liveTo: "2026-11-08",
  newFrom: "2026-11-03",
} as const;

const LATE_SOURCES = ["huggingface", "npm", "wikipedia", "rss"] as const satisfies Array<SourceId>;

/** One item a day for each source enabled late, so their imported days hold something. */
function lateItems(): Array<Item> {
  return LATE_SOURCES.flatMap((source) =>
    daysBetween(GERTRUDIS.sourceFrom, GERTRUDIS.liveTo).map((day) =>
      item(source, day, 7, `${source} release notes ${day}`, `${source}-bot`),
    ),
  );
}

const sorted = (items: ReadonlyArray<Item>) =>
  items.toSorted(
    (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
  );

export async function writeGertrudisCase(root: string) {
  const from = NodePath.join(root, "eval-largo", "corpus");
  const to = NodePath.join(root, "live");
  const all = sorted([...syntheticItems(), ...lateItems()]);
  await writeSyntheticCorpus(from, {
    fromDay: GERTRUDIS.sourceFrom,
    toDay: GERTRUDIS.sourceTo,
    extraSources: LATE_SOURCES,
    items: all,
    coverage: (row) => (row.source === "rss" && row.day < GERTRUDIS.rssFrom ? null : row),
  });
  await writeSyntheticCorpus(to, {
    fromDay: GERTRUDIS.liveFrom,
    toDay: GERTRUDIS.liveTo,
    extraSources: [...LATE_SOURCES, "arxiv"],
    items: all.filter((i) => i.published_at.slice(0, 10) >= GERTRUDIS.liveFrom),
    coverage: (row) =>
      row.source === "hn" || row.source === "github" || row.day >= GERTRUDIS.newFrom ? row : null,
  });
  return { from, to };
}
