import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useMatches, useParams } from "@tanstack/react-router";
import { ChartScatterIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { isResultsRouteId } from "../editorial.logic";

const LABEL = "Resultados";

/**
 * Results in the sidebar's bottom row, beside Settings and Usage: a page, not a list, so the
 * sidebar keeps the list it had. Marked while Results is on screen.
 */
export function ResultsSidebarButton() {
  const { isMobile, setOpenMobile } = useSidebar();
  const active = useMatches({ select: (matches) => isResultsRouteId(matches.at(-1)?.routeId) });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => params.environmentId,
  }) as EnvironmentId | undefined;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = routeEnvironmentId ?? primaryEnvironmentId;
  if (environmentId === null) return null;
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={LABEL}
              aria-current={active ? "page" : undefined}
              isActive={active}
              size="icon"
              render={
                <Link
                  to="/editorial/$environmentId/results"
                  params={{ environmentId }}
                  // On Results already, the tab on screen stays.
                  search={active ? true : {}}
                  onClick={() => {
                    if (isMobile) setOpenMobile(false);
                  }}
                />
              }
            >
              <ChartScatterIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{LABEL}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
