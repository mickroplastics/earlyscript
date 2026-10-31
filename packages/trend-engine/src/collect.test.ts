// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem tests for the plain engine.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { CoverageRecord, SourceDescriptor } from "@earlyscript/editorial-contracts/source";
import { collectCorpus } from "./collect.ts";
import { readCorpus } from "./corpus.ts";
import { fixtureSources, SOURCES, type SourceAdapter } from "./sources/index.ts";

const day = "2026-10-30";
const window = { from: day, to: "2026-10-31" };

/** A synthetic item of the day; `n` is its rank key and id. */
function item(source: Item["source"], n: number): Item {
  return {
    id: `itm_test_${n}`,
    source,
    permalink: `https://example.com/${n}`,
    external_url: null,
    published_at: `${day}T${String(n % 24).padStart(2, "0")}:00:00.000Z`,
    author: `a${n}`,
    title: `Item ${n}`,
    body: "",
    body_length: 0,
    truncated: false,
    retrieved_at: "2026-10-31T04:00:00.000Z",
    entities: [],
  };
}
/** An adapter that answers one capture per call, as a live source would on each collect. */
function scripted(
  descriptor: SourceDescriptor,
  captures: Array<{ ids: ReadonlyArray<number>; status: CoverageRecord["status"] }>,
): SourceAdapter {
  return {
    descriptor,
    collectDay: async () => {
      const { ids, status } = captures.shift()!;
      return {
        items: ids.map((n) => item(descriptor.id, n)),
        coverage: {
          source: descriptor.id,
          day,
          status,
          items: ids.length,
          retrieved_at: "2026-10-31T04:00:00.000Z",
          note: null,
        },
      };
    },
  };
}
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
async function dayIds(root: string, source: string): Promise<Set<number>> {
  const text = await NodeFSP.readFile(NodePath.join(root, source, `${day}.jsonl`), "utf8");
  return new Set(
    text
      .trim()
      .split("\n")
      .map((line) => Number((JSON.parse(line) as Item).id.slice(9))),
  );
}

describe("collectCorpus with sample and census sources", () => {
  it("replaces a recaptured sample day, keeps the old selection in history and unions a census", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "collect-sample-"));
    try {
      // Sol's scenario: a top 500 of 600 whose ranking changes between captures.
      const sample = scripted(SOURCES.huggingface, [
        { ids: range(0, 500), status: "partial" },
        { ids: range(100, 600), status: "partial" },
        { ids: [], status: "unavailable" },
      ]);
      const census = scripted(SOURCES.hn, [
        { ids: range(0, 3), status: "partial" },
        { ids: range(3, 5), status: "partial" },
        { ids: [], status: "partial" },
      ]);
      const collect = () => collectCorpus({ dir: root, ...window, adapters: [sample, census] });

      await collect();
      const [second] = await collect();
      expect(second).toMatchObject({ source: "huggingface", status: "partial", items: 500 });
      const current = await dayIds(root, "huggingface");
      expect(current).toEqual(new Set(range(100, 600)));
      // The 100 that left the selection live only in history/.
      const archived = await Promise.all(
        (await NodeFSP.readdir(NodePath.join(root, "history"))).map((file) =>
          NodeFSP.readFile(NodePath.join(root, "history", file), "utf8"),
        ),
      );
      expect(archived.some((text) => text.includes('"id":"itm_test_0"'))).toBe(true);
      expect(await dayIds(root, "hn")).toEqual(new Set(range(0, 5)));

      // A sample capture that reached nothing keeps the current selection.
      const [down] = await collect();
      expect(down).toMatchObject({ status: "partial", items: 500 });
      expect(await dayIds(root, "huggingface")).toEqual(current);
      expect(
        (
          await readCorpus({
            dir: root,
            untilDay: window.to,
            adapters: fixtureSources(root, ["huggingface", "hn"]),
          })
        ).verified,
      ).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
