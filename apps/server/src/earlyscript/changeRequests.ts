import {
  EnvironmentHttpApi,
  GitManagerError,
  PullRequestUnavailableError,
  WS_METHODS,
} from "@t3tools/contracts";
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PullRequestHttp from "../pullRequest/http.ts";

export const CHANGE_REQUESTS_DISABLED_MESSAGE =
  "Change requests are turned off in Earlyscript (changeRequests flag).";

const pullRequestsDisabled = new PullRequestUnavailableError({
  reason: "provider-unsupported",
  requirement: CHANGE_REQUESTS_DISABLED_MESSAGE,
});

/**
 * Without `changeRequests` the pull request workers never start: no sync after pushes, no
 * watch follow-ups and no one-minute sweep that asks GitHub or GitLab about every thread's PRs.
 */
export const startPullRequestWorker = <E, R>(
  start: Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> => (earlyscriptFlags.changeRequests ? start : Effect.void);

/** Without `changeRequests` the MCP server does not advertise link_pull_request, watch_pull_request and the rest. */
export const pullRequestsToolkit = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, R> | Layer.Layer<never> =>
  earlyscriptFlags.changeRequests ? layer : Layer.empty;

const GIT_PULL_REQUEST_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.gitResolvePullRequest,
  WS_METHODS.gitPreparePullRequestThread,
]);

/**
 * Without `changeRequests` every `pullRequests.*` RPC answers "unavailable" and
 * `git.resolvePullRequest` and `git.preparePullRequestThread` fail before reaching a host, even
 * when `sourceControlHosts` is on. The refresh subscription never emits.
 */
export const wsHandlers = <Handlers extends object>(handlers: Handlers): Handlers => {
  if (earlyscriptFlags.changeRequests) return handlers;
  const disabled: Record<string, unknown> = { ...(handlers as Record<string, unknown>) };
  for (const method of Object.keys(handlers)) {
    if (method === WS_METHODS.pullRequestsSubscribeRefreshes) {
      disabled[method] = () => Stream.empty;
    } else if (method.startsWith("pullRequests.")) {
      disabled[method] = () => Effect.fail(pullRequestsDisabled);
    } else if (GIT_PULL_REQUEST_METHODS.has(method)) {
      disabled[method] = (input: { readonly cwd: string }) =>
        Effect.fail(
          new GitManagerError({
            operation: method,
            cwd: input.cwd,
            detail: CHANGE_REQUESTS_DISABLED_MESSAGE,
          }),
        );
    }
  }
  // Same keys, each handler failing with an error its RPC declares.
  return disabled as Handlers;
};

/** `POST /api/pull-requests/diff` stays behind its auth and answers 503 "unavailable". */
export const layerPullRequestHttpDisabled = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pullRequests",
  (handlers) => handlers.handle("diff", () => Effect.fail(pullRequestsDisabled)),
);

export const layerPullRequestHttp = earlyscriptFlags.changeRequests
  ? PullRequestHttp.layer
  : layerPullRequestHttpDisabled;
