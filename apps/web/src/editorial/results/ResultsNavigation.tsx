import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLinkProps } from "@tanstack/react-router";
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
import { formatCount, withoutRouteActive } from "./results.logic";
import { visibleTabs, type ResultsTabId } from "./resultsOverview.logic";
import { resultsPanelId, useResultsTab } from "./ResultsTabs";

function NavigationNotice({ children }: { readonly children: string }) {
  return <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">{children}</div>;
}

/**
 * A link to a tab of the page. Every link points at the same route, so a `Link` would mark all
 * of them `aria-current="page"` (its active props always win over ours); the route-active
 * attributes are dropped and the menu button marks the tab on screen.
 */
function TabLink({
  environmentId,
  tab,
  onNavigate,
  ...props
}: ComponentProps<"a"> & {
  readonly environmentId: EnvironmentId;
  readonly tab: ResultsTabId;
  readonly onNavigate: () => void;
}) {
  const linkProps = useLinkProps({
    to: "/editorial/$environmentId/results",
    params: { environmentId },
    search: { tab },
    replace: true,
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

/** Keyboard and screen reader users land on the panel, with the tab bar in view above it. */
function focusPanel(tab: ResultsTabId) {
  // The panel turns visible on the render after the navigation.
  window.setTimeout(() => {
    const panel = document.getElementById(resultsPanelId(tab));
    panel?.scrollIntoView({ block: "start" });
    panel?.focus({ preventScroll: true });
  }, 0);
}

/** The Results sidebar: the page's tabs as links, not a list of items. */
export function ResultsNavigation({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const result = useAtomValue(editorialResultsEnvironment.summary({ environmentId, input: {} }));
  const summary = AsyncResult.getOrElse(result, () => null);
  const tabs = visibleTabs(summary);
  const [active] = useResultsTab(tabs);

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
        ) : tabs.length === 0 ? (
          <NavigationNotice>
            Aquí verás tiempos, utilidad y citas cuando cierres el primer hilo de video.
          </NavigationNotice>
        ) : (
          <SidebarMenu aria-label="Pestañas de Resultados">
            {tabs.map((tab) => {
              const current = tab.id === active;
              return (
                <SidebarMenuItem key={tab.id}>
                  <SidebarMenuButton
                    isActive={current}
                    aria-current={current ? "true" : undefined}
                    className="text-sidebar-foreground data-[active=true]:bg-sidebar-row-active"
                    render={
                      <TabLink
                        environmentId={environmentId}
                        tab={tab.id}
                        onNavigate={() => {
                          if (isMobile) setOpenMobile(false);
                          focusPanel(tab.id);
                        }}
                      />
                    }
                  >
                    <span className="min-w-0 truncate">{tab.label}</span>
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
