// @effect-diagnostics nodeBuiltinImport:off - recorded responses read from the testkit.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import type { CoverageStatus, SourceId } from "@earlyscript/editorial-contracts/source";
import { collectLobstersDay, lobstersPageUrl, LOBSTERS_MAX_PAGES } from "./lobsters.ts";
import { collectRssDay, parseFeed, validateFeed } from "./rss.ts";
import { readRssFeedList, RSS_FEEDS, type RssFeed } from "./rss-feeds.ts";
import { robotsAllows, robotsGate, robotsRules } from "./robots.ts";
import { parseXml, XmlError } from "./xml.ts";
import { USER_AGENT, type FrozenResponse, type GetResponse } from "./http.ts";
import { liveSources, SOURCES } from "./index.ts";
import { collectCorpus } from "../collect.ts";
import { coverageSummary, type CoverageIndex } from "../series.ts";

const day = "2026-10-30";
const now = "2026-10-31T12:00:00.000Z";
const testkit = (name: string) =>
  NodeFSP.readFile(new URL(`../testkit/${name}`, import.meta.url), "utf8");
const ok = (body: unknown, extra: Partial<FrozenResponse> = {}): FrozenResponse => ({
  observed_at: now,
  status: 200,
  body,
  ...extra,
});
const allow = async () => null;
const LOBSTERS_ROBOTS = `User-agent: Applebot
User-agent: GoogleBot
Allow: /
Disallow: /search

Content-Signal: ai-input=no, ai-train=no, search=yes

User-agent: *
Crawl-delay: 1
Disallow: /
`;
const older = (page: ReadonlyArray<Record<string, unknown>>) => [
  { ...page[0], short_id: "zzzold", created_at: "2026-10-29T18:00:00.000-05:00" },
];

describe("lobsters", () => {
  it("keeps the day's stories, tags in the body, and completes once a page passes the day", async () => {
    const page = JSON.parse(await testkit("lobsters-newest-page.json"));
    const urls: Array<string> = [];
    const result = await collectLobstersDay(
      day,
      async (url) => {
        urls.push(url);
        return ok(url === lobstersPageUrl(1) ? page : older(page));
      },
      allow,
      now,
    );
    expect(urls).toEqual([lobstersPageUrl(1), lobstersPageUrl(2)]);
    // 95quqz was created at 02:32 UTC on 31 October; zzzold on the 29th.
    expect(result.items.map((item) => item.id)).toEqual([
      "itm_lob_u7dsbx",
      "itm_lob_xudbqx",
      "itm_lob_spv7tb",
      "itm_lob_cctbcu",
      "itm_lob_1pmuy7",
    ]);
    const self = result.items.find((item) => item.id === "itm_lob_spv7tb")!;
    expect(self).toMatchObject({
      source: "lobsters",
      permalink: "https://lobste.rs/s/spv7tb/rationale_for_filtering_llm_usage_links",
      external_url: null,
      author: "facundoolano",
      published_at: "2026-10-30T16:49:53.919Z",
      retrieved_at: now,
    });
    expect(self.body).toMatch(/^Hi, I've been following .*\n\nTags: ask, meta$/s);
    expect(result.items[3]).toMatchObject({
      external_url: "https://delta.dev/blog/fine-grained-version-control-for-agents",
      body: "Tags: ai, vcs",
    });
    expect(result.coverage).toEqual({
      source: "lobsters",
      day,
      status: "complete",
      items: 5,
      retrieved_at: now,
      note: null,
    });
  });
  it("is partial when pagination stops before the day start or a later page fails", async () => {
    const page = JSON.parse(await testkit("lobsters-newest-page.json"));
    const inside = page.slice(1);
    const capped = await collectLobstersDay(day, async () => ok(inside), allow, now);
    expect(capped.coverage).toMatchObject({ status: "partial", items: 5 });
    expect(capped.coverage?.note).toContain(`after ${LOBSTERS_MAX_PAGES} pages`);
    const broken = await collectLobstersDay(
      day,
      async (url) => (url === lobstersPageUrl(1) ? ok(page) : { ...ok(null), status: 500 }),
      allow,
      now,
    );
    expect(broken.coverage).toMatchObject({ status: "partial", items: 5, note: "HTTP 500" });
    const invalid = await collectLobstersDay(day, async () => ok({ nope: true }), allow, now);
    expect(invalid.coverage).toMatchObject({ status: "unavailable", items: 0 });
  });
  it("marks a day still running at retrieval as partial", async () => {
    const page = JSON.parse(await testkit("lobsters-newest-page.json"));
    const result = await collectLobstersDay(
      day,
      async (url) => ({
        ...ok(url === lobstersPageUrl(1) ? page : older(page)),
        observed_at: "2026-10-30T23:00:00.000Z",
      }),
      allow,
    );
    expect(result.coverage).toMatchObject({ status: "partial", items: 5 });
    expect(result.coverage?.note).toBe("Day not finished at retrieval");
  });
  it("respects robots.txt: lobste.rs disallows unnamed agents, so no JSON page is requested", async () => {
    const requested: Array<string> = [];
    const get: GetResponse = async (url) => {
      requested.push(url);
      return url.endsWith("/robots.txt") ? ok(LOBSTERS_ROBOTS) : ok([]);
    };
    const result = await collectLobstersDay(
      day,
      get,
      robotsGate(() => get, new Map()),
      now,
    );
    expect(requested).toEqual(["https://lobste.rs/robots.txt"]);
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).toMatch(/^robots_disallowed: /);
  });
  it("paces Lobsters at 2 s through the same client as its robots.txt", async () => {
    const page = JSON.parse(await testkit("lobsters-newest-page.json"));
    let clock = Date.parse(now);
    const waits: Array<number> = [];
    const agents = new Set<string | null>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      agents.add(new Headers(init?.headers).get("user-agent"));
      if (String(url).endsWith("/robots.txt")) return new Response("missing", { status: 404 });
      const body = String(url) === lobstersPageUrl(1) ? page : older(page);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const [adapter] = liveSources(["lobsters"], {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const result = await adapter!.collectDay(day);
    expect(result.coverage).toMatchObject({ status: "complete", items: 5 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 2000]);
    expect([...agents]).toEqual([USER_AGENT]);
  });
});

describe("robots.txt", () => {
  it("applies the agent's own group, else `*`, with the longest rule and Allow on ties", () => {
    const lobsters = robotsRules(LOBSTERS_ROBOTS);
    expect(robotsAllows(lobsters, lobstersPageUrl(1))).toBe(false);
    expect(robotsAllows(robotsRules(LOBSTERS_ROBOTS, "applebot"), lobstersPageUrl(1))).toBe(true);
    const own = robotsRules("User-agent: *\nDisallow: /\n\nUser-agent: Earlyscript\nDisallow:\n");
    expect(robotsAllows(own, "https://a.example/feed")).toBe(true);
    const rules = robotsRules(
      "User-agent: *\nDisallow: /feed/private\nDisallow: /*.json$\nAllow: /feed/private/ok\n",
    );
    expect(robotsAllows(rules, "https://a.example/feed")).toBe(true);
    expect(robotsAllows(rules, "https://a.example/feed/private/x")).toBe(false);
    expect(robotsAllows(rules, "https://a.example/feed/private/ok")).toBe(true);
    expect(robotsAllows(rules, "https://a.example/x.json")).toBe(false);
    expect(robotsAllows(rules, "https://a.example/x.json?x=1")).toBe(true);
  });
  it("treats a 4xx robots.txt as no rules and a 5xx as a refusal", async () => {
    const cache = new Map();
    const missing = robotsGate(() => async () => ({ ...ok(null), status: 404 }), cache);
    expect(await missing("https://a.example/feed")).toBeNull();
    const down = robotsGate(() => async () => ({ ...ok(null), status: 503 }), new Map());
    expect(await down("https://a.example/feed")).toMatch(/^robots_unavailable: /);
  });
});

const latent = RSS_FEEDS.find((feed) => feed.id === "latent-space")!;
const simon = RSS_FEEDS.find((feed) => feed.id === "simonwillison")!;
async function feedsGet(overrides: Record<string, FrozenResponse> = {}) {
  const bodies: Record<string, string> = {
    [latent.feedUrl]: await testkit("rss-sample.xml"),
    [simon.feedUrl]: await testkit("atom-sample.xml"),
  };
  return (url: string) => async () => overrides[url] ?? ok(bodies[url]);
}

describe("rss", () => {
  it("parses RSS 2.0 and Atom entries with dates, links and authors", async () => {
    const rss = parseFeed(await testkit("rss-sample.xml"), latent.feedUrl);
    expect(rss.map((entry) => entry.author)).toEqual(["swyx", "Alessio Fanelli", null]);
    expect(rss[0]).toMatchObject({
      link: "https://www.latent.space/p/agents-repo",
      title: "Agents that read your repo & ship",
      published: Date.parse("2026-10-30T15:04:00Z"),
    });
    expect(rss[0]!.summary).toContain("<b>repository maps</b> &amp; tests");
    const atom = parseFeed(await testkit("atom-sample.xml"), simon.feedUrl);
    expect(atom.map((entry) => entry.link)).toEqual([
      "https://simonwillison.net/2026/Oct/30/skills/",
      "https://simonwillison.net/2026/Oct/30/quote/",
      "https://simonwillison.net/2026/Oct/28/older/",
    ]);
    // published wins over updated; updated stands in when there is no published.
    expect(atom.map((entry) => entry.published)).toEqual([
      Date.parse("2026-10-30T22:00:00Z"),
      Date.parse("2026-10-30T14:30:00Z"),
      Date.parse("2026-10-28T12:00:00Z"),
    ]);
    expect(atom[1]!.title).toBe("Quoting someone");
    expect(() => parseFeed("<html><body>no feed</body></html>", simon.feedUrl)).toThrow(XmlError);
    expect(() => parseXml("<rss><channel></rss>")).toThrow(XmlError);
  });
  it("keeps the day's entries of every feed and completes when all feeds reach back", async () => {
    const result = await collectRssDay(
      day,
      { feeds: [latent, simon], getFor: await feedsGet(), robots: allow, cache: new Map() },
      now,
    );
    expect(result.items.map((item) => [item.title, item.author])).toEqual([
      ["Quoting someone", simon.name],
      ["Agents that read your repo & ship", "swyx"],
      ["Claude Code skills, a quick look", "Simon Willison"],
      ["Local models — a field guide", "Alessio Fanelli"],
    ]);
    const local = result.items[3]!;
    expect(local.id).toMatch(/^itm_rss_latent-space_[0-9a-f]{16}$/);
    expect(local).toMatchObject({
      source: "rss",
      permalink: "https://www.latent.space/p/local-models",
      external_url: "https://www.latent.space/p/local-models",
      body: "Running Qwen on a laptop, see https://github.com/ollama/ollama",
      published_at: "2026-10-30T23:59:59.000Z",
    });
    expect(result.items[1]!.body).toBe("How coding agents use repository maps & tests.");
    expect(result.coverage).toEqual({
      source: "rss",
      day,
      status: "complete",
      items: 4,
      retrieved_at: now,
      note: "feeds=2 responded=2",
    });
  });
  it("lists failed and short feeds as partial and is unavailable when no feed answers", async () => {
    const down = { ...ok(null), status: 404 };
    const partial = await collectRssDay(
      day,
      {
        feeds: [latent, simon],
        getFor: await feedsGet({ [simon.feedUrl]: down }),
        robots: allow,
        cache: new Map(),
      },
      now,
    );
    expect(partial.coverage).toMatchObject({ status: "partial", items: 2 });
    expect(partial.coverage?.note).toBe("feeds=2 responded=1; failed: simonwillison (HTTP 404)");
    // On the 28th the Atom sample holds nothing older: entries may have rotated out.
    const short = await collectRssDay(
      "2026-10-28",
      { feeds: [simon], getFor: await feedsGet(), robots: allow, cache: new Map() },
      now,
    );
    expect(short.coverage).toMatchObject({ status: "partial", items: 1 });
    expect(short.coverage?.note).toContain("window_short: simonwillison");
    const none = await collectRssDay(
      day,
      {
        feeds: [latent, simon],
        getFor: await feedsGet({
          [latent.feedUrl]: ok("<html>moved</html>"),
          [simon.feedUrl]: down,
        }),
        robots: async () => "robots_disallowed: test",
        cache: new Map(),
      },
      now,
    );
    expect(none.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(none.coverage?.note).toContain("latent-space (robots_disallowed: test)");
  });
  it("revalidates with ETag and Last-Modified, reuses a 304 body and paces each host at 1 s", async () => {
    let clock = Date.parse(now);
    const waits: Array<number> = [];
    const sample = await testkit("atom-sample.xml");
    const conditional: Array<string> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith("/robots.txt")) return new Response("", { status: 404 });
      const headers = new Headers(init?.headers);
      if (headers.get("if-none-match") === '"v1"') {
        conditional.push(`${headers.get("if-modified-since")}`);
        return new Response(null, { status: 304 });
      }
      return new Response(sample, {
        status: 200,
        headers: { etag: '"v1"', "last-modified": "Fri, 30 Oct 2026 22:00:00 GMT" },
      });
    });
    const [adapter] = liveSources(["rss"], {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const first = await adapter!.collectDay(day);
    const hosts = new Set(RSS_FEEDS.map((feed) => new URL(feed.feedUrl).host)).size;
    // robots.txt then the feed on each host: one 1 s pause per host, none across hosts.
    expect(waits).toEqual(Array.from({ length: hosts }, () => 1000));
    expect(first.coverage).toMatchObject({ status: "complete", items: 2 * RSS_FEEDS.length });
    const second = await adapter!.collectDay(day);
    expect(conditional).toHaveLength(RSS_FEEDS.length);
    expect(conditional[0]).toBe("Fri, 30 Oct 2026 22:00:00 GMT");
    expect(second.items.map((item) => item.id)).toEqual(first.items.map((item) => item.id));
    // robots.txt is read once per origin for the whole run.
    expect(fetcher).toHaveBeenCalledTimes(hosts + 2 * RSS_FEEDS.length);
  });
  it("lists 10 to 15 feeds with unique ids, https URLs and a license note", () => {
    expect(RSS_FEEDS.length).toBeGreaterThanOrEqual(10);
    expect(RSS_FEEDS.length).toBeLessThanOrEqual(15);
    expect(new Set(RSS_FEEDS.map((feed: RssFeed) => feed.id)).size).toBe(RSS_FEEDS.length);
    for (const feed of RSS_FEEDS) {
      expect(feed.id).toMatch(/^[a-z0-9-]+$/);
      expect(feed.feedUrl).toMatch(/^https:\/\//);
      expect(feed.license.length).toBeGreaterThan(0);
    }
    expect(SOURCES.rss.selection.rss).toBe(RSS_FEEDS.map((feed) => feed.feedUrl).join(" "));
  });
});

describe("coverage and gaps", () => {
  it("writes corpus/1 rows and reports partial and failed days as gaps, never as zero", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lobsters-rss-"));
    try {
      const atom = await testkit("atom-sample.xml");
      let clock = Date.parse(now);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
        const href = String(url);
        if (href.endsWith("/robots.txt"))
          return href.startsWith("https://lobste.rs")
            ? new Response(LOBSTERS_ROBOTS, { status: 200 })
            : new Response("", { status: 404 });
        return href === simon.feedUrl ? new Response(atom) : new Response("", { status: 410 });
      });
      const options = {
        fetch: fetcher,
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      };
      const rows = await collectCorpus({
        dir: root,
        from: day,
        to: "2026-10-31",
        adapters: liveSources(["lobsters", "rss"], options),
      });
      expect(rows.map((row) => [row.source, row.status, row.items])).toEqual([
        ["lobsters", "unavailable", 0],
        ["rss", "partial", 2],
      ]);
      const coverage: CoverageIndex = new Map(
        rows.map((row) => [row.source, new Map<string, CoverageStatus>([[row.day, row.status]])]),
      );
      const sources: Array<SourceId> = ["lobsters", "rss"];
      expect(coverageSummary(coverage, sources, [day, "2026-10-31"]).data_gaps).toEqual([
        { source: "lobsters", day, reason: "fetch_failed" },
        { source: "lobsters", day: "2026-10-31", reason: "not_collected" },
        { source: "rss", day, reason: "partial" },
        { source: "rss", day: "2026-10-31", reason: "not_collected" },
      ]);
      expect(await NodeFSP.readFile(NodePath.join(root, "lobsters", `${day}.jsonl`), "utf8")).toBe(
        "",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe("user feeds", () => {
  const custom: RssFeed = {
    id: "my-blog",
    name: "My Blog",
    feedUrl: "https://blog.example.org/atom.xml",
    siteUrl: "https://blog.example.org/",
    license: "",
  };
  const quietClock = () => {
    let clock = Date.parse(now);
    return {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    };
  };
  it("collects a user list instead of the built-in one, under the same `rss` source", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rss-user-"));
    try {
      const atom = await testkit("atom-sample.xml");
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).endsWith("/robots.txt")
            ? new Response("", { status: 404 })
            : new Response(atom),
        );
      const adapters = liveSources(
        ["rss"],
        { fetch: fetcher, ...quietClock() },
        {
          rssFeeds: [custom],
        },
      );
      expect(adapters[0]!.descriptor).toMatchObject({
        id: "rss",
        selection: { rss: custom.feedUrl },
      });
      const rows = await collectCorpus({ dir: root, from: day, to: "2026-10-31", adapters });
      expect(rows).toMatchObject([{ source: "rss", status: "complete", items: 2 }]);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        "https://blog.example.org/robots.txt",
        custom.feedUrl,
      ]);
      const lines = (await NodeFSP.readFile(NodePath.join(root, "rss", `${day}.jsonl`), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines.map((item) => item.id)).toEqual([
        expect.stringMatching(/^itm_rss_my-blog_[0-9a-f]{16}$/),
        expect.stringMatching(/^itm_rss_my-blog_[0-9a-f]{16}$/),
      ]);
      expect(lines[0].author).toBe("My Blog");
      const manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(root, "corpus-manifest.json"), "utf8"),
      );
      expect(manifest.selection.rss).toBe(custom.feedUrl);
      // Without a list the built-in feeds stay the default.
      expect(liveSources(["rss"])[0]!.descriptor).toEqual(SOURCES.rss);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("reads --rss-feeds files and rejects invalid lists", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rss-list-"));
    const write = async (name: string, text: string) => {
      const file = NodePath.join(root, name);
      await NodeFSP.writeFile(file, text);
      return file;
    };
    try {
      const good = [custom, { ...custom, id: "other", feedUrl: "https://b.example/rss", why: "x" }];
      expect(await readRssFeedList(await write("good.json", JSON.stringify(good)))).toEqual(good);
      // The built-in list satisfies the same schema.
      expect(await readRssFeedList(await write("builtin.json", JSON.stringify(RSS_FEEDS)))).toEqual(
        RSS_FEEDS,
      );
      const bad = {
        "notjson.json": "{",
        "empty.json": "[]",
        "dup-id.json": JSON.stringify([custom, { ...custom, feedUrl: "https://c.example/rss" }]),
        "dup-url.json": JSON.stringify([custom, { ...custom, id: "again" }]),
        "bad-url.json": JSON.stringify([{ ...custom, feedUrl: "file:///etc/passwd" }]),
        "bad-id.json": JSON.stringify([{ ...custom, id: "My Blog" }]),
        "missing.json": JSON.stringify([{ id: "x", name: "X", feedUrl: custom.feedUrl }]),
      };
      for (const [name, text] of Object.entries(bad))
        await expect(readRssFeedList(await write(name, text)), name).rejects.toThrow();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("validates a feed URL: title, entries and newest date, or a typed error", async () => {
    const atom = await testkit("atom-sample.xml");
    const agents = new Set<string | null>();
    const serve = (routes: Record<string, () => Response>) =>
      vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        agents.add(new Headers(init?.headers).get("user-agent"));
        const route = routes[String(url)];
        if (route) return route();
        if (String(url).endsWith("/robots.txt")) return new Response("", { status: 404 });
        throw new TypeError("fetch failed");
      });
    const options = (routes: Record<string, () => Response>) => ({
      fetch: serve(routes),
      ...quietClock(),
    });
    const url = "https://feeds.example/atom.xml";
    expect(await validateFeed(url, options({ [url]: () => new Response(atom) }))).toEqual({
      ok: true,
      url,
      title: "Simon Willison's Weblog",
      entries: 3,
      latest: "2026-10-30T22:00:00.000Z",
    });
    const rss = await validateFeed(
      url,
      options({ [url]: () => new Response(`<rss><channel><title>Empty</title></channel></rss>`) }),
    );
    expect(rss).toEqual({ ok: true, url, title: "Empty", entries: 0, latest: null });
    expect(
      await validateFeed(url, options({ [url]: () => new Response("<html><p>hi</p></html>") })),
    ).toMatchObject({ ok: false, error: "not-a-feed" });
    expect(
      await validateFeed(url, options({ [url]: () => new Response("not xml at all <") })),
    ).toMatchObject({ ok: false, error: "not-a-feed" });
    const disallowed = await validateFeed(
      url,
      options({
        "https://feeds.example/robots.txt": () => new Response("User-agent: *\nDisallow: /\n"),
        [url]: () => new Response(atom),
      }),
    );
    expect(disallowed).toMatchObject({ ok: false, error: "robots-disallowed" });
    expect(
      await validateFeed(url, options({ [url]: () => new Response("", { status: 404 }) })),
    ).toMatchObject({ ok: false, error: "unreachable", message: "HTTP 404" });
    expect(await validateFeed(url, options({}))).toMatchObject({
      ok: false,
      error: "unreachable",
    });
    expect(await validateFeed("ftp://feeds.example/x", options({}))).toMatchObject({
      ok: false,
      error: "unreachable",
    });
    expect(await validateFeed("not a url", options({}))).toMatchObject({
      ok: false,
      error: "unreachable",
    });
    expect([...agents]).toEqual([USER_AGENT]);
  });
});

const live = process.env.EARLYSCRIPT_LIVE_TESTS === "1";
describe.skipIf(!live)("live network (EARLYSCRIPT_LIVE_TESTS=1)", () => {
  // A fixed recent day keeps wall-clock reads out of tests; override for a fresh check.
  const liveDay = process.env.EARLYSCRIPT_LIVE_DAY ?? day;
  it("collects the live day from Lobsters or records why it may not", async () => {
    const [adapter] = liveSources(["lobsters"]);
    const result = await adapter!.collectDay(liveDay);
    expect(result.coverage?.source).toBe("lobsters");
    // While lobste.rs/robots.txt disallows unnamed agents, the day is unavailable by design.
    if (result.coverage?.note?.startsWith("robots_disallowed"))
      expect(result.coverage.status).toBe("unavailable");
    else expect(result.coverage?.items).toBeGreaterThan(0);
  });
  it("collects the live day from the curated feeds", async () => {
    const [adapter] = liveSources(["rss"]);
    const result = await adapter!.collectDay(liveDay);
    expect(result.coverage?.status).not.toBe("unavailable");
    expect(result.coverage?.note).toMatch(/^feeds=\d+ responded=\d+/);
  });
  it("validates a real feed and refuses lobste.rs by robots.txt", async () => {
    expect(await validateFeed(simon.feedUrl)).toMatchObject({ ok: true });
    expect(await validateFeed("https://lobste.rs/newest.rss")).toMatchObject({
      ok: false,
      error: "robots-disallowed",
    });
  });
});
