import { Outlet, createFileRoute, useChildMatches } from "@tanstack/react-router";

import { EditorialEmptyPage } from "../editorial/EditorialPage";

function TrendsRouteView() {
  const hasDossier = useChildMatches({ select: (matches) => matches.length > 0 });
  return hasDossier ? (
    <Outlet />
  ) : (
    <EditorialEmptyPage
      space="Tendencias"
      title="Elige una tendencia"
      description="Abre una tendencia de la lista para leer su expediente: curva, cobertura, evidencia y por qué está aquí."
    />
  );
}

export const Route = createFileRoute("/_chat/editorial/$environmentId/trends")({
  component: TrendsRouteView,
});
