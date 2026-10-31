// @effect-diagnostics globalDate:off nodeBuiltinImport:off - plain async library with native fetch and UTC timestamps.
// Adapted from Earlywindow src/engine/sources/http.ts: pacing, shared quota blocks and bounded waits.
import * as NodeTimersPromises from "node:timers/promises";

export interface FrozenResponse {
  readonly observed_at: string;
  readonly status: number;
  /** Parsed JSON (or the text when asked for `text`) for 2xx responses; null otherwise. */
  readonly body: unknown;
  /** Target of a `Link: <...>; rel="next"` header, for cursor pagination. */
  readonly next?: string | null;
}
export type GetResponse = (url: string, format?: "json" | "text") => Promise<FrozenResponse>;
/** Messages that start with `rate_limited:` or `response_too_large:` carry that reason into the coverage note. */
export class SourceFailure extends Error {}
export interface HttpOptions {
  readonly fetch?: typeof fetch;
  /** Monotonic milliseconds aligned with the epoch; tests inject a simulated clock. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly dayTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}
/** Shared by every day of one source, so pacing and quota blocks survive the day boundary. */
export interface SourceState {
  nextStart: number;
  blockedUntil: number;
}

/** Contact for providers that ask clients to identify themselves (dev.to requires a user-agent). */
export const COLLECTOR_USER_AGENT = "Earlyscript/0.1.5 (+https://git.r.biste.cc/miguel/earlyscript)";

/**
 * Per-host request policy: one request at a time, `pauseMs` between request starts,
 * `maxBytes` per body and `dayBudgetMs` per collected day.
 */
const HOSTS = {
  hn: { pauseMs: 250, maxBytes: 4 * 1024 * 1024, dayBudgetMs: 300_000 },
  github: { pauseMs: 6500, maxBytes: 2 * 1024 * 1024, dayBudgetMs: 300_000 },
  // Anonymous Hub API quota: 500 requests per 5-minute window per IP, 1000 with a free token.
  huggingface: { pauseMs: 700, maxBytes: 2 * 1024 * 1024, dayBudgetMs: 600_000 },
  // Unpublished limits; the beta reference states 10 requests per 30 seconds.
  devto: { pauseMs: 3000, maxBytes: 4 * 1024 * 1024, dayBudgetMs: 900_000 },
} as const;
export type HttpSource = keyof typeof HOSTS;

/**
 * Largest accepted body. An HN page holds at most 1000 hits with unbounded story text;
 * a GitHub search page holds 100 repositories; a Hub page holds 1000 models (about 350 KiB)
 * or 100 daily papers; a dev.to page holds 1000 article summaries (about 2.2 MiB).
 * Larger bodies are aborted, not parsed.
 */
export const MAX_RESPONSE_BYTES: Readonly<Record<HttpSource, number>> = Object.fromEntries(
  Object.entries(HOSTS).map(([source, host]) => [source, host.maxBytes]),
) as Record<HttpSource, number>;

function requestHeaders(source: HttpSource): Record<string, string> {
  switch (source) {
    case "github": {
      const token = process.env.GITHUB_TOKEN;
      return {
        "User-Agent": "Earlyscript-academic-collector",
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
    }
    case "huggingface": {
      const token = process.env.HF_TOKEN;
      return {
        "User-Agent": COLLECTOR_USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
    }
    case "devto":
      return { "User-Agent": COLLECTOR_USER_AGENT, Accept: "application/vnd.forem.api-v1+json" };
    default:
      return { "User-Agent": "Earlyscript-academic-collector" };
  }
}

/** `Link: <url>; rel="next"` (RFC 8288), as the Hub uses for cursor pagination. */
function nextLink(header: string | null): string | null {
  for (const part of header?.split(",") ?? []) {
    const match = /^\s*<([^>]+)>\s*;.*\brel="?next"?/.exec(part);
    if (match) return match[1]!;
  }
  return null;
}

/** IETF draft `RateLimit: "api";r=<remaining>;t=<seconds to reset>`, sent by the Hub. */
function rateLimitHeader(header: string | null): { remaining: number; resetMs: number } | null {
  const remaining = /(?:^|;)\s*r=(\d+)/.exec(header ?? "");
  const reset = /(?:^|;)\s*t=(\d+)/.exec(header ?? "");
  return remaining && reset
    ? { remaining: Number(remaining[1]), resetMs: Number(reset[1]) * 1000 }
    : null;
}

const monotonic = () => performance.timeOrigin + performance.now();

async function readBounded(response: Response, controller: AbortController, max: number) {
  const tooLarge = () => {
    controller.abort();
    return new SourceFailure(`response_too_large: body over ${max} bytes`);
  };
  if (Number(response.headers.get("content-length")) > max) throw tooLarge();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
}

export function createHttpClient(
  source: HttpSource,
  options: HttpOptions = {},
  state: SourceState = { nextStart: 0, blockedUntil: 0 },
): GetResponse {
  const now = options.now ?? monotonic;
  const wall = options.now ?? Date.now;
  const wait = options.sleep ?? NodeTimersPromises.setTimeout;
  const fetcher = options.fetch ?? fetch;
  const host = HOSTS[source];
  const deadline = now() + (options.dayTimeoutMs ?? host.dayBudgetMs);
  const pause =
    source === "huggingface" && process.env.HF_TOKEN ? host.pauseMs / 2 : host.pauseMs;
  const headers = requestHeaders(source);
  async function delay(ms: number, limited: boolean) {
    if (now() + ms >= deadline)
      throw new SourceFailure(
        limited
          ? "rate_limited: quota block exceeds the day time budget"
          : "Day time budget exhausted",
      );
    if (ms > 0) await wait(ms);
  }
  return async (url, format = "json") => {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const blocked = state.blockedUntil - now();
      await delay(Math.max(0, state.nextStart - now(), blocked), blocked > 0);
      const remaining = deadline - now();
      if (remaining <= 0) throw new SourceFailure("Day time budget exhausted");
      state.nextStart = now() + pause;
      const controller = new AbortController();
      let response: Response;
      try {
        response = await fetcher(url, {
          headers,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(
              Math.max(1, Math.min(remaining, options.requestTimeoutMs ?? 45_000)),
            ),
          ]),
        });
      } catch {
        if (attempt === 3) throw new SourceFailure("Network, timeout or invalid JSON response");
        await delay(1000 * 2 ** attempt, false);
        continue;
      }
      // Status and headers first: a quota refusal rarely carries a JSON body.
      const quotaLeft = response.headers.get("x-ratelimit-remaining");
      const retry = response.headers.get("retry-after");
      const resetHeader = response.headers.get("x-ratelimit-reset");
      const limited =
        response.status === 429 ||
        (response.status === 403 && (quotaLeft === "0" || retry !== null));
      const retryMs =
        retry === null
          ? 0
          : /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - wall());
      if (Number.isFinite(retryMs) && retryMs > 0 && limited)
        state.blockedUntil = Math.max(state.blockedUntil, now() + retryMs);
      const resetMs = Number(resetHeader) * 1000 - wall();
      if (resetHeader !== null && Number.isFinite(resetMs) && (limited || quotaLeft === "0"))
        state.blockedUntil = Math.max(state.blockedUntil, now() + resetMs + 1500);
      const quotaWindow = rateLimitHeader(response.headers.get("ratelimit"));
      if (quotaWindow && (limited || quotaWindow.remaining === 0))
        state.blockedUntil = Math.max(state.blockedUntil, now() + quotaWindow.resetMs + 1500);
      if (limited || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        if (attempt === 3)
          throw new SourceFailure(
            `${limited ? "rate_limited: " : ""}HTTP ${response.status}; retry limit reached`,
          );
        await delay(
          Math.max(
            1000 * 2 ** attempt,
            limited ? 60_000 : 0,
            state.blockedUntil - now(),
            state.nextStart - now(),
          ),
          limited,
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { observed_at: new Date(wall()).toISOString(), status: response.status, body: null };
      }
      const next = nextLink(response.headers.get("link"));
      let body: unknown;
      try {
        const text = await readBounded(response, controller, host.maxBytes);
        body = format === "text" ? text : JSON.parse(text);
      } catch (error) {
        if (error instanceof SourceFailure) throw error;
        if (attempt === 3) throw new SourceFailure("Network, timeout or invalid JSON response");
        await delay(1000 * 2 ** attempt, false);
        continue;
      }
      return { observed_at: new Date(wall()).toISOString(), status: response.status, body, next };
    }
    throw new SourceFailure("Retry limit reached");
  };
}
