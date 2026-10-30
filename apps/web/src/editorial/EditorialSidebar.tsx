import { EditorialDossierId, EditorialRunId, type EnvironmentId } from "@t3tools/contracts";
import { useMatches, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, type ComponentProps } from "react";

import ThreadSidebar from "../components/Sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { SidebarContent, SidebarGroup } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "../state/environments";
import { isThreadRouteId, resolveRouteSpace } from "./editorial.logic";
import { selectEnvironmentSpace, useSpaceStore, type EditorialSpace } from "./spaceStore";
import { TrendInbox, useTrendInbox } from "./TrendInbox";

const SPACES: ReadonlyArray<{ readonly space: EditorialSpace; readonly label: string }> = [
  { space: "threads", label: "Hilos" },
  { space: "trends", label: "Tendencias" },
  { space: "results", label: "Resultados" },
];

/** Remembers each space's last destination as the router resolves, deep links included. */
function useRecordSpaceDestinations() {
  const router = useRouter();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors resolved routes into the persisted space store
  useEffect(() => {
    const record = () => {
      const leaf = router.state.matches.at(-1);
      const routeId = leaf?.routeId;
      const params = (leaf?.params ?? {}) as Partial<Record<string, string>>;
      const environmentId = (params.environmentId ?? null) as EnvironmentId | null;
      const store = useSpaceStore.getState();
      if (isThreadRouteId(routeId)) {
        store.setThreadsHref(router.state.location.href);
        const threadEnvironmentId = environmentId ?? readPrimaryEnvironmentId();
        if (threadEnvironmentId) store.setSpace(threadEnvironmentId, "threads");
        return;
      }
      const space = resolveRouteSpace(routeId);
      if (space === null || space === "threads" || environmentId === null) return;
      if (space === "trends" && params.dossierId) {
        const run = (router.state.location.search as { readonly run?: unknown }).run;
        store.openTrend(environmentId, {
          dossierId: EditorialDossierId.make(params.dossierId),
          runId: typeof run === "string" && run ? EditorialRunId.make(run) : null,
        });
        return;
      }
      store.setSpace(environmentId, space);
    };
    record();
    return router.subscribe("onResolved", record);
  }, [router]);
}

function SpaceTabs({
  environmentId,
  space,
}: {
  readonly environmentId: EnvironmentId;
  readonly space: EditorialSpace;
}) {
  const navigate = useNavigate();
  const inbox = AsyncResult.getOrElse(useTrendInbox(environmentId, "new-first-growth"), () => null);
  // Until the inbox has read state (U3), "new" counts every trend of the latest run.
  const newCount = inbox?.newCount ?? 0;

  const open = (next: EditorialSpace) => {
    const store = useSpaceStore.getState();
    switch (next) {
      case "threads":
        // Set first, so the root does not send the user back to Trends.
        store.setSpace(environmentId, "threads");
        void navigate({ href: store.threadsHref ?? "/" });
        return;
      case "trends": {
        const trend = selectEnvironmentSpace(store, environmentId).trend;
        void (trend
          ? navigate({
              to: "/editorial/$environmentId/trends/$dossierId",
              params: { environmentId, dossierId: trend.dossierId },
              search: trend.runId ? { run: trend.runId } : {},
            })
          : navigate({ to: "/editorial/$environmentId/trends", params: { environmentId } }));
        return;
      }
      case "results":
        void navigate({ to: "/editorial/$environmentId/results", params: { environmentId } });
        return;
    }
  };

  return (
    <SidebarGroup className="order-1 shrink-0">
      <ToggleGroup
        aria-label="Espacios"
        variant="segmented"
        size="compact"
        className="w-full overflow-hidden"
        value={[space]}
        onValueChange={(next) => {
          const selected = SPACES.find((entry) => entry.space === next[0]);
          if (selected && selected.space !== space) open(selected.space);
        }}
      >
        {SPACES.map((entry) => (
          <Toggle
            key={entry.space}
            value={entry.space}
            data-editorial-space={entry.space}
            className="flex-auto"
          >
            {entry.label}
            {entry.space === "trends" && newCount > 0 ? (
              <span className="text-2xs font-semibold text-primary tabular-nums">
                {newCount}
                <span className="sr-only"> nuevas</span>
              </span>
            ) : null}
          </Toggle>
        ))}
      </ToggleGroup>
    </SidebarGroup>
  );
}

function ResultsSidebar() {
  return (
    <SidebarContent className="min-h-full">
      <SidebarGroup>
        <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">
          Aquí verás tiempos, utilidad y métricas cuando haya fichas decididas.
        </div>
      </SidebarGroup>
    </SidebarContent>
  );
}

/**
 * The main sidebar with Earlyscript's spaces: Threads (upstream's sidebar, untouched), Trends
 * and Results. The space switch sits under the title bar in every space: it renders first so
 * it keeps focus across switches, and CSS order places it after the space's title bar.
 */
export function EditorialSidebar(props: ComponentProps<typeof ThreadSidebar>) {
  useRecordSpaceDestinations();
  const routeId = useMatches({ select: (matches) => matches.at(-1)?.routeId });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => params.environmentId,
  }) as EnvironmentId | undefined;
  const routeDossierId = useParams({ strict: false, select: (params) => params.dossierId });
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = routeEnvironmentId ?? primaryEnvironmentId;
  const storedSpace = useSpaceStore((state) => selectEnvironmentSpace(state, environmentId).space);
  const space = resolveRouteSpace(routeId) ?? storedSpace;

  return (
    <>
      {environmentId ? <SpaceTabs environmentId={environmentId} space={space} /> : null}
      <div className="contents *:order-2 [&>*:first-child]:order-0" data-editorial-space={space}>
        {space === "threads" || environmentId === null ? (
          <ThreadSidebar {...props} />
        ) : (
          <>
            <SidebarChromeHeader isElectron={isElectron} />
            {space === "trends" ? (
              <TrendInbox
                environmentId={environmentId}
                activeDossierId={routeDossierId ? EditorialDossierId.make(routeDossierId) : null}
              />
            ) : (
              <ResultsSidebar />
            )}
            <SidebarChromeFooter />
          </>
        )}
      </div>
    </>
  );
}
