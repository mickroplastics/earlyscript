import { validateFeed } from "@earlyscript/trend-engine/sources";
import { EditorialSourcesError, type EditorialFeedCheck } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { nowIso } from "./persistence/support.ts";

const failure = (reason: EditorialSourcesError["reason"], message: string) =>
  new EditorialSourcesError({ reason, message });

export function normalizeHttpUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// The engine's messages start with these codes (trend-engine sources/robots.ts and http.ts).
const reasonOf = (error: "not-a-feed" | "robots-disallowed" | "unreachable", message: string) =>
  error !== "unreachable"
    ? error
    : message.startsWith("robots_unavailable")
      ? "robots-unavailable"
      : message.startsWith("response_too_large")
        ? "too-large"
        : "unreachable";

/**
 * The engine's `validateFeed`: robots.txt before every request, redirects followed by hand
 * with robots per hop and credentials kept to their origin, the body cut at the source's byte
 * limit, 15 s per request and 60 s in all.
 */
export const checkFeed = Effect.fn("EditorialFeedCheck.check")(function* (input: string) {
  const feedUrl = normalizeHttpUrl(input);
  if (feedUrl === null) {
    return yield* failure("invalid-url", `Not an http or https URL: ${input}`);
  }
  const result = yield* Effect.tryPromise({
    try: () => validateFeed(feedUrl),
    catch: (cause) => failure("unreachable", `${feedUrl}: ${String(cause)}`),
  });
  if (!result.ok) {
    return yield* failure(reasonOf(result.error, result.message), result.message);
  }
  return {
    feedUrl,
    title: result.title.trim() || null,
    siteUrl: result.link,
    entries: result.entries,
    latestAt: result.latest,
    checkedAt: yield* nowIso,
  } satisfies EditorialFeedCheck;
});
