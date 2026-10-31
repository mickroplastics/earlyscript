// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem tests for the plain engine.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { SourceId } from "@earlyscript/editorial-contracts/source";
import { collectCorpus } from "./collect.ts";
import { hashCorpus, readCorpus } from "./corpus.ts";
import { purgeCorpus } from "./purge.ts";
import { fixtureSources, SOURCES, type SourceAdapter } from "./sources/index.ts";

const observed = "2026-10-31T03:00:00.000Z";

function post(did: string, handle: string, rkey: string, at: string): Item {
  const text = `A post about llm tools by ${handle}`;
  return {
    id: `itm_bsky_${did.replace(/^did:/, "").replace(/[^A-Za-z0-9]/g, "_")}_${rkey}`,
    source: "bluesky",
    permalink: `https://bsky.app/profile/${did}/post/${rkey}`,
    external_url: null,
    published_at: at,
    author: handle,
    title: "",
    body: text,
    body_length: text.length,
    truncated: false,
    retrieved_at: observed,
    entities: [],
  };
}

/** Serves fixed items per day, as a provider that never deletes anything would. */
function served(source: SourceId, items: ReadonlyArray<Item>): SourceAdapter {
  return {
    descriptor: SOURCES[source],
    collectDay: async (day) => {
      const own = items.filter((item) => item.published_at.startsWith(`${day}T`));
      return {
        items: own,
        coverage: {
          source,
          day,
          status: "partial",
          items: own.length,
          retrieved_at: observed,
          note: null,
        },
      };
    },
  };
}

async function allText(root: string): Promise<string> {
  const names = await NodeFSP.readdir(root, { recursive: true, withFileTypes: true });
  const files = names.filter((entry) => entry.isFile());
  const texts = await Promise.all(
    files.map((entry) => NodeFSP.readFile(NodePath.join(entry.parentPath, entry.name), "utf8")),
  );
  return texts.join("\n");
}

const ONE = "did:plc:exampleauthorone";
const TWO = "did:plc:exampleauthortwo";
const a1 = post(ONE, "one.example.test", "3mza1", "2026-10-28T09:00:00.000Z");
const a2 = post(ONE, "one.example.test", "3mza2", "2026-10-29T09:00:00.000Z");
const b1 = post(TWO, "two.example.test", "3mzb1", "2026-10-29T10:00:00.000Z");
const b2 = post(TWO, "two.example.test", "3mzb2", "2026-10-29T11:00:00.000Z");

describe("engine purge", () => {
  it("removes an author from every day and history file, records it and blocks re-collection", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "purge-"));
    try {
      const range = { dir: root, from: "2026-10-28", to: "2026-10-30" };
      await collectCorpus({ ...range, adapters: [served("bluesky", [a1, a2, b1])] });
      // A second capture of 2026-10-29 keeps the first version, with a2, under history/.
      await collectCorpus({
        ...range,
        adapters: [served("bluesky", [a1, a2, b1, b2])],
        force: true,
      });
      expect(await NodeFSP.readdir(NodePath.join(root, "history"))).not.toHaveLength(0);

      const byDid = await purgeCorpus({ dir: root, source: "bluesky", author: ONE });
      expect(byDid).toMatchObject({ source: "bluesky", match: "author", items_removed: 2 });
      expect(byDid.value_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(byDid.files_rewritten).toBeGreaterThanOrEqual(3);
      const text = await allText(root);
      expect(text).not.toContain("exampleauthorone");
      expect(text).not.toContain("one.example.test");

      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8"),
      );
      expect(manifest.purges).toHaveLength(1);
      expect(manifest.corpus_hash).toBe(hashCorpus(manifest));
      const corpus = await readCorpus({
        dir: root,
        untilDay: "2026-10-30",
        adapters: fixtureSources(root, ["bluesky"]),
      });
      expect(corpus.verified).toBe(true);
      expect(corpus.items.map((item) => item.id)).toEqual([b1.id, b2.id]);
      expect(corpus.coverage.map((row) => row.items)).toEqual([0, 2]);
      expect(corpus.coverage[0]?.note).toBe("purged 1 item(s) on request");

      // The provider still serves the posts; a forced collection must not store them again.
      await collectCorpus({
        ...range,
        adapters: [served("bluesky", [a1, a2, b1, b2])],
        force: true,
      });
      expect(await allText(root)).not.toContain("exampleauthorone");

      const byHandle = await purgeCorpus({
        dir: root,
        source: "bluesky",
        author: "@Two.Example.Test",
      });
      expect(byHandle.items_removed).toBe(2);
      const byUri = await purgeCorpus({
        dir: root,
        source: "bluesky",
        uri: `at://${TWO}/app.bsky.feed.post/3mzb9`,
      });
      // Nothing left to remove, but the record still keeps a later capture of the post out.
      expect(byUri.items_removed).toBe(0);
      const last = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8"),
      );
      expect(last.purges).toHaveLength(3);
      expect(
        (
          await readCorpus({
            dir: root,
            untilDay: "2026-10-30",
            adapters: fixtureSources(root, ["bluesky"]),
          })
        ).items,
      ).toEqual([]);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("purges any source by permalink and rejects ambiguous targets", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "purge-"));
    try {
      const story = (id: string): Item => ({
        ...post(ONE, "someone", id, "2026-10-28T09:00:00.000Z"),
        id: `itm_hn_${id}`,
        source: "hn",
        permalink: `https://news.ycombinator.com/item?id=${id}`,
      });
      await collectCorpus({
        dir: root,
        from: "2026-10-28",
        to: "2026-10-29",
        adapters: [served("hn", [story("1"), story("2")])],
      });
      const result = await purgeCorpus({
        dir: root,
        source: "hn",
        uri: "https://news.ycombinator.com/item?id=2",
      });
      expect(result.items_removed).toBe(1);
      const corpus = await readCorpus({
        dir: root,
        untilDay: "2026-10-29",
        adapters: fixtureSources(root, ["hn"]),
      });
      expect(corpus.items.map((item) => item.id)).toEqual(["itm_hn_1"]);
      await expect(
        purgeCorpus({ dir: root, source: "hn", author: "x", uri: "https://x" }),
      ).rejects.toThrow("exactly one");
      await expect(
        purgeCorpus({ dir: root, source: "hn", uri: `at://${ONE}/app.bsky.feed.post/1` }),
      ).rejects.toThrow("Not a purgeable URI");
      await expect(NodeFSP.access(NodePath.join(root, ".collect.lock"))).rejects.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
