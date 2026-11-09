// @effect-diagnostics nodeBuiltinImport:off globalDate:off - oracle p4 on synthetic topics.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  type CorpusItem,
  type CoverageIndex,
  dayStart,
  inclusiveDays,
  NovemberReadError,
  readGuarded,
  readLog,
} from "./v3-data.ts";
import { evaluateV3 } from "./v3-eval.ts";
import {
  bagIndex,
  canonicalUrl,
  comparableSources,
  destinationOf,
  findTakeoffs,
  itemIndex,
  p4Context,
  p4Label,
} from "./v3-oracle.ts";
import { writeSyntheticV3 } from "./v3-synthetic.ts";

const T = "2026-10-10";
const at = (day: string) => new Date(dayStart(day) + 12 * 3_600_000).toISOString();
let k = 0;
const item = (source: string, day: string, o: Partial<CorpusItem> = {}): CorpusItem => ({
  id: `i${++k}`,
  source,
  published_at: at(day),
  external_url: `https://example.com/${k}`,
  permalink: `https://${source}.example/${k}`,
  author: `a${k}`,
  entities: [],
  ...o,
});

const SOURCES = ["hn", "github", "huggingface", "npm"];
const coverage = (unavailable: Record<string, Array<string>> = {}): CoverageIndex =>
  new Map(
    SOURCES.map((s) => [
      s,
      new Map(
        inclusiveDays("2026-08-30", "2026-10-31").map((d) => [
          d,
          unavailable[s]?.includes(d) ? "unavailable" : "complete",
        ]),
      ),
    ]),
  );

/** One cut: the topics, 400 filler singletons so 6 items are below 2 %, and their label. */
function labelOf(members: Array<CorpusItem>, cov: CoverageIndex = coverage()) {
  const filler = Array.from({ length: 400 }, (_, j) =>
    item("hn", inclusiveDays(T, "2026-10-16")[j % 7]!),
  );
  const items = itemIndex([...members, ...filler]);
  const topic = { topic_id: "s", item_ids: members.map((m) => m.id) };
  const bag = {
    cutoff: "2026-10-17",
    topics: [topic, ...filler.map((f) => ({ topic_id: f.id, item_ids: [f.id] }))],
  };
  return p4Label(topic, p4Context(T, cov, bag, items), items);
}

const days = (n: number, from = T) => inclusiveDays(from, "2026-10-16").slice(0, n);

describe("oracle p4 on a synthetic cut", () => {
  it("takes off through two comparable sources", () => {
    const l = labelOf([
      item("hn", "2026-10-05"),
      ...days(4).map((d) => item("hn", d)),
      item("github", "2026-10-15"),
    ]);
    expect(l.label).toBe("despegue");
    expect(l.corroboration).toBe("fuentes");
    expect(l.n_future).toBe(5);
  });

  it("takes off on one source through three authors with linked entities", () => {
    const authors = ["x", "y", "z", "x", "y"];
    const l = labelOf([
      item("hn", "2026-10-05"),
      ...days(5).map((d, j) => item("hn", d, { author: authors[j]! })),
    ]);
    expect(l.label).toBe("despegue");
    expect(l.corroboration).toBe("autores");
  });

  it("does not corroborate with two authors, or three without a linked entity", () => {
    const two = labelOf(
      days(6)
        .map((d, j) => item("hn", d, { author: j % 2 ? "x" : "y" }))
        .concat(item("hn", "2026-10-05")),
    );
    expect(two.label).toBe("no");
    expect(two.reasons).toContain("sin_corroboracion");
    const unlinked = labelOf(
      days(6)
        .map((d, j) => item("hn", d, { author: `u${j % 3}`, external_url: null, permalink: null }))
        .concat(item("hn", "2026-10-05")),
    );
    expect(unlinked.reasons).toContain("sin_corroboracion");
    const entity = labelOf(
      days(6)
        .map((d, j) =>
          item("hn", d, { author: `u${j % 3}`, external_url: null, entities: ["arxiv:2610.1"] }),
        )
        .concat(item("hn", "2026-10-05")),
    );
    expect(entity.label).toBe("despegue");
  });

  it("counts one unique URL once, across sources", () => {
    const shared = "https://www.Example.com/same/?utm_source=x#top";
    const l = labelOf([
      item("hn", "2026-10-05"),
      ...days(4).map((d) => item("hn", d, { external_url: shared })),
      item("github", "2026-10-15"),
    ]);
    expect(l.n_future).toBe(2);
    expect(l.reasons).toContain("pocos");
    expect(canonicalUrl(shared)).toBe("example.com/same");
  });

  it("refuses falling, too slow, perennial, non-existing and generic topics", () => {
    const future = days(6)
      .map((d) => item("hn", d))
      .concat(item("github", "2026-10-16"));
    expect(labelOf([...future, ...[1, 2].map(() => item("hn", "2026-09-30"))]).reasons).toContain(
      "cae",
    );
    expect(
      labelOf([...future, ...[1, 2, 3, 4, 5].map(() => item("hn", "2026-10-05"))]).reasons,
    ).toContain("razon");
    const weekly = ["2026-09-08", "2026-09-15", "2026-09-22"].flatMap((d) =>
      [0, 1, 2, 3, 4].map(() => item("hn", d)),
    );
    const perennial = labelOf([...future, item("hn", "2026-10-05"), ...weekly]);
    expect(perennial.perennial).toBe(true);
    expect(perennial.label).toBe("no");
    expect(labelOf(future).reasons).toContain("no_existe");
    const big = Array.from({ length: 20 }, (_, j) => item("hn", days(7)[j % 7]!)).concat(
      item("github", T),
      item("hn", "2026-10-09"),
    );
    expect(labelOf(big).generic).toBe(true);
  });

  it("drops a source with two unavailable future days, and is unknown at 30 % or more there", () => {
    const members = [
      item("hn", "2026-10-05"),
      ...days(3).map((d) => item("hn", d)),
      ...days(3, "2026-10-13").map((d) => item("npm", d)),
    ];
    const gap = coverage({ npm: ["2026-10-11", "2026-10-12"] });
    expect(labelOf(members, gap).label).toBe("desconocido");
    expect(labelOf(members, gap).reasons).toContain("fuente_caida");
    const one = coverage({ npm: ["2026-10-11"] });
    expect(labelOf(members, one).label).toBe("despegue");
  });

  it("marks a topic incomplete when '?' rows hold 30 % of W0..W2", () => {
    const members = [
      item("npm", "2026-10-05"),
      item("hn", "2026-09-28"),
      ...days(5).map((d) => item("hn", d)),
      item("github", T),
    ];
    const l = labelOf(members, coverage({ npm: ["2026-10-04", "2026-10-06"] }));
    expect(l.label).toBe("desconocido");
    expect(l.reasons).toContain("incompleto");
  });
});

describe("comparable sources and matching", () => {
  it("needs the 35 days of [t−35, t) and at most 3 unavailable days", () => {
    const cov = coverage({
      github: ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"],
      npm: ["2026-09-10", "2026-09-11", "2026-09-12"],
    });
    cov.set("rss", new Map(inclusiveDays("2026-10-03", "2026-10-31").map((d) => [d, "partial"])));
    expect(comparableSources(cov, "2026-10-04")).toEqual(["hn", "huggingface", "npm"]);
    expect(comparableSources(coverage(), "2026-10-04")).toEqual(SOURCES);
    expect(comparableSources(coverage(), "2026-10-03")).toEqual([]);
  });

  it("matches a list topic by ceil(|c|/2) shared items, ties to the smaller id", () => {
    const xs = ["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => item("hn", d));
    const items = itemIndex(xs);
    const bag = bagIndex({
      cutoff: "2026-10-12",
      topics: [
        { topic_id: "b", item_ids: [xs[0]!.id] },
        { topic_id: "a", item_ids: [xs[1]!.id] },
        { topic_id: "c", item_ids: [xs[2]!.id] },
      ],
    });
    expect(
      destinationOf({ topic_id: "c1", item_ids: xs.map((x) => x.id) }, "2026-10-05", bag, items),
    ).toBeNull();
    expect(
      destinationOf({ topic_id: "c2", item_ids: [xs[0]!.id, xs[1]!.id] }, "2026-10-05", bag, items),
    ).toEqual({ topic_id: "a", shared: 1, own: 2 });
    expect(
      destinationOf({ topic_id: "c3", item_ids: [xs[2]!.id] }, "2026-10-03", bag, items),
    ).toBeNull();
  });
});

describe("takeoffs on the synthetic October", () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v3-oracle-"));
  afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  const paths = writeSyntheticV3(dir);

  it("finds alpha and beta once each, eps unknown, and reads nothing of November", () => {
    readLog.length = 0;
    const result = evaluateV3(paths);
    expect(result.takeoffs.map((t) => [t.T, t.topic_id, t.label.corroboration])).toEqual([
      ["2026-10-08", "alpha", "fuentes"],
      ["2026-10-08", "beta", "autores"],
    ]);
    expect(result.unknown.some((u) => u.topic_id === "eps")).toBe(true);
    expect(readLog.length).toBeGreaterThan(10);
    expect(readLog.filter((p) => p.includes("2026-11-"))).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(paths.corpus, "hn", "2026-11-02.jsonl"))).toBe(true);
  });

  it("refuses to open a November path", () => {
    expect(() => readGuarded(NodePath.join(paths.corpus, "hn", "2026-11-02.jsonl"))).toThrow(
      NovemberReadError,
    );
    expect(() => readGuarded("/x/listas/V1/2026-11-01.json")).toThrow(/after 2026-10-31/);
  });

  it("counts a topic once even when it qualifies on later cutoffs", () => {
    const fixture = NodeFS.mkdtempSync(NodePath.join(dir, "again-"));
    const p = writeSyntheticV3(fixture);
    const once = evaluateV3(p, inclusiveDays("2026-10-07", "2026-10-09"));
    expect(once.takeoffs.filter((t) => t.topic_id === "alpha")).toHaveLength(1);
    void findTakeoffs;
  });
});
