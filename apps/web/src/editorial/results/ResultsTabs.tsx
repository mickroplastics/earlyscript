import { Tabs } from "@base-ui/react/tabs";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  activeResultsTab,
  resultsTabFromSearch,
  type ResultsTab,
  type ResultsTabId,
} from "./resultsOverview.logic";

/** The id of a tab's panel, for the sidebar to move focus into it. */
function resultsPanelId(tab: ResultsTabId): string {
  return `resultados-${tab}`;
}

/**
 * Scrolls a panel to just under the fixed tab bar and focuses it, once it is visible: the
 * sidebar link changes the tab through the URL, so the panel shows on a later render.
 */
export function focusResultsPanel(tab: ResultsTabId) {
  const panel = document.getElementById(resultsPanelId(tab));
  if (panel === null) return;
  const land = () => {
    const bar = document.querySelector<HTMLElement>("[data-results-tabbar]");
    panel.style.scrollMarginTop = `${bar?.offsetHeight ?? 0}px`;
    panel.scrollIntoView({ block: "start" });
    panel.focus({ preventScroll: true });
  };
  if (!panel.hasAttribute("hidden")) {
    land();
    return;
  }
  const observer = new MutationObserver(() => {
    if (panel.hasAttribute("hidden")) return;
    observer.disconnect();
    land();
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
}

/**
 * The tab in `?tab=`, resolved against the visible tabs, and the way to change it. The URL
 * keeps the tab so a link opens Results on it; changing tabs replaces the entry.
 */
export function useResultsTab(
  visible: ReadonlyArray<ResultsTab>,
): readonly [ResultsTabId | undefined, (tab: ResultsTabId) => void] {
  const requested = useSearch({
    strict: false,
    select: (search: Record<string, unknown>) => resultsTabFromSearch(search.tab),
  });
  const navigate = useNavigate();
  const select = (tab: ResultsTabId) =>
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, tab }),
      replace: true,
    });
  return [activeResultsTab(requested, visible), select] as const;
}

/** Title, explanation and an action (a figure menu, a button) at the top of a panel. */
export function PanelLead({
  id,
  title,
  children,
  action,
}: {
  readonly id?: string;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="flex max-w-3xl min-w-0 flex-1 basis-80 flex-col gap-1">
        <h2 id={id} className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        {children}
      </div>
      {action}
    </div>
  );
}

/** The paragraph under a panel title. */
export function PanelLeadText({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/**
 * The detail of Results in tabs. Every panel stays mounted (hidden when inactive) so the
 * figures inside keep their place in «Guardar todas las figuras».
 */
export function ResultsTabs({
  tabs,
  value,
  onValueChange,
  counts,
  panels,
}: {
  readonly tabs: ReadonlyArray<ResultsTab>;
  readonly value: ResultsTabId | undefined;
  readonly onValueChange: (tab: ResultsTabId) => void;
  /** A count beside a tab label, such as the decisions. */
  readonly counts?: Partial<Record<ResultsTabId, string>>;
  readonly panels: Readonly<Record<ResultsTabId, ReactNode>>;
}) {
  return (
    <Tabs.Root
      value={value ?? null}
      onValueChange={(next: ResultsTabId) => onValueChange(next)}
      className="flex min-w-0 flex-col"
    >
      {/* The opaque band under the line keeps scrolled content off it while the bar is fixed. */}
      <div data-results-tabbar="" className="sticky top-0 z-10 bg-background pb-3">
        <Tabs.List
          activateOnFocus
          loopFocus
          aria-label="Detalle de Resultados"
          className="flex gap-0.5 overflow-x-auto border-b border-border"
        >
          {tabs.map((tab) => (
            <Tabs.Tab
              key={tab.id}
              value={tab.id}
              className="-mb-px flex shrink-0 cursor-pointer items-baseline gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[active]:border-foreground data-[active]:text-foreground"
            >
              {tab.label}
              {counts?.[tab.id] ? (
                <span className="text-xs text-muted-foreground tabular-nums">{counts[tab.id]}</span>
              ) : null}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </div>
      {tabs.map((tab) => (
        <Tabs.Panel
          key={tab.id}
          value={tab.id}
          keepMounted
          id={resultsPanelId(tab.id)}
          className="flex min-w-0 flex-col gap-4 rounded-sm pt-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[hidden]:hidden"
        >
          {panels[tab.id]}
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}
