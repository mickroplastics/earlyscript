import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ResultsPage } from "../editorial/results/ResultsPage";
import {
  resultsTabFromSearch,
  type ResultsTabId,
} from "../editorial/results/resultsOverview.logic";

export interface ResultsSearch {
  /** The detail tab on screen; the first visible one when absent. */
  readonly tab?: ResultsTabId;
}

function ResultsRouteView() {
  const { environmentId } = Route.useParams();
  return <ResultsPage environmentId={EnvironmentId.make(environmentId)} />;
}

export const Route = createFileRoute("/_chat/editorial/$environmentId/results")({
  validateSearch: (raw: Record<string, unknown>): ResultsSearch => {
    const tab = resultsTabFromSearch(raw.tab);
    return tab === undefined ? {} : { tab };
  },
  component: ResultsRouteView,
});
