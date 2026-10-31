import { describe, expect, it } from "vite-plus/test";

import { createHttpClient, type HttpTraceEntry, USER_AGENT } from "./http.ts";

describe("HTTP trace", () => {
  it("records a 429, the wait it applied and the 200 that followed, without secrets", async () => {
    let clock = Date.parse("2026-10-31T00:00:00Z");
    const responses = [
      new Response("busy", { status: 429, headers: { "Retry-After": "2" } }),
      new Response(JSON.stringify({ objects: [] }), { status: 200 }),
    ];
    const sent: Array<Headers> = [];
    const entries: Array<HttpTraceEntry> = [];
    const get = createHttpClient("npm", {
      fetch: async (_url, init) => {
        sent.push(new Headers(init?.headers));
        return responses.shift()!;
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      trace: (entry) => entries.push(entry),
      robotsDecision: () => "allowed",
    });
    const response = await get(
      "https://registry.npmjs.org/-/v1/search?text=keywords%3Aai&api_key=SECRET123",
    );
    expect(response.status).toBe(200);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      source: "npm",
      method: "GET",
      host: "registry.npmjs.org",
      path: "/-/v1/search",
      attempt: 1,
      max_attempts: 4,
      status: 429,
      retry_after: "2",
      wait_ms: 0,
      user_agent: USER_AGENT,
      robots: "allowed",
    });
    // A 429 waits at least a minute before the retry; the trace keeps that wait.
    expect(entries[1]).toMatchObject({
      attempt: 2,
      status: 200,
      retry_after: null,
      wait_ms: 60_000,
    });
    expect(Date.parse(entries[1]!.at) - Date.parse(entries[0]!.at)).toBe(60_000);
    expect(entries[0]!.query).toBe("text=keywords%3Aai&api_key=%5Bredacted%5D");
    expect(sent[0]!.get("user-agent")).toBe(USER_AGENT);
    const text = JSON.stringify(entries);
    expect(text).not.toContain("SECRET123");
    expect(text.toLowerCase()).not.toContain("authorization");
  });

  it("records a network failure with no status", async () => {
    let clock = 0;
    const entries: Array<HttpTraceEntry> = [];
    let calls = 0;
    const get = createHttpClient("wikipedia", {
      fetch: async () => {
        if (calls++ === 0) throw new TypeError("fetch failed");
        return new Response("{}", { status: 200 });
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      trace: (entry) => entries.push(entry),
    });
    await get("https://wikimedia.org/api/rest_v1/metrics/pageviews/top/x");
    expect(entries.map((e) => [e.attempt, e.status, e.error, e.robots])).toEqual([
      [1, null, "network_or_timeout", "not-gated"],
      [2, 200, null, "not-gated"],
    ]);
    expect(entries[1]!.wait_ms).toBe(1000);
  });
});
