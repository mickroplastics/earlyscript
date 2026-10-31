import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ThreadId,
  type EditorialDossierId,
  type EditorialInboxSort,
  type EditorialTrendKey,
  type EditorialTrendSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowDownUpIcon, InboxIcon, RotateCcwIcon } from "lucide-react";
import { useContext, useEffect, useState, type ReactNode } from "react";

import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { getClientSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import { useNowMinute } from "../hooks/useNowMinute";
import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../components/ui/menu";
import { SidebarContent, SidebarGroup, SidebarMenu } from "../components/ui/sidebar";
import { inboxSections, runGroupLabel, trendMenuItems } from "./editorial.logic";
import {
  EMPTY_INBOX_VIEW,
  editorialEnvironment,
  refreshEditorialInbox,
  withLiveInboxState,
} from "./state";
import { useTrendActions } from "./trendActions";
import { TrendDismissDialog } from "./TrendDismissDialog";
import { TrendInboxRow, type TrendRowAction } from "./TrendInboxRow";
import { TrendJobIndicator } from "./TrendJobIndicator";
import { TrendPresentationRunButton } from "./TrendPresentationRunButton";

const SORT_OPTIONS: ReadonlyArray<{ readonly value: EditorialInboxSort; readonly label: string }> =
  [
    { value: "new-first-growth", label: "Nuevas y crecimiento" },
    { value: "volume", label: "Por volumen" },
    { value: "affinity", label: "Por afinidad" },
  ];

const isInboxSort = (value: unknown): value is EditorialInboxSort =>
  SORT_OPTIONS.some((option) => option.value === value);

/** Runs whose arrival through the subscription already refetched the read, per environment. */
const refetchedForRun = new Map<EnvironmentId, string>();

/**
 * The inbox query, which commands and drafted titles refresh, with each trend's state from
 * the live subscription, so a change from any client shows without a refetch. A run the
 * subscription announces replaces the read at once and refetches it.
 */
export function useTrendInbox(environmentId: EnvironmentId, sort: EditorialInboxSort) {
  const registry = useContext(RegistryContext);
  const target = { environmentId, input: { sort } };
  const live = AsyncResult.getOrElse(
    useAtomValue(editorialEnvironment.liveInbox(target)),
    () => EMPTY_INBOX_VIEW,
  ).inbox;
  const query = useAtomValue(editorialEnvironment.inbox(target));
  const readRunId = AsyncResult.getOrElse(query, () => null)?.run?.runId;
  const newerRunId =
    readRunId !== undefined && live?.run && live.run.runId !== readRunId ? live.run.runId : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a run imported on the server reaches the read only by refetching it
  useEffect(() => {
    if (newerRunId === null || refetchedForRun.get(environmentId) === newerRunId) return;
    refetchedForRun.set(environmentId, newerRunId);
    refreshEditorialInbox(registry, environmentId);
  }, [environmentId, newerRunId, registry]);
  return AsyncResult.map(query, (inbox) => withLiveInboxState(inbox, live));
}

function InboxNotice({ children }: { readonly children: string }) {
  return <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">{children}</div>;
}

/** A folded section under the active list: "En observación (N)" or "Descartadas (N)". */
function InboxSection({
  label,
  expanded,
  onToggle,
  children,
}: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      <li className="mt-2 list-none">
        <CollapsibleSectionHeader expanded={expanded} onClick={onToggle}>
          {label}
        </CollapsibleSectionHeader>
      </li>
      {expanded ? children : null}
    </>
  );
}

export function TrendInbox({
  environmentId,
  activeDossierId,
}: {
  readonly environmentId: EnvironmentId;
  readonly activeDossierId: EditorialDossierId | null;
}) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<EditorialInboxSort>("new-first-growth");
  // `null` follows the open dossier: the tail unfolds when it holds the open trend.
  const [foldedChoice, setFoldedChoice] = useState<boolean | null>(null);
  // Snoozed and dismissed stay folded until opened, even with the open dossier inside.
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissing, setDismissing] = useState<{
    readonly trendKey: EditorialTrendKey;
    readonly title: string;
  } | null>(null);
  const nowMinute = useNowMinute();
  const actions = useTrendActions(environmentId);
  const result = useTrendInbox(environmentId, sort);
  const inbox = AsyncResult.getOrElse(result, () => null);
  const sections = inboxSections(inbox?.trends ?? []);
  const showFolded =
    foldedChoice ?? sections.folded.some((trend) => trend.dossierId === activeDossierId);

  const openMenu = async (
    trend: EditorialTrendSummary,
    position: { readonly x: number; readonly y: number },
  ) => {
    const api = readLocalApi();
    const trendKey = trend.trendKey;
    if (!api || trendKey === undefined) return;
    const { timestampFormat } = getClientSettings();
    const presets = resolveSnoozePresets(new Date(), timestampFormat, environmentId);
    const clicked = await settlePromise(() =>
      api.contextMenu.show(trendMenuItems(trend.inbox, presets), position),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const choice = clicked.value;
    if (choice.startsWith("snooze:")) {
      const until =
        choice === "snooze:custom"
          ? await requestCustomSnooze()
          : pickSnoozePreset(
              presets,
              choice.slice("snooze:".length),
              timestampFormat,
              environmentId,
            );
      if (until) void actions.keepWatching(trendKey, until);
      return;
    }
    switch (choice) {
      case "create-video":
        void actions.createVideo({ ...trend, trendKey });
        return;
      case "open-video":
        if (trend.inbox?.production) {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: ThreadId.make(trend.inbox.production.threadId) },
          });
        }
        return;
      case "keep-watching":
        void actions.keepWatching(trendKey);
        return;
      case "return-to-inbox":
        void actions.returnToInbox(trendKey);
        return;
      case "dismiss":
        setDismissing({ trendKey, title: trend.presentation?.title ?? trend.label });
        return;
      case "reopen":
        void actions.reopen(trendKey);
        return;
    }
  };

  const renderRow = (trend: EditorialTrendSummary, action?: TrendRowAction) => (
    <TrendInboxRow
      key={trend.dossierId}
      environmentId={environmentId}
      trend={trend}
      isActive={trend.dossierId === activeDossierId}
      onContextMenu={(target, position) => void openMenu(target, position)}
      {...(action ? { action } : {})}
    />
  );
  const wayBack = (
    trend: EditorialTrendSummary,
    label: string,
    Icon: TrendRowAction["Icon"],
    run: (trendKey: EditorialTrendKey) => Promise<boolean>,
  ): TrendRowAction | undefined => {
    const trendKey = trend.trendKey;
    return trendKey === undefined ? undefined : { label, Icon, onClick: () => void run(trendKey) };
  };

  return (
    <SidebarContent
      className="min-h-full"
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <div className="flex h-8 items-center gap-1 ps-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground">
              {inbox?.run ? runGroupLabel(inbox.run, nowMinute) : "Tendencias"}
            </span>
            <TrendJobIndicator environmentId={environmentId} />
            {inbox?.run ? (
              <TrendPresentationRunButton environmentId={environmentId} runId={inbox.run.runId} />
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <SidebarHeaderIconButton
                    label={`Orden: ${SORT_OPTIONS.find((option) => option.value === sort)?.label ?? ""}`}
                  />
                }
              >
                <ArrowDownUpIcon className="size-4" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Orden</MenuGroupLabel>
                  <MenuRadioGroup
                    value={sort}
                    onValueChange={(value) => {
                      if (isInboxSort(value)) setSort(value);
                    }}
                  >
                    {SORT_OPTIONS.map((option) => (
                      <MenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuPopup>
            </Menu>
          </div>
        </SidebarGroup>
      }
    >
      <SidebarGroup>
        {inbox === null ? (
          result._tag === "Failure" ? (
            <InboxNotice>No se pudieron leer las corridas de este entorno.</InboxNotice>
          ) : null
        ) : inbox.run === null ? (
          <InboxNotice>Todavía no hay corridas del motor.</InboxNotice>
        ) : (
          <SidebarMenu aria-label={runGroupLabel(inbox.run, nowMinute)}>
            {sections.visible.map((trend) => renderRow(trend))}
            {sections.folded.length > 0 ? (
              <li className="list-none">
                <CollapsibleSectionHeader
                  expanded={showFolded}
                  onClick={() => setFoldedChoice(!showFolded)}
                >
                  {showFolded ? "Ocultar" : `Ver ${sections.folded.length} más`}
                </CollapsibleSectionHeader>
              </li>
            ) : null}
            {showFolded ? sections.folded.map((trend) => renderRow(trend)) : null}
            {sections.snoozed.length > 0 ? (
              <InboxSection
                label={`En observación (${sections.snoozed.length})`}
                expanded={showSnoozed}
                onToggle={() => setShowSnoozed(!showSnoozed)}
              >
                {sections.snoozed.map((trend) =>
                  renderRow(
                    trend,
                    wayBack(trend, "Volver a la bandeja", InboxIcon, actions.returnToInbox),
                  ),
                )}
              </InboxSection>
            ) : null}
            {sections.dismissed.length > 0 ? (
              <InboxSection
                label={`Descartadas (${sections.dismissed.length})`}
                expanded={showDismissed}
                onToggle={() => setShowDismissed(!showDismissed)}
              >
                {sections.dismissed.map((trend) =>
                  renderRow(trend, wayBack(trend, "Reabrir", RotateCcwIcon, actions.reopen)),
                )}
              </InboxSection>
            ) : null}
          </SidebarMenu>
        )}
      </SidebarGroup>
      {dismissing !== null ? (
        <TrendDismissDialog
          trendTitle={dismissing.title}
          onConfirm={(reason) => actions.dismiss(dismissing.trendKey, reason)}
          onClose={() => setDismissing(null)}
        />
      ) : null}
    </SidebarContent>
  );
}
