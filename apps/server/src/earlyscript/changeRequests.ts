import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
