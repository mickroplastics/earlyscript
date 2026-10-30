import { EditorialDossierId, EditorialRunId, EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { TrendDossierPage } from "../editorial/TrendDossierPage";

export interface DossierSearch {
  /** Run of the dossier; the latest run when absent. */
  readonly run?: EditorialRunId;
}

function DossierRouteView() {
  const { environmentId, dossierId } = Route.useParams();
  const { run } = Route.useSearch();
  return (
    <TrendDossierPage
      environmentId={EnvironmentId.make(environmentId)}
      runId={run ?? null}
      dossierId={EditorialDossierId.make(dossierId)}
    />
  );
}

export const Route = createFileRoute("/_chat/editorial/$environmentId/trends/$dossierId")({
  validateSearch: (raw: Record<string, unknown>): DossierSearch =>
    typeof raw.run === "string" && raw.run.trim()
      ? { run: EditorialRunId.make(raw.run.trim().slice(0, 200)) }
      : {},
  component: DossierRouteView,
});
