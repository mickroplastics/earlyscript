import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { editorialResultsEnvironment } from "../resultsState";
import { RESULTS_SECTIONS, formatCount, hasDecisions } from "./results.logic";

function NavigationNotice({ children }: { readonly children: string }) {
  return <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">{children}</div>;
}

/** The Results sidebar: the page's sections as anchors, not a list of items. */
export function ResultsNavigation({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const hash = useLocation({ select: (location) => location.hash });
  const result = useAtomValue(editorialResultsEnvironment.summary({ environmentId, input: {} }));
  const summary = AsyncResult.getOrElse(result, () => null);
  // Without decisions the page only shows the inbox counters.
  const sections =
    summary !== null && !hasDecisions(summary)
      ? RESULTS_SECTIONS.filter((section) => section.id === "bandeja")
      : RESULTS_SECTIONS;

  return (
    <SidebarContent
      className="min-h-full"
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <div className="flex h-8 items-center ps-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground">
              {summary === null
                ? "Resultados"
                : formatCount(summary.decisionCount, "decisión", "decisiones")}
            </span>
          </div>
        </SidebarGroup>
      }
    >
      <SidebarGroup>
        {summary === null && result._tag === "Failure" ? (
          <NavigationNotice>No se pudieron leer los resultados de este entorno.</NavigationNotice>
        ) : (
          <SidebarMenu aria-label="Secciones de Resultados">
            {sections.map((section) => {
              const isActive = hash === section.id;
              return (
                <SidebarMenuItem key={section.id}>
                  <SidebarMenuButton
                    isActive={isActive}
                    aria-current={isActive ? "location" : undefined}
                    className="text-sidebar-foreground data-[active=true]:bg-sidebar-row-active"
                    render={
                      <Link
                        to="/editorial/$environmentId/results"
                        params={{ environmentId }}
                        hash={section.id}
                        hashScrollIntoView={{ block: "start", behavior: "smooth" }}
                        onClick={() => {
                          if (isMobile) setOpenMobile(false);
                        }}
                      />
                    }
                  >
                    <span className="min-w-0 truncate">{section.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
}
