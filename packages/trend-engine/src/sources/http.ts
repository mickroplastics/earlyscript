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
  /** Target of a `Link: <...>; rel="next"` header, for cursor pagination. */
  readonly next?: string | null;
  /** Seconds a shared cache held the response (`Age`); 0 when absent. */
  readonly age?: number;
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
  /** Return 2xx bodies as text (feeds, model cards, robots.txt); default only for `rss`. */
  readonly text?: boolean;
  /** A throttle the provider declares in its JSON body, read on 2xx and 4xx responses. */
  readonly throttle?: (body: unknown) => DeclaredThrottle;
  /** Never attach the source's credentials (robots.txt clients). */
  readonly anonymous?: boolean;
}
/** Stack Exchange declares backoff and quota in the body instead of in headers. */
export interface DeclaredThrottle {
  /** Milliseconds before the next request may start; 0 for none. */
  readonly blockMs: number;
  /** This response is a refusal and is retried after the block. */
  readonly limited: boolean;
}

/** Secret headers of a source, bound to the one origin (scheme, host and port) that issued them. */
export interface Credential {
  readonly origin: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Credentials per source, read when a client is created. Each keyed source (GITHUB_TOKEN,
 * HF_TOKEN) has its entry here; credentialHeaders keeps it on its origin.
 */
export const CREDENTIALS: Partial<Record<HttpSource, () => Credential | null>> = {
  github: () =>
    process.env.GITHUB_TOKEN
      ? {
          origin: "https://api.github.com",
          headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
        }
      : null,
  huggingface: () =>
    process.env.HF_TOKEN
      ? {
          origin: "https://huggingface.co",
          headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` },
        }
      : null,
};

/**
 * Headers a request to `url` may carry: the credential's own only on its exact origin and
 * never for robots.txt, so a redirect to another host, or that host's robots.txt, gets none.
 */
export function credentialHeaders(
  credential: Credential | null,
  url: string,
): Readonly<Record<string, string>> {
  if (!credential) return {};
  const target = new URL(url);
  return target.origin === credential.origin && target.pathname !== "/robots.txt"
    ? credential.headers
    : {};
}
/** Shared by every day of one source, so pacing and quota blocks survive the day boundary. */
export interface SourceState {
  nextStart: number;
  blockedUntil: number;
}

/**
 * Largest accepted body; larger ones are aborted, not parsed. Pages: HN 1000 hits, GitHub 100
 * repositories, Lobsters 25 stories, Hub 1000 models (~350 KiB); the largest curated feed
 * measured on 31 October 2026 was 2.6 MB.
 */
export const MAX_RESPONSE_BYTES = {
  hn: 4 * 1024 * 1024,
  github: 2 * 1024 * 1024,
  lobsters: 1024 * 1024,
  rss: 4 * 1024 * 1024,
  huggingface: 2 * 1024 * 1024,
  // One page each: 200 arXiv abstracts, a 1000-article top list, 100 questions with
  // bodies, 250 npm search results, 100 Bluesky posts.
  arxiv: 4 * 1024 * 1024,
  wikipedia: 2 * 1024 * 1024,
  stackexchange: 4 * 1024 * 1024,
  npm: 4 * 1024 * 1024,
  bluesky: 2 * 1024 * 1024,
} as const;
export type HttpSource = keyof typeof MAX_RESPONSE_BYTES;

/** Minimum gap between two request starts of one client (one host for RSS). */
export const PAUSE_MS: Readonly<Record<HttpSource, number>> = {
  hn: 250,
  github: 6500,
  lobsters: 2000,
  rss: 1000,
  // arXiv API terms: one request every three seconds on a single connection.
  arxiv: 3000,
  wikipedia: 400,
  stackexchange: 1000,
  npm: 1000,
  bluesky: 1000,
  // Anonymous Hub API quota: 500 requests per 5-minute window per IP; halved with HF_TOKEN.
  huggingface: 700,
};

/** Time budget per collected day where 5 minutes is short: a listing walked back from today. */
const DAY_TIMEOUT_MS: Partial<Record<HttpSource, number>> = {
  huggingface: 600_000,
};

/** Stack Exchange throttles in the body: `backoff` seconds, a daily `quota_remaining` and error 502 `throttle_violation`. */
export function stackExchangeThrottle(body: unknown): DeclaredThrottle {
  const se: {
    backoff?: unknown;
    quota_remaining?: unknown;
    error_name?: unknown;
    error_message?: unknown;
  } = typeof body === "object" && body !== null ? body : {};
  const available =
    typeof se.error_message === "string"
      ? /available in (\d+) seconds/.exec(se.error_message)
      : null;
  return {
    blockMs: Math.max(
      0,
      typeof se.backoff === "number" ? se.backoff * 1000 + 500 : 0,
      se.quota_remaining === 0 ? 86_400_000 : 0,
      available ? Number(available[1]) * 1000 + 1500 : 0,
    ),
    limited: se.error_name === "throttle_violation",
  };
}

/** Throttles declared in response bodies, per source. */
const DECLARED_THROTTLES: Partial<Record<HttpSource, (body: unknown) => DeclaredThrottle>> = {
  stackexchange: stackExchangeThrottle,
};

/** Collector name, protocol version and contact, as polite crawlers identify themselves. */
export const USER_AGENT = "Earlyscript/0.1 (+https://github.com/miwgel)";

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
  const deadline = now() + (options.dayTimeoutMs ?? DAY_TIMEOUT_MS[source] ?? 300_000);
  const credential = options.anonymous ? null : (CREDENTIALS[source]?.() ?? null);
  // A Hub token doubles the anonymous API quota.
  const pause = source === "huggingface" && credential ? PAUSE_MS[source] / 2 : PAUSE_MS[source];
  async function delay(ms: number, limited: boolean) {
    if (now() + ms >= deadline)
      throw new SourceFailure(
        limited
          ? "rate_limited: quota block exceeds the day time budget"
          : "Day time budget exhausted",
      );
    if (ms > 0) await wait(ms);
  }
  const throttle = options.throttle ?? DECLARED_THROTTLES[source];
  /** Applies a body-declared block to the shared state and returns it. */
  function declare(text: string): DeclaredThrottle {
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body declares nothing.
    }
    const declared = throttle!(body);
    if (declared.blockMs > 0)
      state.blockedUntil = Math.max(state.blockedUntil, now() + declared.blockMs);
    return declared;
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
            ...extraHeaders,
            // Last: on its own origin the credential wins over any caller header.
            ...credentialHeaders(credential, url),
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
        let declared: DeclaredThrottle = { blockMs: 0, limited: false };
        // A 4xx of a declared-throttle API carries its refusal and its wait in the JSON body.
        if (throttle) {
          const text = await readBounded(response, controller, MAX_RESPONSE_BYTES[source]).catch(
            (error: unknown) => {
              if (error instanceof SourceFailure) throw error;
              return "";
            },
          );
          declared = declare(text);
        } else await response.body?.cancel().catch(() => undefined);
        if (declared.limited) {
          if (attempt === 3)
            throw new SourceFailure(`rate_limited: HTTP ${response.status}; retry limit reached`);
          await delay(Math.max(1000 * 2 ** attempt, state.blockedUntil - now()), true);
          continue;
        }
        return {
          observed_at: new Date(wall()).toISOString(),
          status: response.status,
          body: null,
          location: response.headers.get("location"),
        };
      }
      const next = nextLink(response.headers.get("link"));
      let body: unknown;
      try {
        const text = await readBounded(response, controller, MAX_RESPONSE_BYTES[source]);
        // Feeds, model cards and robots.txt are text; the JSON APIs are parsed here.
        body = (options.text ?? source === "rss") ? text : JSON.parse(text);
        if (throttle) declare(text);
      } catch (error) {
        if (error instanceof SourceFailure) throw error;
        if (attempt === 3) throw new SourceFailure("Network, timeout or invalid JSON response");
        await delay(1000 * 2 ** attempt, false);
        continue;
      }
      const age = Number(response.headers.get("age"));
      return {
        observed_at: new Date(wall()).toISOString(),
        status: response.status,
        body,
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        next,
        age: Number.isFinite(age) && age > 0 ? age : 0,
      };
    }
    throw new SourceFailure("Retry limit reached");
  };
}
