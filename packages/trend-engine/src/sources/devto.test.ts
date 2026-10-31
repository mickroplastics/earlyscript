// @effect-diagnostics nodeBuiltinImport:off globalDate:off - recorded dev.to responses replayed through the plain adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import { devtoCollector, devtoLatestUrl } from "./devto.ts";
import { createHttpClient, MAX_RESPONSE_BYTES, type GetResponse } from "./http.ts";
import { hfModelsUrl } from "./huggingface.ts";
import { fixtureSources, liveSources, SOURCES } from "./index.ts";
import { collectCorpus } from "../collect.ts";
import { readCorpus } from "../corpus.ts";

const observed = "2026-10-31T04:00:00.000Z";
type Pages = { page1: unknown[]; page2: unknown[]; page3: unknown[] };
async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await NodeFSP.readFile(new URL(`../testkit/${name}`, import.meta.url), "utf8"),
  ) as T;
}
/** Replays three recorded `articles/latest` pages; page 2 repeats the last article of page 1. */
async function recordedListing(at = observed) {
  const pages = await fixture<Pages>("devto-latest-pages.json");
  const calls: Array<number> = [];
  const get: GetResponse = async (url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    calls.push(page);
    const body = [pages.page1, pages.page2, pages.page3][page - 1] ?? [];
    return { observed_at: at, status: 200, body };
  };
  return { get, calls, pages };
}

describe("dev.to source", () => {
  it("collects a whole UTC day of tagged articles and keeps the walk between days", async () => {
    const { get, calls } = await recordedListing();
    const collect = devtoCollector();
    const day = await collect("2026-10-30", get);
    expect(calls).toEqual([1, 2, 3]);
    // Untagged and out-of-day articles stay out; the repeated article appears once.
    expect(day.items).toHaveLength(5);
    expect(new Set(day.items.map((item) => item.id)).size).toBe(5);
    for (const item of day.items) {
      expect(item.published_at.startsWith("2026-10-30T")).toBe(true);
      expect(item.permalink).toMatch(/^https:\/\/dev\.to\//);
      expect(item.retrieved_at).toBe(observed);
      expect(item.id).toMatch(/^itm_devto_\d+$/);
    }
    expect(day.coverage).toMatchObject({ source: "devto", status: "complete", items: 5 });
    expect(day.coverage?.note).toMatch(/^tags ai=\d+,llm=\d+,.*rust=\d+; pages walked=3$/);

    // The next day is already walked; it began before the walk, so it is not over.
    const today = await collect("2026-10-31", get);
    expect(calls).toEqual([1, 2, 3]);
    expect(today.items).toHaveLength(1);
    expect(today.coverage?.status).toBe("partial");
    expect(today.coverage?.note).toContain("day not over");

    // An earlier day continues the walk; an empty page ends the listing before its start.
    const earlier = await collect("2026-10-29", get);
    expect(calls).toEqual([1, 2, 3, 4]);
    expect(earlier.items).toHaveLength(1);
    expect(earlier.coverage).toMatchObject({ status: "partial", items: 1 });
    expect(earlier.coverage?.note).toContain("listing ended before the day start");
  });

  it("maps article fields and keeps a canonical URL outside dev.to as the external link", async () => {
    const { get, pages } = await recordedListing();
    const first = pages.page1[2] as { id: number; title: string; user: { username: string } };
    const result = await devtoCollector()("2026-10-30", async (url) => {
      const response = await get(url);
      if (!url.endsWith("page=1")) return response;
      const body = (response.body as Array<Record<string, unknown>>).map((article) =>
        article.id === first.id
          ? { ...article, canonical_url: "https://github.com/Owner/Repo" }
          : article,
      );
      return { ...response, body };
    });
    const item = result.items.find((entry) => entry.id === `itm_devto_${first.id}`)!;
    expect(item).toMatchObject({
      title: first.title,
      author: first.user.username,
      external_url: "https://github.com/Owner/Repo",
      entities: ["github:owner/repo"],
    });
  });

  it("stops when the listing is not newest first", async () => {
    const { get, pages } = await recordedListing();
    const result = await devtoCollector()("2026-10-30", async (url) => {
      const response = await get(url);
      return url.endsWith("page=3") ? { ...response, body: [...pages.page3].reverse() } : response;
    });
    expect(result.coverage?.status).toBe("partial");
    expect(result.coverage?.note).toContain("dev.to listing is not newest first");
  });

  it("identifies itself, paces at 3 s and honors Retry-After", async () => {
    const waits: Array<number> = [];
    let clock = 0;
    const agents: Array<string | null> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      agents.push(new Headers(init?.headers).get("user-agent"));
      return agents.length === 1
        ? new Response("", { status: 429, headers: { "retry-after": "70" } })
        : Response.json([]);
    });
    const get = createHttpClient("devto", {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await get(devtoLatestUrl(1));
    await get(devtoLatestUrl(2));
    expect(waits).toEqual([70_000, 3000]);
    expect(agents[0]).toMatch(/^Earlyscript\/[\d.]+ \(\+https:\/\//);
  });

  it("marks the day unavailable when a page exceeds the byte limit", async () => {
    const result = await devtoCollector()(
      "2026-10-30",
      createHttpClient("devto", {
        fetch: async () => new Response(`[${" ".repeat(MAX_RESPONSE_BYTES.devto)}]`),
      }),
    );
    expect(MAX_RESPONSE_BYTES.devto).toBe(4 * 1024 * 1024);
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).toContain("response_too_large");
  });
});

describe("Hugging Face and dev.to in a corpus/1 collection", () => {
  it("registers both sources and writes a verified corpus", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hf-devto-"));
    try {
      const listing = await fixture<Pages>("devto-latest-pages.json");
      const models = await fixture<{ page1: unknown[] }>("hf-models-pages.json");
      const papers = await fixture<unknown[]>("hf-daily-papers-2026-10-30.json");
      let clock = Date.parse("2026-11-01T00:00:00Z");
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.hostname === "dev.to") {
          const page = Number(url.searchParams.get("page"));
          return Response.json([listing.page1, listing.page2, listing.page3][page - 1] ?? []);
        }
        if (url.href === hfModelsUrl()) return Response.json(models.page1);
        if (url.pathname === "/api/daily_papers") return Response.json(papers);
        return new Response("", { status: 404 });
      });
      const adapters = liveSources(["huggingface", "devto"], {
        fetch: fetcher,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      });
      const rows = await collectCorpus({ dir: root, from: "2026-10-30", to: "2026-10-31", adapters });
      expect(rows.map(({ source, status, items }) => ({ source, status, items }))).toEqual([
        { source: "huggingface", status: "partial", items: 5 },
        { source: "devto", status: "complete", items: 5 },
      ]);
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8"),
      );
      expect(Object.keys(manifest.selection)).toEqual(
        expect.arrayContaining(["huggingface", "devto"]),
      );
      const corpus = await readCorpus({
        dir: root,
        untilDay: "2026-10-31",
        adapters: fixtureSources(root, ["huggingface", "devto"]),
      });
      expect(corpus.verified).toBe(true);
      expect(SOURCES.huggingface.coverage_policy).toBe("sample");
      expect(SOURCES.devto.coverage_policy).toBe("census");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

const live = process.env.EARLYSCRIPT_LIVE_TESTS === "1";
// Network gate: the day is that of the newest article, so the walk stays within a few pages.
describe.skipIf(!live)("dev.to source (live)", () => {
  it("collects the current day from the public API", async () => {
    const get = createHttpClient("devto");
    const newest = (await get(devtoLatestUrl(1))).body as Array<{ published_at: string }>;
    const result = await devtoCollector()(newest[0]!.published_at.slice(0, 10), get);
    // `partial` while the day runs ("day not over"); `complete` only right after midnight UTC.
    expect(["partial", "complete"]).toContain(result.coverage?.status);
    expect(result.items.length).toBeGreaterThan(0);
  });
});
