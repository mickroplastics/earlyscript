// @effect-diagnostics nodeBuiltinImport:off - a local HTTP server stands in for hostile feeds.
// Regressions from Sol's review of a5ec1257fb (H1 redirects, H2 depth, H3 roots, H4 excerpts,
// H6 entities), reproduced with ~/earlyscript-data/sources-lobsters-rss-verify/*.mjs.
import * as NodeHttp from "node:http";
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import type { RssFeed } from "@earlyscript/editorial-contracts/source";
import { collectRssDay, EXCERPT_CHARS, feedBody, validateFeed } from "./rss.ts";
import { followRedirects, MAX_REDIRECTS } from "./robots.ts";
import { liveSources } from "./index.ts";
import { MAX_XML_DEPTH, parseXml, XmlError } from "./xml.ts";
import { createHttpClient, credentialHeaders, type FrozenResponse } from "./http.ts";

const day = "2026-10-29";
const now = "2026-10-31T00:00:00.000Z";
const feed: RssFeed = {
  id: "test",
  name: "Test",
  feedUrl: "https://test.example/feed",
  siteUrl: "https://test.example/",
  license: "",
};
const item = (inner: string, date = "Thu, 29 Oct 2026 12:00:00 GMT") =>
  `<item><title>A &amp; B &mdash; C</title><link>https://test.example/a</link><pubDate>${date}</pubDate>${inner}</item>`;
const older = item("<description>old</description>", "Wed, 28 Oct 2026 12:00:00 GMT");
const rss = (items: string) => `<rss><channel><title>T</title>${items}${older}</channel></rss>`;
const collect = (body: string) =>
  collectRssDay(
    day,
    {
      feeds: [feed],
      get: async (): Promise<FrozenResponse> => ({ status: 200, body, observed_at: now }),
      robots: async () => null,
      cache: new Map(),
    },
    now,
  );

type Route = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void;
const servers: Array<NodeHttp.Server> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});
/** A local server with a request trace; `routes` maps paths to handlers, anything else 404s. */
async function serve(routes: Record<string, Route>) {
  const trace: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    trace.push(request.url ?? "");
    const route = routes[request.url ?? ""];
    if (route) route(request, response);
    else {
      response.statusCode = 404;
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { origin, trace };
}
const text =
  (body: string, status = 200): Route =>
  (_request, response) => {
    response.statusCode = status;
    response.end(body);
  };
const redirect =
  (location: string, status = 302): Route =>
  (_request, response) => {
    response.writeHead(status, { Location: location });
    response.end();
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
const collectFrom = (feedUrl: string) =>
  liveSources(["rss"], quietClock(), {
    rssFeeds: [{ ...feed, feedUrl, siteUrl: feedUrl }],
  })[0]!.collectDay(day);

describe("H1: redirects are followed by hand and gated by robots.txt on every hop", () => {
  it("never downloads a path robots.txt forbids behind an allowed URL", async () => {
    const { origin, trace } = await serve({
      "/robots.txt": text("User-agent: *\nAllow: /feed\nDisallow: /"),
      "/feed": redirect("/private"),
      "/private": text("PROHIBIDO"),
    });
    const result = await collectFrom(`${origin}/feed`);
    expect(trace).toEqual(["/robots.txt", "/feed"]);
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).toContain("robots_disallowed");
    expect(await validateFeed(`${origin}/feed`, quietClock())).toMatchObject({
      ok: false,
      error: "robots-disallowed",
    });
  });
  it("follows an allowed cross-host redirect after reading the target host's robots.txt", async () => {
    const target = await serve({
      "/robots.txt": text("User-agent: *\nDisallow: /private"),
      "/feed.xml": text(rss(item("<description>moved</description>"))),
    });
    const source = await serve({
      "/robots.txt": text("", 404),
      "/feed": redirect(`${target.origin}/feed.xml`, 301),
    });
    const result = await collectFrom(`${source.origin}/feed`);
    expect(source.trace).toEqual(["/robots.txt", "/feed"]);
    expect(target.trace).toEqual(["/robots.txt", "/feed.xml"]);
    expect(result.coverage).toMatchObject({ status: "complete", items: 1 });
  });
  it("follows redirects of robots.txt itself and stops after five content redirects", async () => {
    const loop: Record<string, Route> = {
      "/robots.txt": redirect("/robots-real.txt", 301),
      "/robots-real.txt": text("User-agent: *\nDisallow: /secret"),
    };
    for (let hop = 0; hop <= MAX_REDIRECTS + 1; hop++) loop[`/r${hop}`] = redirect(`/r${hop + 1}`);
    const { origin, trace } = await serve(loop);
    const result = await collectFrom(`${origin}/r0`);
    expect(trace.slice(0, 2)).toEqual(["/robots.txt", "/robots-real.txt"]);
    expect(trace.filter((path) => /^\/r\d+$/.test(path))).toEqual(
      Array.from({ length: MAX_REDIRECTS + 1 }, (_, hop) => `/r${hop}`),
    );
    expect(result.coverage?.note).toContain(`More than ${MAX_REDIRECTS} redirects`);
  });
  it("gates redirects of the API sources too", async () => {
    const hops: Array<string> = [];
    const get = followRedirects(
      () => async (url) => {
        hops.push(url);
        return { observed_at: now, status: 302, body: null, location: "https://other.example/x" };
      },
      async (url) => `robots_disallowed: ${url}`,
    );
    await expect(get("https://hn.algolia.com/api/v1/search")).rejects.toThrow(
      "robots_disallowed: https://other.example/x",
    );
    expect(hops).toEqual(["https://hn.algolia.com/api/v1/search"]);
  });
});

describe("R1: credentials stay on the origin that issued them", () => {
  it("drops the GitHub token on a redirect to another host and on robots.txt", async () => {
    vi.stubEnv("GITHUB_TOKEN", "SYNTHETIC-REVIEW-TOKEN");
    try {
      const seen: Array<[string, string | null]> = [];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        const href = String(url);
        seen.push([href, new Headers(init?.headers).get("authorization")]);
        if (href.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /");
        if (new URL(href).host === "api.github.com")
          return new Response(null, {
            status: 302,
            headers: { location: "https://untrusted.example/search" },
          });
        return new Response(
          JSON.stringify({ total_count: 0, incomplete_results: false, items: [] }),
        );
      });
      const [github] = liveSources(["github"], { fetch: fetcher, ...quietClock() });
      await github!.collectDay(day);
      expect(
        seen.map(([url, auth]) => [new URL(url).origin + new URL(url).pathname, auth]),
      ).toEqual([
        ["https://api.github.com/search/repositories", "Bearer SYNTHETIC-REVIEW-TOKEN"],
        ["https://untrusted.example/robots.txt", null],
        ["https://untrusted.example/search", null],
      ]);
      // A robots.txt on the credential's own origin is anonymous too.
      const direct: Array<string | null> = [];
      await createHttpClient("github", {
        fetch: async (_url, init) => {
          direct.push(new Headers(init?.headers).get("authorization"));
          return new Response("{}");
        },
      })("https://api.github.com/robots.txt");
      expect(direct).toEqual([null]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("binds a credential to scheme, host and port", () => {
    const credential = { origin: "https://api.example", headers: { Authorization: "Bearer t" } };
    expect(credentialHeaders(credential, "https://api.example/x")).toEqual(credential.headers);
    for (const url of [
      "http://api.example/x",
      "https://api.example:8443/x",
      "https://api.example.evil/x",
      "https://sub.api.example/x",
      "https://api.example/robots.txt",
    ])
      expect(credentialHeaders(credential, url), url).toEqual({});
  });
});

describe("H2/H3: hostile XML fails alone with XmlError", () => {
  it("rejects 15,000 nested elements without a RangeError and keeps the capture alive", async () => {
    const deep = rss(
      item(`<description>${"<b>".repeat(15_000)}x${"</b>".repeat(15_000)}</description>`),
    );
    expect(() => parseXml(deep)).toThrow(XmlError);
    const result = await collect(deep);
    expect(result.coverage).toMatchObject({ status: "unavailable", items: 0 });
    expect(result.coverage?.note).toContain(`deeper than ${MAX_XML_DEPTH}`);
  });
  it("counts self-closing leaves against the depth limit", () => {
    const nest = (depth: number, leaf: string) =>
      `${"<a>".repeat(depth)}${leaf}${"</a>".repeat(depth)}`;
    expect(() => parseXml(nest(MAX_XML_DEPTH - 1, "<b/>"))).not.toThrow();
    expect(() => parseXml(nest(MAX_XML_DEPTH, "<b/>"))).toThrow(`deeper than ${MAX_XML_DEPTH}`);
    expect(() => parseXml(nest(MAX_XML_DEPTH, ""))).not.toThrow();
    expect(() => parseXml(nest(MAX_XML_DEPTH + 1, ""))).toThrow(XmlError);
  });
  it("rejects a second root and text outside the root", async () => {
    const two = rss(item("<description>ok</description>")) + "<other/>";
    expect(() => parseXml(two)).toThrow("Second root element <other>");
    expect(() => parseXml(`${rss("")} trailing`)).toThrow("Text outside the root element");
    expect(() => parseXml(`<![CDATA[x]]>${rss("")}`)).toThrow(XmlError);
    expect((await collect(two)).coverage).toMatchObject({ status: "unavailable", items: 0 });
    // Prolog, comments and processing instructions around the root stay valid.
    expect(
      parseXml(`<?xml version="1.0"?>\n<!-- c --><!DOCTYPE rss>${rss("")}<!-- end -->`).name,
    ).toBe("rss");
  });
});

describe("H4: bodies are excerpts, never whole articles", () => {
  it("prefers the summary, falls back to a 500-character cut of the content", async () => {
    const article = `<p>${"word ".repeat(400)}</p>`;
    const result = await collect(
      "﻿" +
        rss(
          item(
            "<guid>g1</guid><description><![CDATA[<b>Hello</b> &nbsp; world]]></description>",
            "Thu, 29 Oct 2026 10:00:00 GMT",
          ) +
            item(
              `<guid>g2</guid><content:encoded><![CDATA[${article}]]></content:encoded>`,
              "Thu, 29 Oct 2026 11:00:00 GMT",
            ) +
            item(
              `<guid>g3</guid><description>short</description><content:encoded>FULL</content:encoded>`,
              "Thu, 29 Oct 2026 12:00:00 GMT",
            ),
        ),
    );
    expect(result.items.map((entry) => [entry.body.length, entry.body_kind])).toEqual([
      [11, "summary"],
      [EXCERPT_CHARS, "content"],
      [5, "summary"],
    ]);
    expect(result.items[1]).toMatchObject({ body_length: 1999, truncated: true });
    expect(result.items.every((entry) => entry.feed_url === feed.feedUrl)).toBe(true);
  });
  it("cuts a summary that is itself a whole post", () => {
    expect(feedBody({ summary: "x".repeat(3000), content: "" })).toEqual({
      body: "x".repeat(EXCERPT_CHARS),
      body_length: 3000,
      truncated: true,
      body_kind: "summary",
    });
    expect(feedBody({ summary: "", content: "short article" })).toMatchObject({
      body: "short article",
      body_kind: "content",
      truncated: false,
    });
  });
});

describe("H6: common HTML entities", () => {
  it("decodes named entities in titles and double-escaped HTML bodies", async () => {
    const result = await collect(
      rss(
        item(
          "<description>&lt;p&gt;It&amp;rsquo;s &amp;ldquo;done&amp;rdquo;&amp;hellip; &amp;copy; &amp;trade; &amp;laquo;x&amp;raquo; 1&amp;ndash;2&lt;/p&gt;</description>",
        ),
      ),
    );
    expect(result.items[0]).toMatchObject({
      title: "A & B — C",
      body: "It’s “done”… © ™ «x» 1–2",
    });
  });
});
