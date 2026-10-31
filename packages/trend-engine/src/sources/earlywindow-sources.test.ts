// @effect-diagnostics nodeBuiltinImport:off - recorded provider responses read from the testkit.
import * as NodeFSP from "node:fs/promises";
import { describe, expect, it, vi } from "vite-plus/test";
import { collectArxivDay } from "./arxiv.ts";
import { BLUESKY_MAX_REQUESTS_PER_TERM, BLUESKY_TERMS, collectBlueskyDay } from "./bluesky.ts";
import { createHttpClient, type FrozenResponse, type GetResponse } from "./http.ts";
import { liveSources } from "./index.ts";
import { collectNpmDay, NPM_QUERIES } from "./npm.ts";
import { robotsGate, type RobotsGate } from "./robots.ts";
import { collectStackExchangeDay, stackExchangeThrottle } from "./stackexchange.ts";
import { collectWikipediaDay, wikipediaTopUrl } from "./wikipedia.ts";

const observed = "2026-10-31T03:00:00.000Z";
const ok = (body: unknown, observed_at = observed): FrozenResponse => ({
  observed_at,
  status: 200,
  body,
});
const allow: RobotsGate = async () => null;
const fixture = (name: string) =>
  NodeFSP.readFile(new URL(`../testkit/sources/${name}`, import.meta.url), "utf8");
const json = async (name: string): Promise<any> => JSON.parse(await fixture(name));
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
/** A robots.txt server: one text per host, 404 for the others. */
const robotsFrom = (texts: Record<string, string>) =>
  robotsGate(
    (url) => async () => {
      const text = texts[new URL(url).hostname];
      return text === undefined ? { observed_at: observed, status: 404, body: null } : ok(text);
    },
    new Map(),
  );

describe("arXiv", () => {
  it("keeps in-day entries, drops the next midnight and is complete only after the 4-day lag", async () => {
    const feed = await fixture("arxiv-2026-10-26.xml");
    const urls: Array<string> = [];
    const early = await collectArxivDay(
      "2026-10-26",
      async (url) => {
        urls.push(url);
        return ok(feed, "2026-10-29T12:00:00.000Z");
      },
      allow,
    );
    expect(new URL(urls[0]!).searchParams.get("search_query")).toBe(
      "(cat:cs.AI OR cat:cs.CL OR cat:cs.SE OR cat:cs.LG) AND submittedDate:[202610260000 TO 202610270000]",
    );
    expect(urls).toHaveLength(1);
    expect(early.items.map((item) => item.id)).toEqual([
      "itm_arxiv_2610.90001",
      "itm_arxiv_2610.90002",
    ]);
    expect(early.items[0]).toMatchObject({
      permalink: "https://arxiv.org/abs/2610.90001v1",
      author: "Ada Example",
      title: "Tool-Using Agents Under Budget Constraints",
      body: "We study agents that call tools with a fixed budget & report costs. Code: https://github.com/Example/Budget-Agents.",
      entities: ["github:example/budget-agents"],
    });
    expect(early.items[1]?.entities).toEqual(["github:example/review-bench"]);
    expect(early.coverage).toMatchObject({ status: "partial", items: 2 });
    expect(early.coverage?.note).toContain("4-day announcement lag");
    const late = await collectArxivDay(
      "2026-10-26",
      async () => ok(feed, "2026-10-31T00:00:00.000Z"),
      allow,
    );
    expect(late.coverage).toMatchObject({ status: "complete", items: 2, note: null });
  });
  it("leaves the day unavailable without a data request when robots.txt disallows it", async () => {
    const data = vi.fn<GetResponse>();
    const result = await collectArxivDay(
      "2026-10-26",
      data,
      robotsFrom({ "export.arxiv.org": "User-agent: * \nDisallow: /\n" }),
    );
    expect(data).not.toHaveBeenCalled();
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).toMatch(/^robots_disallowed: /);
  });
});

describe("Wikipedia", () => {
  it("keeps the top list and skips summaries that en.wikipedia.org robots.txt disallows", async () => {
    const top = await json("wikipedia-top-2026-10-29.json");
    const urls: Array<string> = [];
    const result = await collectWikipediaDay(
      "2026-10-29",
      async (url) => {
        urls.push(url);
        return ok(top);
      },
      robotsFrom({
        "en.wikipedia.org": "User-agent: *\nAllow: /api/rest_v1/?doc\nDisallow: /api/\n",
      }),
    );
    expect(urls).toEqual([wikipediaTopUrl("2026-10-29")]);
    // 15 ranked rows less Main_Page, Special:Search and Wikipedia:Featured_pictures.
    expect(result.items).toHaveLength(12);
    expect(result.items[0]).toMatchObject({
      id: "itm_wikipedia_2026-10-29_p0002",
      title: "Patrick Stewart",
      published_at: "2026-10-29T00:00:00.000Z",
      author: null,
      entities: ["wikipedia:Patrick_Stewart"],
    });
    expect(result.coverage).toMatchObject({ status: "complete", items: 12 });
    expect(result.coverage?.note).toContain("summaries skipped: robots_disallowed");
  });
  it("adds summaries where robots.txt allows them", async () => {
    const top = await json("wikipedia-top-2026-10-29.json");
    const summary = await json("wikipedia-summary.json");
    const get = vi.fn<GetResponse>(async (url) =>
      ok(new URL(url).hostname === "en.wikipedia.org" ? summary : top),
    );
    const result = await collectWikipediaDay("2026-10-29", get, allow);
    expect(get).toHaveBeenCalledTimes(13);
    expect(result.items[0]?.body).toContain(summary.extract.slice(0, 40));
    expect(result.coverage?.note).toContain("summaries 12/12, 0 not found");
  });
  it("marks a day whose top list is not published yet unavailable", async () => {
    const result = await collectWikipediaDay(
      "2026-10-29",
      async () => ({ observed_at: observed, status: 404, body: null }),
      allow,
    );
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).toContain("not published yet");
  });
});

describe("Stack Exchange", () => {
  it("files both sites' questions in their creation day, tags first", async () => {
    const ai = await json("stackexchange-ai-2026-10-29.json");
    const urls: Array<string> = [];
    const result = await collectStackExchangeDay(
      "2026-10-29",
      async (url) => {
        urls.push(url);
        return ok(
          new URL(url).searchParams.get("site") === "ai" ? ai : { items: [], has_more: false },
        );
      },
      allow,
    );
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]!).searchParams.get("fromdate")).toBe(
      String(Date.parse("2026-10-29T00:00:00Z") / 1000),
    );
    expect(result.items.map((item) => item.id)).toEqual(["itm_se_ai_50824", "itm_se_ai_50827"]);
    expect(result.items[0]?.body).toMatch(/^Tags: hardware, hardware-evaluation\. If I want/);
    expect(result.coverage).toMatchObject({
      status: "complete",
      items: 2,
      note: "questions stackoverflow=0, ai=2",
    });
  });
  it("is partial when a site hits the 300-question cap", async () => {
    const ai = await json("stackexchange-ai-2026-10-29.json");
    const result = await collectStackExchangeDay(
      "2026-10-29",
      async (url) =>
        ok(
          new URL(url).searchParams.get("site") === "ai"
            ? { ...ai, has_more: true }
            : { items: [], has_more: false },
        ),
      allow,
    );
    expect(result.coverage?.status).toBe("partial");
    expect(result.coverage?.note).toContain("ai capped at 300 questions by score");
  });
  it("waits for a throttle declared in the body of a 400 and of a 200", async () => {
    // After the day ends, so the day is not partial for being unfinished.
    let clock = Date.parse("2026-10-31T00:00:00Z");
    const waits: Array<number> = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          {
            error_id: 502,
            error_name: "throttle_violation",
            error_message: "too many requests from this IP, more requests available in 20 seconds",
          },
          400,
        ),
      )
      .mockResolvedValueOnce(response({ items: [], has_more: false, backoff: 10 }))
      .mockResolvedValue(response({ items: [], has_more: false }));
    const get = createHttpClient("stackexchange", {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      throttle: stackExchangeThrottle,
    });
    const result = await collectStackExchangeDay("2026-10-29", get, allow);
    expect(result.coverage?.status).toBe("complete");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([21_500, 10_500]);
  });
});

describe("npm", () => {
  it("keeps the day's releases of known packages, at least 500 weekly downloads", async () => {
    const page = await json("npm-keywords-mcp.json");
    const fresh = structuredClone(page.objects[0]);
    fresh.package.name = "mcp-fresh-tool";
    fresh.downloads.weekly = 12;
    const urls: Array<string> = [];
    const result = await collectNpmDay(
      "2026-10-23",
      async (url) => {
        urls.push(url);
        return ok(
          new URL(url).searchParams.get("text") === "keywords:mcp"
            ? { ...page, objects: [...page.objects, fresh] }
            : { objects: [], total: 0 },
        );
      },
      allow,
    );
    expect(urls).toHaveLength(5);
    expect(result.items.map((item) => item.title)).toEqual([
      "@modelcontextprotocol/sdk 1.32.2",
      "@modelcontextprotocol/core 2.4.0",
      "@modelcontextprotocol/server 2.4.0",
      "@modelcontextprotocol/client 2.4.0",
    ]);
    expect(result.items[0]).toMatchObject({
      id: "itm_npm_@modelcontextprotocol/sdk@1.32.2",
      // Trusted-publisher releases name the first maintainer instead of "GitHub Actions".
      author: "jspahrsummers",
      external_url: "https://github.com/modelcontextprotocol/typescript-sdk",
      entities: ["github:modelcontextprotocol/typescript-sdk"],
    });
    expect(result.coverage).toMatchObject({ status: "partial", items: 4 });
    expect(result.coverage?.note).toContain("below=1");
  });
});

describe("npm search pages", () => {
  it("reads each page once per collect run and robots.txt once per day", async () => {
    let clock = Date.parse("2026-10-31T00:00:00Z");
    const urls: Array<string> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      urls.push(String(url));
      return new URL(String(url)).pathname === "/robots.txt"
        ? new Response("", { status: 404 })
        : response({ objects: [], total: 0 });
    });
    const [adapter] = liveSources(["npm"], {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    await adapter!.collectDay("2026-10-28");
    const second = await adapter!.collectDay("2026-10-29");
    expect(urls.filter((url) => url.endsWith("/robots.txt"))).toHaveLength(2);
    expect(urls.filter((url) => url.includes("/-/v1/search"))).toHaveLength(NPM_QUERIES.length);
    expect(second.coverage).toMatchObject({ status: "partial", items: 0 });
  });
});

describe("Bluesky", () => {
  it("keeps posts whose own text names a term; the permalink keeps the DID", async () => {
    const page = await json("bluesky-2026-10-29.json");
    const urls: Array<string> = [];
    const result = await collectBlueskyDay(
      "2026-10-29",
      async (url) => {
        urls.push(url);
        return ok(
          new URL(url).searchParams.get("q") === "llm" ? page : { posts: [], hitsTotal: 0 },
        );
      },
      allow,
    );
    expect(urls).toHaveLength(BLUESKY_TERMS.length);
    expect(BLUESKY_TERMS).not.toContain("ai");
    expect(result.items.map((item) => item.id)).toEqual([
      "itm_bsky_plc_exampleauthortwo_3mzbbbbbbbb2b",
      "itm_bsky_plc_exampleauthorone_3mzaaaaaaaa2a",
    ]);
    expect(result.items[1]).toMatchObject({
      permalink: "https://bsky.app/profile/did:plc:exampleauthorone/post/3mzaaaaaaaa2a",
      author: "one.example.test",
      published_at: "2026-10-29T10:00:00.000Z",
      body: "Shipped a small LLM eval harness today",
      external_url: "https://github.com/example/eval-harness",
      entities: ["github:example/eval-harness"],
    });
    expect(result.coverage).toMatchObject({ status: "complete", items: 2 });
    expect(result.coverage?.note).toContain("dropped_without_term_in_text=1");
  });
  it("spends a busy term's request budget evenly across the day", async () => {
    const windows: Array<[string, string]> = [];
    const result = await collectBlueskyDay(
      "2026-10-29",
      async (url) => {
        const params = new URL(url).searchParams;
        if (params.get("q") === "llm") windows.push([params.get("since")!, params.get("until")!]);
        return ok({ posts: [], cursor: "next", hitsTotal: 5000 });
      },
      allow,
    );
    expect(windows).toHaveLength(BLUESKY_MAX_REQUESTS_PER_TERM);
    expect(windows[1]?.[0]).toBe("2026-10-29T00:00:00.000Z");
    expect(windows.at(-1)?.[1]).toBe("2026-10-30T00:00:00.000Z");
    expect(result.coverage?.status).toBe("partial");
  });
});
