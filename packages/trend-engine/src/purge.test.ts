// @effect-diagnostics nodeBuiltinImport:off - isolated corpus directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import type { RssFeed } from "@earlyscript/editorial-contracts/source";
import { collectCorpus } from "./collect.ts";
import { hashCorpus, readCorpus } from "./corpus.ts";
import { sha256 } from "./hash.ts";
import { purgeCorpus } from "./purge.ts";
import { fixtureSources, liveSources } from "./sources/index.ts";

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
