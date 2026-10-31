import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ResultsPage } from "../editorial/results/ResultsPage";

function ResultsRouteView() {
  const { environmentId } = Route.useParams();
  return <ResultsPage environmentId={EnvironmentId.make(environmentId)} />;
}

export const Route = createFileRoute("/_chat/editorial/$environmentId/results")({
  component: ResultsRouteView,
});
