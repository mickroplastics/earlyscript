// robots.txt gate for the crawled sources (Lobsters, RSS), following RFC 9309: the groups
// that name our product token, else the `*` groups; longest matching rule wins, Allow on ties.
import { SourceFailure, type GetResponse } from "./http.ts";

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

/** Product token matched against `User-agent` lines, case-insensitively. */
export const ROBOTS_AGENT = "earlyscript";

export function robotsRules(text: string, agent = ROBOTS_AGENT): Array<RobotsRule> {
  const own: Array<RobotsRule> = [];
  const star: Array<RobotsRule> = [];
  let agents: Array<string> = [];
  let inRules = false;
  let ownSeen = false;
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      if (value.toLowerCase() === agent) ownSeen = true;
      continue;
    }
    if (key !== "allow" && key !== "disallow") continue;
    inRules = true;
    // An empty Disallow allows everything; it adds no rule.
    if (!value) continue;
    const rule = { allow: key === "allow", pattern: value };
    if (agents.includes(agent)) own.push(rule);
    if (agents.includes("*")) star.push(rule);
  }
  // A group naming us, even with only empty rules, replaces the `*` groups.
  return ownSeen ? own : star;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

export function robotsAllows(rules: ReadonlyArray<RobotsRule>, url: string): boolean {
  const parsed = new URL(url);
  const path = parsed.pathname + parsed.search;
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    )
      best = rule;
  }
  return best?.allow ?? true;
}

/** Returns null when the URL may be fetched, else the refusal reason for the coverage note. */
export type RobotsGate = (url: string) => Promise<string | null>;

/**
 * One robots.txt per origin, cached for the life of `cache` (one collect run). A 4xx means
 * no rules (RFC 9309 §2.3.1.3); an unreachable or 5xx robots.txt disallows the origin.
 */
export function robotsGate(
  getFor: (url: string) => GetResponse,
  cache: Map<string, ReadonlyArray<RobotsRule>>,
): RobotsGate {
  return async (url) => {
    const origin = new URL(url).origin;
    let rules = cache.get(origin);
    if (!rules) {
      const robotsUrl = `${origin}/robots.txt`;
      try {
        // RFC 9309 §2.3.1.2: follow at least five redirects for robots.txt itself, ungated.
        const response = await followRedirects(getFor, null)(robotsUrl);
        if (response.status === 200 && typeof response.body === "string")
          rules = robotsRules(response.body);
        else if (response.status >= 400 && response.status < 500) rules = [];
        else return `robots_unavailable: ${robotsUrl} HTTP ${response.status}`;
      } catch (error) {
        if (!(error instanceof SourceFailure)) throw error;
        return `robots_unavailable: ${robotsUrl} ${error.message}`;
      }
      cache.set(origin, rules);
    }
    return robotsAllows(rules, url)
      ? null
      : `robots_disallowed: ${origin}/robots.txt disallows ${new URL(url).pathname} for Earlyscript`;
  };
}

/** Redirect hops followed per request, as RFC 9309 asks for robots.txt. */
export const MAX_REDIRECTS = 5;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Follows redirects by hand: clients use `redirect: "manual"`, so every hop is a new request
 * through `getFor(target)` (the target host's pause) and, with a gate, only after the target
 * host's robots.txt allows the path. Callers gate the first URL themselves. A refused hop,
 * a sixth redirect or a redirect without a usable Location is a SourceFailure.
 */
export function followRedirects(
  getFor: (url: string) => GetResponse,
  gate: RobotsGate | null,
): GetResponse {
  return async (url, headers) => {
    let current = url;
    for (let hop = 0; ; hop++) {
      const response = await getFor(current)(current, headers);
      if (!REDIRECT.has(response.status)) return response;
      if (hop === MAX_REDIRECTS) throw new SourceFailure(`More than ${MAX_REDIRECTS} redirects`);
      let next: URL;
      try {
        next = new URL(response.location ?? "", current);
      } catch {
        throw new SourceFailure(`HTTP ${response.status} with an invalid Location`);
      }
      if (!response.location || (next.protocol !== "https:" && next.protocol !== "http:"))
        throw new SourceFailure(`HTTP ${response.status} with an unusable Location`);
      const refusal = gate ? await gate(next.href) : null;
      if (refusal) throw new SourceFailure(refusal);
      current = next.href;
    }
  };
}
