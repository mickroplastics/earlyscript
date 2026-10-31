// @effect-diagnostics globalDate:off nodeBuiltinImport:off - plain async library with native fetch and UTC timestamps.
// Adapted from Earlywindow src/engine/sources/http.ts: pacing, shared quota blocks and bounded waits.
import * as NodeTimersPromises from "node:timers/promises";

export interface FrozenResponse {
  readonly observed_at: string;
  readonly status: number;
  /** Parsed JSON (or raw text for text sources) for 2xx responses; null otherwise. */
  readonly body: unknown;
  /** Validators of a 2xx response, replayed as If-None-Match / If-Modified-Since. */
  readonly etag?: string | null;
  readonly last_modified?: string | null;
  /** `Location` of a 3xx: the client never follows redirects itself (see robots.ts). */
  readonly location?: string | null;
}
export type GetResponse = (
  url: string,
  headers?: Readonly<Record<string, string>>,
) => Promise<FrozenResponse>;
/** Messages that start with `rate_limited:` or `response_too_large:` carry that reason into the coverage note. */
export class SourceFailure extends Error {}
export interface HttpOptions {
  readonly fetch?: typeof fetch;
  /** Monotonic milliseconds aligned with the epoch; tests inject a simulated clock. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly dayTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Return 2xx bodies as text instead of JSON (feeds, robots.txt); default only for `rss`. */
  readonly text?: boolean;
}
/** Shared by every day of one source, so pacing and quota blocks survive the day boundary. */
export interface SourceState {
  nextStart: number;
  blockedUntil: number;
}

/**
 * Largest accepted body. An HN page holds at most 1000 hits with unbounded story text;
 * a GitHub search page holds 100 repositories; a Lobsters page 25 stories; the largest
 * curated feed measured on 31 October 2026 was 2.6 MB. Larger bodies are aborted, not parsed.
 */
export const MAX_RESPONSE_BYTES = {
  hn: 4 * 1024 * 1024,
  github: 2 * 1024 * 1024,
  lobsters: 1024 * 1024,
  rss: 4 * 1024 * 1024,
} as const;
export type HttpSource = keyof typeof MAX_RESPONSE_BYTES;

/** Minimum gap between two request starts of one client (one host for RSS). */
export const PAUSE_MS: Readonly<Record<HttpSource, number>> = {
  hn: 250,
  github: 6500,
  lobsters: 2000,
  rss: 1000,
};

/** Collector name, protocol version and contact, as polite crawlers identify themselves. */
export const USER_AGENT = "Earlyscript/0.1 (+https://github.com/miwgel)";

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
  const deadline = now() + (options.dayTimeoutMs ?? 300_000);
  const pause = PAUSE_MS[source];
  const token = source === "github" ? process.env.GITHUB_TOKEN : undefined;
  async function delay(ms: number, limited: boolean) {
    if (now() + ms >= deadline)
      throw new SourceFailure(
        limited
          ? "rate_limited: quota block exceeds the day time budget"
          : "Day time budget exhausted",
      );
    if (ms > 0) await wait(ms);
  }
  return async (url, extraHeaders = {}) => {
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
          headers: {
            "User-Agent": USER_AGENT,
            ...(source === "github" ? { Accept: "application/vnd.github+json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...extraHeaders,
          },
          // A redirect could lead to a path robots.txt forbids; followRedirects gates each hop.
          redirect: "manual",
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
        return {
          observed_at: new Date(wall()).toISOString(),
          status: response.status,
          body: null,
          location: response.headers.get("location"),
        };
      }
      let body: unknown;
      try {
        const text = await readBounded(response, controller, MAX_RESPONSE_BYTES[source]);
        // Feeds and robots.txt are text; the JSON APIs are parsed here.
        body = (options.text ?? source === "rss") ? text : JSON.parse(text);
      } catch (error) {
        if (error instanceof SourceFailure) throw error;
        if (attempt === 3) throw new SourceFailure("Network, timeout or invalid JSON response");
        await delay(1000 * 2 ** attempt, false);
        continue;
      }
      return {
        observed_at: new Date(wall()).toISOString(),
        status: response.status,
        body,
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
      };
    }
    throw new SourceFailure("Retry limit reached");
  };
}
