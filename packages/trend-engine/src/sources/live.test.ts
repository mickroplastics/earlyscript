// @effect-diagnostics nodeBuiltinImport:off - isolated filesystem tests for the plain engine.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import { collectHnDay } from "./hn.ts";
import { collectGithubDay, githubSearchUrl } from "./github.ts";
import { createHttpClient } from "./http.ts";
import { liveSources, fixtureSources } from "./index.ts";
import { collectCorpus } from "../collect.ts";
import { hashCorpus, readCorpus } from "../corpus.ts";
import { sha256 } from "../hash.ts";
import type { Item } from "@earlyscript/editorial-contracts/item";

const day = "2026-10-15";
const until = "2026-10-16";
const observed = "2026-10-21T18:49:42.671Z";
async function reference(): Promise<Array<Item>> {
  return (
    await NodeFSP.readFile(new URL("../testkit/hn-live-reference.jsonl", import.meta.url), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
const hit = (item: Item) => ({
  objectID: item.id.slice(7),
  created_at_i: Date.parse(item.published_at) / 1000,
  title: item.title,
  author: item.author,
  url: item.external_url,
  story_text: item.body,
});
const response = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("live sources", () => {
  it("matches all frozen item fields and marks a complete UTC day", async () => {
    const items = await reference();
    const result = await collectHnDay(day, async () => ({
      observed_at: observed,
      status: 200,
      body: { hits: items.map(hit), nbHits: items.length },
    }));
    expect(result.items).toEqual(items);
    expect(result.coverage).toMatchObject({ day, status: "complete", items: 20 });
  });
  it("retries 429 with exponential waits and honors Retry-After", async () => {
    const waits: Array<number> = [];
    let clock = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({}, 429, { "retry-after": "70" }))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValue(response({ hits: [], nbHits: 0 }));
    const get = createHttpClient("hn", {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect((await collectHnDay(day, get)).coverage?.status).toBe("complete");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([70_000, 2000]);
  });
  it("shares pacing across consecutive UTC days", async () => {
    let clock = 0;
    const waits: Array<number> = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ hits: [], nbHits: 0 }));
    const [adapter] = liveSources(["hn"], {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await adapter!.collectDay(day);
    await adapter!.collectDay(until);
    expect(waits).toEqual([250]);
  });
  it("keeps one subdivided window when the other times out", async () => {
    const items = await reference();
    let calls = 0;
    const result = await collectHnDay(day, async () => {
      calls++;
      if (calls === 1)
        return { observed_at: observed, status: 200, body: { hits: [], nbHits: 1001 } };
      if (calls === 2)
        return {
          observed_at: observed,
          status: 200,
          body: { hits: items.map(hit), nbHits: items.length },
        };
      return createHttpClient("hn", {
        fetch: async () => {
          throw new DOMException("timeout", "TimeoutError");
        },
        dayTimeoutMs: 1,
      })("https://hn.algolia.com");
    });
    expect(result.coverage).toMatchObject({ status: "partial", items: 20 });
  });
  it("marks network failure unavailable without exposing error contents", async () => {
    const result = await collectHnDay(
      day,
      createHttpClient("hn", {
        fetch: async () => {
          throw new Error("secret");
        },
        dayTimeoutMs: 1,
      }),
    );
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).not.toContain("secret");
  });
  it("keeps GitHub a partial sample and only emits creations in the requested day", async () => {
    expect(new URL(githubSearchUrl(day)).searchParams.get("q")).toBe(
      "created:2026-10-08..2026-10-15 stars:>=20 fork:false",
    );
    const repo = {
      id: 1,
      full_name: "a/b",
      html_url: "https://github.com/a/b",
      created_at: `${day}T01:00:00Z`,
      description: "demo",
      owner: { login: "a" },
    };
    const result = await collectGithubDay(day, async () => ({
      observed_at: observed,
      status: 200,
      body: {
        total_count: 2,
        incomplete_results: false,
        items: [repo, { ...repo, id: 2, created_at: "2026-10-14T00:00:00Z" }],
      },
    }));
    expect(result.items).toHaveLength(1);
    expect(result.coverage?.status).toBe("partial");
  });
  it("is idempotent, updates hashes, preserves forced data and continues after failed days", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "live-sources-"));
    try {
      const items = await reference();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(response({ hits: items.map(hit), nbHits: items.length }));
      const adapters = liveSources(["hn"], { fetch: fetcher });
      await collectCorpus({ dir: root, from: day, to: until, adapters });
      const before = await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8");
      await collectCorpus({ dir: root, from: day, to: until, adapters });
      expect(fetcher).toHaveBeenCalledTimes(1);
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8"),
      );
      expect(manifest.corpus_hash).toBe(JSON.parse(before).corpus_hash);
      expect(manifest.corpus_hash).toBe(hashCorpus(manifest));
      for (const file of manifest.files)
        expect(sha256(await NodeFSP.readFile(NodePath.join(root, file.path)))).toBe(file.sha256);
      expect(
        (await readCorpus({ dir: root, untilDay: until, adapters: fixtureSources(root, ["hn"]) }))
          .verified,
      ).toBe(true);
      fetcher.mockRejectedValue(new Error("offline"));
      const failed = liveSources(["hn"], { fetch: fetcher, dayTimeoutMs: 1 });
      const rows = await collectCorpus({
        dir: root,
        from: day,
        to: "2026-10-17",
        adapters: failed,
        force: true,
      });
      expect(rows.map((row) => row.status)).toEqual(["partial", "unavailable"]);
      expect(rows[0]?.items).toBe(20);
      expect(await NodeFSP.readdir(NodePath.join(root, "history"))).not.toHaveLength(0);
      const after = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8"),
      );
      expect(after.corpus_hash).not.toBe(manifest.corpus_hash);
      expect(
        (
          await readCorpus({
            dir: root,
            untilDay: "2026-10-17",
            adapters: fixtureSources(root, ["hn"]),
          })
        ).verified,
      ).toBe(true);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
