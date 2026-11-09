// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - writes a synthetic v3 dataset for tests and --dry-run.
// A synthetic October for v3's evaluation, with the file layout of the real one: corpus/<source>/
// <day>.jsonl and coverage.jsonl, A's bags (bolsas/<day>.json) and lists (listas/<arm>/<day>.json),
// and B's judged cuts. Nothing in it comes from real data. Topics:
//   alpha: takes off on 10 Oct through two sources (hn and github);
//   beta:  takes off on 10 Oct on HN alone, through three authors with linked entities;
//   gamma: hn only with two linked authors (no corroboration);
//   delta: perennial (six items every week since September);
//   eps:   would take off on 10 Oct, but npm (60 % of its future items) is unavailable twice;
//   noise: 400 singletons in [10, 17 Oct) so that 6 items are far from 2 % of the window.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type CorpusItem,
  DAY_MS,
  dayOf,
  dayStart,
  inclusiveDays,
  type V3Bag,
  type V3List,
  type V3Topic,
} from "./v3-data.ts";
import type { JudgedCut } from "./v3-metrics.ts";

const at = (day: string, hour = 12) => new Date(dayStart(day) + hour * 3_600_000).toISOString();

interface SynItem extends CorpusItem {
  readonly topic: string;
}

export function syntheticItems(): Array<SynItem> {
  const out: Array<SynItem> = [];
  let n = 0;
  const add = (
    topic: string,
    source: string,
    day: string,
    opts: { url?: string | undefined; author?: string; entities?: Array<string> } = {},
  ) => {
    n++;
    out.push({
      id: `itm_${source}_${n}`,
      topic,
      source,
      published_at: at(day),
      external_url: opts.url ?? `https://example.com/${topic}/${n}`,
      permalink: `https://${source}.example/item/${n}`,
      author: opts.author ?? `author${n}`,
      entities: opts.entities ?? [],
    });
  };
  // alpha: 1 in W0 of 10 Oct, then 4 hn + 2 github in [10, 17).
  add("alpha", "hn", "2026-10-05");
  for (const d of ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"]) add("alpha", "hn", d);
  add("alpha", "github", "2026-10-14", { entities: ["github:alpha/alpha"] });
  add("alpha", "github", "2026-10-15", { entities: ["github:alpha/alpha2"] });
  // beta: 1 in W0, then 6 hn by 3 authors with links (two share a URL: 5 units + 1 more).
  add("beta", "hn", "2026-10-06");
  const authors = ["ann", "bob", "cid", "ann", "bob", "cid", "ann"];
  authors.forEach((author, k) =>
    add("beta", "hn", inclusiveDays("2026-10-10", "2026-10-16")[k]!, {
      author,
      entities: [`github:beta/repo${k}`],
      url:
        k === 6
          ? "https://example.com/beta/shared"
          : k === 5
            ? "https://www.example.com/beta/shared/"
            : undefined,
    }),
  );
  // gamma: 1 in W0, 6 hn in [10, 17) by two authors.
  add("gamma", "hn", "2026-10-07");
  for (let k = 0; k < 6; k++)
    add("gamma", "hn", inclusiveDays("2026-10-10", "2026-10-15")[k]!, {
      author: k % 2 === 0 ? "x" : "y",
    });
  // delta: perennial, 6 a week since 30 Aug.
  for (const d of inclusiveDays("2026-08-30", "2026-10-30"))
    if (dayStart(d) % (7 * DAY_MS) < 6 * DAY_MS) add("delta", "hn", d);
  // eps: 1 in W0; future 2 hn + 4 npm (npm unavailable on 11 and 12 Oct).
  add("eps", "hn", "2026-10-08");
  add("eps", "hn", "2026-10-10");
  add("eps", "hn", "2026-10-11");
  for (const d of ["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]) add("eps", "npm", d);
  // noise.
  for (let k = 0; k < 400; k++)
    add(`noise${k}`, "hn", inclusiveDays("2026-10-10", "2026-10-16")[k % 7]!);
  // A November item: never read.
  add("alpha", "hn", "2026-11-02");
  return out;
}

export const SYNTHETIC_ARMS = ["V1", "V2", "V3", "V4", "R4", "R2", "R5", "v1", "v2"] as const;

const topicsAt = (items: ReadonlyArray<SynItem>, day: string): Array<V3Topic> => {
  const t = dayStart(day);
  const byTopic = new Map<string, Array<string>>();
  for (const it of items) {
    if (Date.parse(it.published_at) >= t) continue;
    const list = byTopic.get(it.topic) ?? [];
    list.push(it.id);
    byTopic.set(it.topic, list);
  }
  return [...byTopic]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([topic_id, item_ids]) => ({
      topic_id,
      item_ids,
      include_score: topic_id === "beta" ? 0.3 : 0.7,
    }));
};

/** Writes the synthetic dataset under `dir` and returns its paths. */
export function writeSyntheticV3(dir: string) {
  const items = syntheticItems();
  const corpus = NodePath.join(dir, "corpus");
  const bySourceDay = new Map<string, Array<SynItem>>();
  for (const it of items) {
    const key = `${it.source}/${it.published_at.slice(0, 10)}`;
    bySourceDay.set(key, [...(bySourceDay.get(key) ?? []), it]);
  }
  for (const [key, list] of bySourceDay) {
    const path = NodePath.join(corpus, `${key}.jsonl`);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(
      path,
      list.map(({ topic: _t, ...rest }) => JSON.stringify(rest)).join("\n") + "\n",
    );
  }
  const coverage: Array<string> = [];
  for (const source of ["hn", "github", "huggingface", "npm", "rss"])
    for (const day of inclusiveDays(source === "rss" ? "2026-10-03" : "2026-08-30", "2026-11-03"))
      coverage.push(
        JSON.stringify({
          source,
          day,
          status:
            source === "npm" && (day === "2026-10-11" || day === "2026-10-12")
              ? "unavailable"
              : source === "hn"
                ? "complete"
                : "partial",
        }),
      );
  NodeFS.writeFileSync(NodePath.join(corpus, "coverage.jsonl"), coverage.join("\n") + "\n");
  const bags = NodePath.join(dir, "bolsas");
  NodeFS.mkdirSync(bags, { recursive: true });
  for (const day of inclusiveDays("2026-10-04", "2026-10-31")) {
    const bag: V3Bag = { cutoff: day, topics: topicsAt(items, day) };
    NodeFS.writeFileSync(NodePath.join(bags, `${day}.json`), JSON.stringify(bag));
  }
  const lists = NodePath.join(dir, "listas");
  const listed: Record<string, Record<string, Array<string>>> = {
    V1: { "2026-10-08": ["alpha", "gamma"], "2026-10-12": ["beta", "alpha"] },
    V2: { "2026-10-12": ["alpha"] },
    R2: { "2026-10-12": ["alpha", "delta"] },
  };
  for (const arm of SYNTHETIC_ARMS)
    for (const day of inclusiveDays("2026-10-04", "2026-10-30")) {
      const topics = topicsAt(items, day);
      const chosen = (listed[arm]?.[day] ?? [])
        .map((id) => topics.find((t) => t.topic_id === id)!)
        .filter(Boolean);
      const padded =
        arm === "V1" || arm === "V2"
          ? [
              ...chosen,
              ...topics.filter((t) => t.topic_id === "delta"),
              ...topics.filter((t) => t.topic_id.startsWith("noise")).slice(0, 8),
            ]
          : chosen;
      const list: V3List = {
        cutoff: day,
        arm,
        moving: padded.slice(0, 10),
        background: [],
        discards: { exclude: 1 },
      };
      const path = NodePath.join(lists, arm, `${day}.json`);
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
      NodeFS.writeFileSync(path, JSON.stringify(list));
    }
  const judged: Array<JudgedCut> = [];
  for (const arm of ["V1", "V2", "R4"])
    for (const [k, day] of inclusiveDays("2026-10-04", "2026-10-24").entries())
      judged.push({
        arm,
        cutoff: day,
        emitted: 5,
        cards: Array.from({ length: 5 }, (_, c) => ({
          topic_id: `${arm}-${c}`,
          item_ids: [`fam${(k + c) % 9}`],
          utility_opus: arm === "R4" ? 3 : 3 + ((k + c) % 2),
          utility_sol: arm === "R4" ? 3 : 4,
        })),
      });
  const judges = NodePath.join(dir, "jueces.json");
  NodeFS.writeFileSync(judges, JSON.stringify({ cuts: judged }));
  return {
    corpus,
    coverage: NodePath.join(corpus, "coverage.jsonl"),
    bags,
    lists,
    judges,
    lastDay: dayOf(dayStart("2026-10-31")),
  };
}
