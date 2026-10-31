// @effect-diagnostics nodeBuiltinImport:off - isolated corpus directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import type { Item } from "@earlyscript/editorial-contracts/item";
import type { RssFeed, SourceId } from "@earlyscript/editorial-contracts/source";
import { collectCorpus } from "./collect.ts";
import { hashCorpus, readCorpus } from "./corpus.ts";
import { sha256 } from "./hash.ts";
import { purgeCorpus } from "./purge.ts";
import { fixtureSources, liveSources, SOURCES, type SourceAdapter } from "./sources/index.ts";

const day = "2026-10-30";
const feeds: Array<RssFeed> = [
  {
    id: "one",
    name: "One",
    feedUrl: "https://one.example/feed",
    siteUrl: "https://one.example/",
    license: "",
  },
  {
    id: "two",
    name: "Two",
    feedUrl: "https://two.example/feed",
    siteUrl: "https://two.example/",
    license: "",
  },
];
const atom = (host: string) => `<feed><title>${host}</title>
<entry><id>${host}/a</id><link href="https://${host}/a"/><published>2026-10-30T10:00:00Z</published><summary>a</summary></entry>
<entry><id>${host}/b</id><link href="https://${host}/b"/><published>2026-10-30T11:00:00Z</published><summary>b</summary></entry>
<entry><id>${host}/old</id><link href="https://${host}/old"/><published>2026-10-20T11:00:00Z</published><summary>old</summary></entry>
</feed>`;

async function corpus() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "purge-"));
  let clock = Date.parse("2026-10-31T12:00:00Z");
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const parsed = new URL(String(url));
    return parsed.pathname === "/robots.txt"
      ? new Response("", { status: 404 })
      : new Response(atom(parsed.host));
  });
  const adapters = () =>
    liveSources(
      ["rss"],
      {
        fetch: fetcher,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
      { rssFeeds: feeds },
    );
  await collectCorpus({ dir: root, from: day, to: "2026-10-31", adapters: adapters() });
  return { root, adapters };
}
const dayItems = async (root: string) =>
  (await NodeFSP.readFile(NodePath.join(root, "rss", `${day}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe("engine purge", () => {
  it("removes one URL, then a whole feed, records hashed purges and refuses them on recollect", async () => {
    const { root, adapters } = await corpus();
    try {
      expect(await dayItems(root)).toHaveLength(4);
      const byUrl = await purgeCorpus({
        dir: root,
        source: "rss",
        uri: "https://one.example/a",
        now: () => "2026-11-01T00:00:00.000Z",
      });
      expect(byUrl).toEqual({
        source: "rss",
        match: "uri",
        value_sha256: sha256("https://one.example/a"),
        items_removed: 1,
        files_rewritten: 1,
        purged_at: "2026-11-01T00:00:00.000Z",
      });
      const byFeed = await purgeCorpus({ dir: root, source: "rss", feed: feeds[1]!.feedUrl });
      expect(byFeed).toMatchObject({ match: "feed", items_removed: 2 });
      expect((await dayItems(root)).map((entry) => entry.permalink)).toEqual([
        "https://one.example/b",
      ]);
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8"),
      );
      expect(manifest.purges).toHaveLength(2);
      expect(manifest.corpus_hash).toBe(hashCorpus(manifest));
      // The identifiers are hashed, never stored in clear.
      expect(JSON.stringify(manifest.purges)).not.toContain("example");
      const coverage = await NodeFSP.readFile(NodePath.join(root, "coverage.jsonl"), "utf8");
      expect(coverage).toContain('"items":1');
      expect(coverage).toContain("purged 2 item(s) on request");
      expect(
        (
          await readCorpus({
            dir: root,
            untilDay: "2026-10-31",
            adapters: fixtureSources(root, ["rss"]),
          })
        ).verified,
      ).toBe(true);
      // The feeds still serve the purged entries; collect must not store them again.
      await collectCorpus({
        dir: root,
        from: day,
        to: "2026-10-31",
        adapters: adapters(),
        force: true,
      });
      expect((await dayItems(root)).map((entry) => entry.permalink)).toEqual([
        "https://one.example/b",
      ]);
      const history = await NodeFSP.readdir(NodePath.join(root, "history")).catch(() => []);
      for (const file of history)
        expect(await NodeFSP.readFile(NodePath.join(root, "history", file), "utf8")).not.toContain(
          "two.example",
        );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("needs exactly one target and keeps --feed to rss", async () => {
    await expect(purgeCorpus({ dir: "/nonexistent", source: "rss" })).rejects.toThrow(
      "exactly one",
    );
    await expect(
      purgeCorpus({ dir: "/nonexistent", source: "rss", uri: "a", feed: "b" }),
    ).rejects.toThrow("exactly one");
    await expect(purgeCorpus({ dir: "/nonexistent", source: "hn", feed: "b" })).rejects.toThrow(
      "rss only",
    );
  });
});

// Bluesky (es/sources-earlywindow): deletion by DID, handle and at:// URI.
const observedAt = "2026-10-31T03:00:00.000Z";

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
    retrieved_at: observedAt,
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
          retrieved_at: observedAt,
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

describe("engine purge: bluesky", () => {
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
      await expect(
        purgeCorpus({ dir: root, source: "hn", uri: `at://${ONE}/app.bsky.feed.post/1` }),
      ).rejects.toThrow("Not a purgeable URI");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
