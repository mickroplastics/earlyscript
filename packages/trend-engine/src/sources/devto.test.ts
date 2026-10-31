// @effect-diagnostics nodeBuiltinImport:off globalDate:off - recorded dev.to responses replayed through the plain adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import { DEVTO_PER_DAY, devtoCollector, devtoLatestUrl } from "./devto.ts";
import { createHttpClient, MAX_RESPONSE_BYTES, type GetResponse } from "./http.ts";
import { hfModelsUrl } from "./huggingface.ts";
import { fixtureSources, liveSources, SOURCES } from "./index.ts";
import { robotsAllows, robotsGate, robotsRules, type RobotsGate } from "./robots.ts";
import { collectCorpus } from "../collect.ts";
import { readCorpus } from "../corpus.ts";

const observed = "2026-10-31T04:00:00.000Z";
const allow: RobotsGate = async () => null;
const robotsFile = (name: string) =>
  NodeFSP.readFile(new URL(`../testkit/${name}`, import.meta.url), "utf8");
type Pages = { page1: unknown[]; page2: unknown[]; page3: unknown[] };
async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await NodeFSP.readFile(new URL(`../testkit/${name}`, import.meta.url), "utf8"),
  ) as T;
}
/**
 * Reader response per article id. The recorded counts were all 0 (captured minutes after
 * publication); these assigned values exercise the selection. 4948931 stays at 0/0.
 */
const RESPONSES: Record<number, [reactions: number, comments: number]> = {
  4950576: [1, 0],
  4949370: [0, 2],
  4949362: [3, 0],
  4949359: [1, 0],
  4944802: [5, 0],
  4943821: [1, 0],
};
type Article = { id: number; published_at: string };
async function listing(): Promise<Pages> {
  const pages = await fixture<Pages>("devto-latest-pages.json");
  const respond = (page: unknown[]) =>
    page.map((raw) => {
      const article = raw as Article;
      const [reactions, comments] = RESPONSES[article.id] ?? [0, 0];
      return { ...article, positive_reactions_count: reactions, comments_count: comments };
    });
  return { page1: respond(pages.page1), page2: respond(pages.page2), page3: respond(pages.page3) };
}
/** Replays three recorded `articles/latest` pages; page 2 repeats the last article of page 1. */
async function recordedListing(at = observed) {
  const pages = await listing();
  const calls: Array<string> = [];
  const get: GetResponse = async (url) => {
    const params = new URL(url).searchParams;
    const page = Number(params.get("page"));
    calls.push(params.get("per_page") === "1000" ? String(page) : `bridge ${page}`);
    const body = [pages.page1, pages.page2, pages.page3][page - 1] ?? [];
    return { observed_at: at, status: 200, body };
  };
  return { get, calls, pages };
}

describe("dev.to source", () => {
  it("collects a whole UTC day of tagged articles and keeps the walk between days", async () => {
    const { get, calls } = await recordedListing();
    const collect = devtoCollector();
    const day = await collect("2026-10-30", get, allow);
    expect(calls).toEqual(["1", "2", "3"]);
    // Untagged, unanswered and out-of-day articles stay out; the repeated one appears once.
    expect(day.items.map((item) => item.id).toSorted()).toEqual([
      "itm_devto_4944802",
      "itm_devto_4949359",
      "itm_devto_4949362",
      "itm_devto_4949370",
    ]);
    for (const item of day.items) {
      expect(item.published_at.startsWith("2026-10-30T")).toBe(true);
      expect(item.permalink).toMatch(/^https:\/\/dev\.to\//);
      expect(item.retrieved_at).toBe(observed);
      expect(item.id).toMatch(/^itm_devto_\d+$/);
    }
    expect(day.coverage).toMatchObject({ source: "devto", status: "complete", items: 4 });
    expect(day.coverage?.note).toMatch(
      /^eligible=4, kept=4; tags ai=\d+,llm=\d+,.*rust=\d+; pages walked=3$/,
    );

    // The next day is already walked; it began before the walk, so it is not over.
    const today = await collect("2026-10-31", get, allow);
    expect(calls).toEqual(["1", "2", "3"]);
    expect(today.items).toHaveLength(1);
    expect(today.coverage?.status).toBe("partial");
    expect(today.coverage?.note).toContain("day not over");

    // An earlier day continues the walk; an empty page ends the listing before its start.
    const earlier = await collect("2026-10-29", get, allow);
    expect(calls).toEqual(["1", "2", "3", "4"]);
    expect(earlier.items).toHaveLength(1);
    expect(earlier.coverage).toMatchObject({ status: "partial", items: 1 });
    expect(earlier.coverage?.note).toContain("listing ended before the day start");
  });

  it("maps article fields and keeps a canonical URL outside dev.to as the external link", async () => {
    const { get, pages } = await recordedListing();
    const first = pages.page1[3] as { id: number; title: string; user: { username: string } };
    const edited: GetResponse = async (url) => {
      const response = await get(url);
      if (!url.endsWith("page=1")) return response;
      const body = (response.body as Array<Record<string, unknown>>).map((article) =>
        article.id === first.id
          ? { ...article, canonical_url: "https://github.com/Owner/Repo" }
          : article,
      );
      return { ...response, body };
    };
    const result = await devtoCollector()("2026-10-30", edited, allow);
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
    const reversed: GetResponse = async (url) => {
      const response = await get(url);
      return url.endsWith("page=3") ? { ...response, body: [...pages.page3].reverse() } : response;
    };
    const result = await devtoCollector()("2026-10-30", reversed, allow);
    expect(result.coverage?.status).toBe("partial");
    expect(result.coverage?.note).toContain("dev.to listing is not newest first");
  });

  it("keeps the most reacted 500 articles of a day and calls the sample partial", async () => {
    // Synthetic listing: 600 answered articles, one per minute of 2026-10-30, newest first.
    const articles = Array.from({ length: 600 }, (_, n) => ({
      id: 9_000_000 + n,
      title: `Article ${n}`,
      description: "",
      url: `https://dev.to/a/article-${n}`,
      published_at: new Date(Date.parse("2026-10-30T23:59:00Z") - n * 60_000).toISOString(),
      tag_list: ["ai"],
      positive_reactions_count: n % 7 === 0 ? 0 : n,
      comments_count: n % 7 === 0 ? 1 : 0,
      user: { username: `u${n}` },
    }));
    const older = { ...articles[0]!, id: 1, published_at: "2026-10-29T12:00:00Z" };
    const day = await devtoCollector()(
      "2026-10-30",
      async (url) => ({
        observed_at: observed,
        status: 200,
        body: new URL(url).searchParams.get("page") === "1" ? [...articles, older] : [],
      }),
      allow,
    );
    expect(day.items).toHaveLength(DEVTO_PER_DAY);
    expect(day.coverage).toMatchObject({ status: "partial", items: 500 });
    expect(day.coverage?.note).toMatch(/^eligible=600, kept=500; /);
    // The 100 left out: the 86 answered only by a comment and the 14 with the fewest reactions.
    const kept = new Set(day.items.map((item) => Number(item.id.slice(10)) - 9_000_000));
    expect(kept.has(599)).toBe(true);
    expect(kept.has(1)).toBe(false);
  });

  describe("CDN cache gaps", () => {
    // Page 1 is 30 s old in the CDN and page 2 15 minutes old: the articles published between
    // them (here 4949362 at 20:13:55) are on no page. Page 2 drops its repeat of page 1.
    async function cachedListing(bridgeBody: (page: number, pages: Pages) => unknown[]) {
      const { pages } = await recordedListing();
      const calls: Array<string> = [];
      const get: GetResponse = async (url) => {
        const params = new URL(url).searchParams;
        const page = Number(params.get("page"));
        if (params.get("per_page") === "200") {
          calls.push(`bridge ${page}`);
          return { observed_at: observed, status: 200, body: bridgeBody(page, pages), age: 0 };
        }
        calls.push(String(page));
        if (page === 1) return { observed_at: observed, status: 200, body: pages.page1, age: 30 };
        if (page === 2)
          return { observed_at: observed, status: 200, body: pages.page2.slice(2), age: 900 };
        return { observed_at: observed, status: 200, body: page === 3 ? pages.page3 : [], age: 0 };
      };
      return { get, calls };
    }

    it("closes the gap with a bridge page of another size", async () => {
      // per_page=200 page 5 holds positions 800-999, the end of page 1: fresh, it still shows
      // the hidden article between the last of page 1 and the first of the cached page 2.
      const { get, calls } = await cachedListing((page, pages) =>
        page === 5 ? [pages.page1[3], ...pages.page2] : [],
      );
      const day = await devtoCollector()("2026-10-30", get, allow);
      expect(calls).toEqual(["1", "2", "bridge 5", "3"]);
      expect(day.items.map((item) => item.id)).toContain("itm_devto_4949362");
      expect(day.coverage).toMatchObject({ status: "complete", items: 4 });
      expect(day.coverage?.note).not.toContain("possible gap");
      expect(day.coverage?.note).toContain("bridge pages=1");
    });

    it("keeps the day partial with the range when three bridge pages do not reach it", async () => {
      // The bridge pages are stuck above the gap: they never reach the first of page 2.
      const { get, calls } = await cachedListing((_page, pages) => [pages.page1[3]]);
      const day = await devtoCollector()("2026-10-30", get, allow);
      expect(calls).toEqual(["1", "2", "bridge 5", "bridge 6", "bridge 7", "3"]);
      expect(day.items.map((item) => item.id)).not.toContain("itm_devto_4949362");
      expect(day.coverage?.status).toBe("partial");
      expect(day.coverage?.note).toMatch(
        /^possible gap 2026-10-30T20:13:13\.000Z\.\.2026-10-30T20:15:17\.000Z: cached page older/,
      );
      expect(day.coverage?.note).toContain("bridge pages=3");
    });

    it("needs no bridge when the older cached page repeats an article of the previous one", async () => {
      const { get } = await recordedListing();
      const overlapping: GetResponse = async (url) => {
        const response = await get(url);
        return url.endsWith("&page=2") ? { ...response, age: 600 } : response;
      };
      const whole = await devtoCollector()("2026-10-30", overlapping, allow);
      expect(whole.coverage?.status).toBe("complete");
      expect(whole.coverage?.note).not.toContain("bridge");
    });
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
      allow,
    );
    expect(MAX_RESPONSE_BYTES.devto).toBe(4 * 1024 * 1024);
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).toContain("response_too_large");
  });
});

describe("robots.txt of Hugging Face and dev.to", () => {
  it("allows every API path the adapters request (files recorded on 31 October 2026)", async () => {
    const hub = robotsRules(await robotsFile("huggingface-robots.txt"));
    for (const url of [
      hfModelsUrl(),
      "https://huggingface.co/api/daily_papers?date=2026-10-30&limit=100&p=0",
      "https://huggingface.co/ostris/primal_vae/resolve/main/README.md",
    ])
      expect(robotsAllows(hub, url)).toBe(true);
    const dev = robotsRules(await robotsFile("devto-robots.txt"));
    expect(robotsAllows(dev, devtoLatestUrl(1))).toBe(true);
    // The file is parsed, not ignored: its interface paths stay closed.
    expect(robotsAllows(dev, "https://dev.to/search?q=agents")).toBe(false);
  });

  it("requests no listing page when robots.txt refuses or answers 5xx", async () => {
    const { get, calls } = await recordedListing();
    const refused = await devtoCollector()(
      "2026-10-30",
      get,
      robotsGate(
        () => async () => ({
          observed_at: observed,
          status: 200,
          body: "User-agent: Earlyscript\nDisallow: /api/\n",
        }),
        new Map(),
      ),
    );
    expect(calls).toEqual([]);
    expect(refused.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(refused.coverage?.note).toMatch(/^robots_disallowed: https:\/\/dev\.to\/robots\.txt/);

    const down = await devtoCollector()(
      "2026-10-30",
      get,
      robotsGate(() => async () => ({ observed_at: observed, status: 503, body: null }), new Map()),
    );
    expect(calls).toEqual([]);
    expect(down.coverage?.status).toBe("unavailable");
    expect(down.coverage?.note).toMatch(/^robots_unavailable: /);
  });
});

describe("Hugging Face and dev.to in a corpus/1 collection", () => {
  it("registers both sources and writes a verified corpus", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hf-devto-"));
    try {
      const devPages = await listing();
      const models = await fixture<{ page1: unknown[] }>("hf-models-pages.json");
      const papers = await fixture<unknown[]>("hf-daily-papers-2026-10-30.json");
      let clock = Date.parse("2026-11-01T00:00:00Z");
      const robots = {
        "dev.to": await robotsFile("devto-robots.txt"),
        "huggingface.co": await robotsFile("huggingface-robots.txt"),
      };
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/robots.txt")
          return new Response(robots[url.hostname as keyof typeof robots]);
        if (url.hostname === "dev.to") {
          const page = Number(url.searchParams.get("page"));
          return Response.json([devPages.page1, devPages.page2, devPages.page3][page - 1] ?? []);
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
      const rows = await collectCorpus({
        dir: root,
        from: "2026-10-30",
        to: "2026-10-31",
        adapters,
      });
      expect(rows.map(({ source, status, items }) => ({ source, status, items }))).toEqual([
        { source: "huggingface", status: "partial", items: 5 },
        { source: "devto", status: "complete", items: 4 },
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
    const newest = (await createHttpClient("devto")(devtoLatestUrl(1))).body as Array<{
      published_at: string;
    }>;
    const [adapter] = liveSources(["devto"]);
    const result = await adapter!.collectDay(newest[0]!.published_at.slice(0, 10));
    // `partial` while the day runs ("day not over"); `complete` only right after midnight UTC.
    expect(["partial", "complete"]).toContain(result.coverage?.status);
    expect(result.items.length).toBeGreaterThan(0);
  });
});
