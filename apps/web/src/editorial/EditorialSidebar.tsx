import { EditorialDossierId, EditorialRunId, type EnvironmentId } from "@t3tools/contracts";
import { useMatches, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { MessagesSquareIcon, TrendingUpIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ComponentProps } from "react";

import ThreadSidebar from "../components/Sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../components/sidebar/SidebarChrome";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { SidebarGroup } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { readPrimaryEnvironmentId, usePrimaryEnvironmentId } from "../state/environments";
import {
  compactCount,
  isThreadRouteId,
  resolveRouteSpace,
  spaceTabName,
  spaceTabTarget,
} from "./editorial.logic";
import { selectEnvironmentSpace, useSpaceStore, type EditorialSpace } from "./spaceStore";
import { FinishSetupEntry } from "./FinishSetupEntry";
import { useSidebarLocale } from "./locale/ShellLocale";
import { NewManualThreadButton } from "./NewManualThreadButton";
import { TrendInbox, useTrendInbox } from "./TrendInbox";

const SPACES: ReadonlyArray<{
  readonly space: EditorialSpace;
  readonly label: string;
  readonly Icon: LucideIcon;
}> = [
  { space: "threads", label: "Hilos", Icon: MessagesSquareIcon },
  { space: "trends", label: "Tendencias", Icon: TrendingUpIcon },
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
  routeSpace,
}: {
  readonly environmentId: EnvironmentId;
  readonly space: EditorialSpace;
  /** The space of the page on screen; `null` on Results, Settings and Usage. */
  readonly routeSpace: EditorialSpace | null;
}) {
  const navigate = useNavigate();
  const inbox = AsyncResult.getOrElse(useTrendInbox(environmentId, "new-first-growth"), () => null);
  // New trends of the latest run, without snoozed or dismissed ones; live from the server.
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
    }
  };

  return (
    // Icons below 12.5rem of group width, truncated labels above it. Measured on the 19 October
    // run: the group is 191px at the 208px sidebar minimum and the full labels need ~239px.
    <SidebarGroup className="@container/spaces order-1 shrink-0">
      <ToggleGroup
        aria-label="Espacios"
        variant="segmented"
        size="compact"
        className="w-full"
        value={[space]}
        onValueChange={(next) => {
          const pressed = SPACES.find((entry) => entry.space === next[0])?.space;
          const target = spaceTabTarget({ pressed, shown: space, routeSpace });
          if (target !== null) open(target);
        }}
      >
        {SPACES.map(({ space: entrySpace, label, Icon }) => {
          const count = entrySpace === "trends" && newCount > 0 ? newCount : null;
          const name = spaceTabName(label, count);
          return (
            <Tooltip key={entrySpace}>
              <TooltipTrigger
                render={
                  <Toggle
                    value={entrySpace}
                    aria-label={name}
                    data-editorial-space={entrySpace}
                    // A short label never truncates; the long ones absorb the squeeze.
                    className={cn("flex-auto", label.length > 5 ? "min-w-0" : "shrink-0")}
                  />
                }
              >
                {/* A plain wrapper owns the spacing: the Toggle's own gap is too wide here. */}
                <span className="flex min-w-0 items-center gap-1 @max-[12.5rem]/spaces:gap-0.5">
                  <Icon aria-hidden className="hidden @max-[12.5rem]/spaces:block" />
                  <span className="min-w-0 truncate @max-[12.5rem]/spaces:hidden">{label}</span>
                  {count !== null ? (
                    <span
                      aria-hidden
                      className="shrink-0 text-2xs font-semibold text-primary tabular-nums"
                    >
                      {compactCount(count)}
                    </span>
                  ) : null}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="bottom">{name}</TooltipPopup>
            </Tooltip>
          );
        })}
      </ToggleGroup>
    </SidebarGroup>
  );
}

/**
 * The main sidebar with Earlyscript's spaces: Threads (upstream's sidebar, untouched) and
 * Trends. Results is a page, opened from the bottom row: the sidebar keeps the list it had.
 * The space switch sits under the title bar in every space: it renders first so it keeps focus
 * across switches, and CSS order places it after the space's title bar.
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
  const routeSpace = resolveRouteSpace(routeId);
  const space = routeSpace ?? storedSpace;
  // Upstream's sidebar in Spanish: the scope is `[data-app-sidebar]`, found from this wrapper.
  const localeAnchor = useRef<HTMLDivElement>(null);
  useSidebarLocale(localeAnchor);

  return (
    <>
      {environmentId ? (
        <SpaceTabs environmentId={environmentId} space={space} routeSpace={routeSpace} />
      ) : null}
      {environmentId ? <FinishSetupEntry environmentId={environmentId} /> : null}
      {environmentId && space === "threads" ? (
        <NewManualThreadButton environmentId={environmentId} />
      ) : null}
      <div
        ref={localeAnchor}
        className="contents *:order-2 [&>*:first-child]:order-0"
        data-editorial-space={space}
      >
        {space === "threads" || environmentId === null ? (
          <ThreadSidebar {...props} />
        ) : (
          <>
            <SidebarChromeHeader isElectron={isElectron} />
            <TrendInbox
              environmentId={environmentId}
              activeDossierId={routeDossierId ? EditorialDossierId.make(routeDossierId) : null}
            />
            <SidebarChromeFooter />
          </>
        )}
      </div>
    </>
  );
}
