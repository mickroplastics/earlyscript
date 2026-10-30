// @effect-diagnostics globalDate:off nodeBuiltinImport:off - plain async library with native fetch and UTC timestamps.
// Adapted from Earlywindow src/engine/sources/http.ts: pacing and bounded quota waits.
import * as NodeTimersPromises from "node:timers/promises";

export interface FrozenResponse {
  readonly observed_at: string;
  readonly status: number;
  readonly body: unknown;
}
export type GetResponse = (url: string) => Promise<FrozenResponse>;
export class SourceFailure extends Error {}
export interface HttpOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly dayTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export function createHttpClient(
  source: "hn" | "github",
  options: HttpOptions = {},
  pacing = { nextStart: 0 },
): GetResponse {
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? NodeTimersPromises.setTimeout;
  const fetcher = options.fetch ?? fetch;
  const deadline = now() + (options.dayTimeoutMs ?? 300_000);
  const pause = source === "github" ? 6500 : 250;
  const token = source === "github" ? process.env.GITHUB_TOKEN : undefined;
  async function delay(ms: number) {
    if (now() + ms >= deadline) throw new SourceFailure("Day time budget exhausted");
    if (ms > 0) await wait(ms);
  }
  return async (url) => {
    for (let attempt = 0; attempt <= 3; attempt++) {
      await delay(Math.max(0, pacing.nextStart - now()));
      const remaining = deadline - now();
      if (remaining <= 0) throw new SourceFailure("Day time budget exhausted");
      pacing.nextStart = now() + pause;
      let response: Response;
      let body: unknown;
      try {
        response = await fetcher(url, {
          headers: {
            "User-Agent": "Earlyscript-academic-collector",
            ...(source === "github" ? { Accept: "application/vnd.github+json" } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(remaining, options.requestTimeoutMs ?? 45_000)),
          ),
        });
        body = await response.json();
      } catch {
        if (attempt === 3) throw new SourceFailure("Network, timeout or invalid JSON response");
        await delay(1000 * 2 ** attempt);
        continue;
      }
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            response.headers.has("retry-after")));
      const retry = response.headers.get("retry-after");
      const retryMs =
        retry === null
          ? 0
          : /^\d+(\.\d+)?$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - now());
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        pacing.nextStart = Math.max(pacing.nextStart, reset + 1500);
      }
      if (limited || response.status >= 500) {
        if (attempt === 3) throw new SourceFailure(`HTTP ${response.status}; retry limit reached`);
        await delay(
          Math.max(
            1000 * 2 ** attempt,
            limited ? 60_000 : 0,
            Number.isFinite(retryMs) ? retryMs : 0,
            pacing.nextStart - now(),
          ),
        );
        continue;
      }
      return { observed_at: new Date(now()).toISOString(), status: response.status, body };
    }
    throw new SourceFailure("Retry limit reached");
  };
}
