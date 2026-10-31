// @effect-diagnostics nodeBuiltinImport:off globalDate:off - recorded Hub responses replayed through the plain adapter.
import * as NodeFSP from "node:fs/promises";
import { afterEach, describe, it, expect, vi } from "vite-plus/test";
import { huggingfaceCollector, hfModelsUrl } from "./huggingface.ts";
import { createHttpClient, MAX_RESPONSE_BYTES, type GetResponse } from "./http.ts";
import { markdownText } from "./shared.ts";

const observed = "2026-10-31T04:00:00.000Z";
const NEXT = `${hfModelsUrl()}&cursor=page2`;
async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await NodeFSP.readFile(new URL(`../testkit/${name}`, import.meta.url), "utf8"),
  ) as T;
}
const CARD = [
  "---",
  "license: apache-2.0",
  "tags: [vae]",
  "---",
  "# Primal VAE",
  "",
  "A **VAE** for [diffusion models](https://example.com/x).",
  "",
  "![chart](https://example.com/c.png)",
  "```python",
  "import torch",
  "```",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
].join("\n");

/** Replays the recorded Hub listing (two pages), Daily Papers for 2026-10-30 and one model card. */
async function recordedHub() {
  const pages = await fixture<{ page1: unknown[]; page2: unknown[] }>("hf-models-pages.json");
  const papers = await fixture<unknown[]>("hf-daily-papers-2026-10-30.json");
  const calls: Array<string> = [];
  const get: GetResponse = async (url) => {
    calls.push(url);
    const ok = (body: unknown, next: string | null = null) => ({
      observed_at: observed,
      status: 200,
      body,
      next,
    });
    if (url === hfModelsUrl()) return ok(pages.page1, NEXT);
    if (url === NEXT) return ok(pages.page2);
    if (url.includes("/api/daily_papers?date=2026-10-30&")) return ok(papers);
    if (url.includes("/api/daily_papers?")) return ok([]);
    if (url === "https://huggingface.co/ostris/primal_vae/resolve/main/README.md") return ok(CARD);
    return { observed_at: observed, status: 404, body: null };
  };
  return { get, calls };
}

describe("Hugging Face source", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("walks the model listing once across days and selects liked models of each day", async () => {
    const { get, calls } = await recordedHub();
    const collect = huggingfaceCollector();
    const later = await collect("2026-10-31", get);
    expect(later.items.map((item) => item.id)).toEqual([
      "itm_hf_model_jgod123/DeepSeek-V4.1-Flash-UNCENSORED-FP8",
    ]);
    expect(calls.filter((url) => url.includes("/api/models?"))).toHaveLength(1);

    const day = await collect("2026-10-30", get);
    expect(calls.filter((url) => url.includes("/api/models?"))).toEqual([hfModelsUrl(), NEXT]);
    const models = day.items.filter((item) => item.id.startsWith("itm_hf_model_"));
    // Unliked models never enter; order in the corpus is by creation time.
    expect(models.map((item) => item.title).toSorted()).toEqual([
      "SeightCZE/ABA_1-0.12B",
      "guideboardlabs/SenseNova-Loop-9B-Preview-GGUF",
      "ostris/primal_vae",
      "shkelqim2026/EfficientNet",
      "starrydark/Tricolour_Lovestory_Qwen3_TTS",
    ]);
    const vae = models.find((item) => item.title === "ostris/primal_vae")!;
    expect(vae).toMatchObject({
      source: "huggingface",
      permalink: "https://huggingface.co/ostris/primal_vae",
      external_url: null,
      published_at: "2026-10-30T20:40:00.000Z",
      author: "ostris",
      retrieved_at: observed,
    });
    expect(vae.body).toBe("Primal VAE A VAE for diffusion models. a b 1 2");
    // Without a card the tags without a namespace describe the model.
    expect(models.find((item) => item.author === "SeightCZE")!.body).not.toContain("region:");

    const papers = day.items.filter((item) => item.id.startsWith("itm_hf_paper_"));
    expect(papers).toHaveLength(3);
    for (const paper of papers) {
      expect(paper.published_at).toBe("2026-10-30T00:00:00.000Z");
      expect(paper.permalink).toMatch(/^https:\/\/huggingface\.co\/papers\//);
      expect(paper.external_url).toMatch(/^https:\/\/arxiv\.org\/abs\//);
      expect(paper.body.length).toBeGreaterThan(0);
    }
    expect(day.coverage).toMatchObject({ source: "huggingface", status: "partial", items: 8 });
    expect(day.coverage?.note).toContain("papers: 3");
    expect(day.coverage?.note).toContain("models: selected=5, cards missing=4");
    expect(day.coverage?.note).toContain("model listing ended before the day start");
  });

  it("keeps the papers when the model listing fails and goes unavailable when both fail", async () => {
    const { get } = await recordedHub();
    const brokenModels = async (url: string, format?: "json" | "text") =>
      url.includes("/api/models?")
        ? { observed_at: observed, status: 500, body: null }
        : get(url, format);
    const half = await huggingfaceCollector()("2026-10-30", brokenModels);
    expect(half.coverage).toMatchObject({ status: "partial", items: 3 });
    expect(half.coverage?.note).toContain("models unavailable: HTTP 500");

    const none = await huggingfaceCollector()("2026-10-30", async () => ({
      observed_at: observed,
      status: 503,
      body: null,
    }));
    expect(none.coverage).toMatchObject({ status: "unavailable", items: 0 });
  });

  it("refuses a pagination link outside the Hub model listing", async () => {
    const { get } = await recordedHub();
    const result = await huggingfaceCollector()("2026-10-30", async (url, format) => {
      const response = await get(url, format);
      return url === hfModelsUrl() ? { ...response, next: "https://evil.example/api" } : response;
    });
    expect(result.coverage?.note).toContain("models unavailable: Unexpected Hub pagination link");
  });

  it("paces Hub requests, honors Retry-After and the RateLimit reset, and sends the token", async () => {
    vi.stubEnv("HF_TOKEN", "hf_secret_token");
    const waits: Array<number> = [];
    let clock = Date.parse(observed);
    const headers: Array<Headers> = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      headers.push(new Headers(init?.headers));
      const n = headers.length;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "70" } });
      if (n === 2)
        return Response.json([], { headers: { ratelimit: '"api";r=0;t=120' } });
      return Response.json([]);
    });
    const get = createHttpClient("huggingface", {
      fetch: fetcher,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    expect((await get(hfModelsUrl())).status).toBe(200);
    expect((await get(hfModelsUrl())).status).toBe(200);
    // 70 s from Retry-After, then the 120 s quota window plus the 1.5 s margin.
    expect(waits).toEqual([70_000, 121_500]);
    expect(headers[0]!.get("authorization")).toBe("Bearer hf_secret_token");
    expect(headers[0]!.get("user-agent")).toMatch(/^Earlyscript\/[\d.]+ \(\+https:\/\//);
  });

  it("paces anonymous Hub requests at 700 ms", async () => {
    vi.stubEnv("HF_TOKEN", "");
    const waits: Array<number> = [];
    let clock = 0;
    const get = createHttpClient("huggingface", {
      fetch: async () => Response.json([]),
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await get(hfModelsUrl());
    await get(hfModelsUrl());
    expect(waits).toEqual([700]);
  });

  it("keeps a model whose card exceeds the byte limit and notes the reason", async () => {
    const { get } = await recordedHub();
    let aborted = false;
    const big = createHttpClient("huggingface", {
      fetch: async (_url, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Response("x".repeat(MAX_RESPONSE_BYTES.huggingface + 1));
      },
      sleep: async () => undefined,
    });
    const result = await huggingfaceCollector()("2026-10-30", async (url, format) =>
      url.includes("/resolve/main/README.md") ? big(url, format) : get(url, format),
    );
    expect(aborted).toBe(true);
    expect(MAX_RESPONSE_BYTES.huggingface).toBe(2 * 1024 * 1024);
    expect(result.items.filter((item) => item.id.startsWith("itm_hf_model_"))).toHaveLength(5);
    expect(result.coverage?.note).toContain("model card: response_too_large");
  });

  it("turns a model card into plain text", () => {
    expect(markdownText("---\na: 1\n---\n## Usage\n> note\n- item one\n~~~\ncode\n~~~\nend")).toBe(
      "Usage note item one end",
    );
    expect(markdownText("```\nunterminated")).toBe("");
  });
});

const live = process.env.EARLYSCRIPT_LIVE_TESTS === "1";
// Network gate: the day is that of the newest model, so the walk stays within one or two pages.
describe.skipIf(!live)("Hugging Face source (live)", () => {
  it("collects the current day from the public Hub", async () => {
    const get = createHttpClient("huggingface");
    const newest = (await get(hfModelsUrl())).body as Array<{ createdAt: string }>;
    const result = await huggingfaceCollector()(newest[0]!.createdAt.slice(0, 10), get);
    expect(result.coverage?.status).toBe("partial");
    expect(result.coverage?.note).not.toContain("unavailable");
    expect(result.items.length).toBeGreaterThan(0);
  });
});
