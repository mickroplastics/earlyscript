import { createFileRoute } from "@tanstack/react-router";

import { EditorialEmptyPage } from "../editorial/EditorialPage";

function ResultsRouteView() {
  return (
    <EditorialEmptyPage
      space="Resultados"
      title="Todavía no hay resultados"
      description="Aquí verás tiempos, utilidad y métricas cuando haya fichas decididas."
    />
  );
}

export const Route = createFileRoute("/_chat/editorial/$environmentId/results")({
  component: ResultsRouteView,
});
