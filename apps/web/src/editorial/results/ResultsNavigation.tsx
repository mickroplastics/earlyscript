import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLinkProps, useLocation } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import type { ComponentProps } from "react";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../../components/ui/sidebar";
import { editorialResultsEnvironment } from "../resultsState";
import {
  formatCount,
  sectionAriaCurrent,
  visibleSections,
  withoutRouteActive,
  type ResultsSectionId,
} from "./results.logic";

function NavigationNotice({ children }: { readonly children: string }) {
  return <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">{children}</div>;
}

/**
 * An anchor to a section of the page. Every anchor points at the same route, so a `Link`
 * would mark all of them `aria-current="page"` (its active props always win over ours);
 * the route-active attributes are dropped and the menu button sets `location` by hash.
 */
function SectionAnchor({
  environmentId,
  sectionId,
  onNavigate,
  ...props
}: ComponentProps<"a"> & {
  readonly environmentId: EnvironmentId;
  readonly sectionId: ResultsSectionId;
  readonly onNavigate: () => void;
}) {
  const linkProps = useLinkProps({
    to: "/editorial/$environmentId/results",
    params: { environmentId },
    hash: sectionId,
    hashScrollIntoView: { block: "start", behavior: "smooth" },
    onClick: onNavigate,
  });
  const { onClick, ...rest } = withoutRouteActive(linkProps);
  return (
    <a
      {...rest}
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        onClick?.(event);
      }}
    />
  );
}

/** The Results sidebar: the page's sections as anchors, not a list of items. */
export function ResultsNavigation({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const hash = useLocation({ select: (location) => location.hash });
  const result = useAtomValue(editorialResultsEnvironment.summary({ environmentId, input: {} }));
  const summary = AsyncResult.getOrElse(result, () => null);
  const sections = visibleSections(summary);

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
        ) : sections.length === 0 ? (
          <NavigationNotice>
            Aquí verás tiempos, utilidad y citas cuando cierres el primer hilo de video.
          </NavigationNotice>
        ) : (
          <SidebarMenu aria-label="Secciones de Resultados">
            {sections.map((section) => {
              const ariaCurrent = sectionAriaCurrent(hash, section.id);
              return (
                <SidebarMenuItem key={section.id}>
                  <SidebarMenuButton
                    isActive={ariaCurrent !== undefined}
                    aria-current={ariaCurrent}
                    className="text-sidebar-foreground data-[active=true]:bg-sidebar-row-active"
                    render={
                      <SectionAnchor
                        environmentId={environmentId}
                        sectionId={section.id}
                        onNavigate={() => {
                          if (isMobile) setOpenMobile(false);
                          // Keyboard and screen reader users land on the section, not the menu.
                          document.getElementById(section.id)?.focus({ preventScroll: true });
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
