// Earlyscript-only: the `changeRequests` flag. The `/pull-requests` route imports its page from here
// instead of its own module (one-line hook in docs/upstream-divergence.md).
import { Navigate } from "@tanstack/react-router";
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

import { PullRequestsPage as UpstreamPullRequestsPage } from "../components/pullRequest/PullRequestsPage";

export function PullRequestsPageDisabled() {
  return <Navigate to="/" replace />;
}

/** Without `changeRequests` the `/pull-requests` route sends the user home. */
export const PullRequestsPage = earlyscriptFlags.changeRequests
  ? UpstreamPullRequestsPage
  : PullRequestsPageDisabled;
