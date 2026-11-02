import { EnvironmentId } from "@t3tools/contracts";
import { Outlet, createFileRoute, useChildMatches } from "@tanstack/react-router";

import { TrendsEmptyPage } from "../editorial/TrendDossierPage";

function TrendsRouteView() {
  const { environmentId } = Route.useParams();
  const hasDossier = useChildMatches({ select: (matches) => matches.length > 0 });
  return hasDossier ? (
    <Outlet />
  ) : (
    <TrendsEmptyPage environmentId={EnvironmentId.make(environmentId)} />
  );
}

export const Route = createFileRoute("/_chat/editorial/$environmentId/trends")({
  component: TrendsRouteView,
});
