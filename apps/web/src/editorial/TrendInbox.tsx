import { useAtomValue } from "@effect/atom-react";
import type { EditorialDossierId, EditorialInboxSort, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ArrowDownUpIcon } from "lucide-react";
import { useState } from "react";

import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
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
import { runGroupLabel, splitInbox } from "./editorial.logic";
import { editorialEnvironment } from "./state";
import { TrendInboxRow } from "./TrendInboxRow";

const SORT_OPTIONS: ReadonlyArray<{ readonly value: EditorialInboxSort; readonly label: string }> =
  [
    { value: "new-first-growth", label: "Nuevas y crecimiento" },
    { value: "volume", label: "Por volumen" },
    { value: "affinity", label: "Por afinidad" },
  ];

const isInboxSort = (value: unknown): value is EditorialInboxSort =>
  SORT_OPTIONS.some((option) => option.value === value);

export function useTrendInbox(environmentId: EnvironmentId, sort: EditorialInboxSort) {
  return useAtomValue(editorialEnvironment.inbox({ environmentId, input: { sort } }));
}

function InboxNotice({ children }: { readonly children: string }) {
  return <div className="px-2 py-6 text-center text-xs text-muted-foreground/60">{children}</div>;
}

export function TrendInbox({
  environmentId,
  activeDossierId,
}: {
  readonly environmentId: EnvironmentId;
  readonly activeDossierId: EditorialDossierId | null;
}) {
  const [sort, setSort] = useState<EditorialInboxSort>("new-first-growth");
  // `null` follows the open dossier: the tail unfolds when it holds the open trend.
  const [foldedChoice, setFoldedChoice] = useState<boolean | null>(null);
  const nowMinute = useNowMinute();
  const result = useTrendInbox(environmentId, sort);
  const inbox = AsyncResult.getOrElse(result, () => null);
  const { visible, folded } = splitInbox(inbox?.trends ?? []);
  const showFolded = foldedChoice ?? folded.some((trend) => trend.dossierId === activeDossierId);

  return (
    <SidebarContent
      className="min-h-full"
      fixedHeader={
        <SidebarGroup className="z-[1]">
          <div className="flex h-8 items-center gap-1 ps-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-sidebar-muted-foreground">
              {inbox?.run ? runGroupLabel(inbox.run, nowMinute) : "Tendencias"}
            </span>
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
            {visible.map((trend) => (
              <TrendInboxRow
                key={trend.dossierId}
                environmentId={environmentId}
                trend={trend}
                isActive={trend.dossierId === activeDossierId}
              />
            ))}
            {folded.length > 0 ? (
              <li className="list-none">
                <CollapsibleSectionHeader
                  expanded={showFolded}
                  onClick={() => setFoldedChoice(!showFolded)}
                >
                  {showFolded ? "Ocultar" : `Ver ${folded.length} más`}
                </CollapsibleSectionHeader>
              </li>
            ) : null}
            {showFolded
              ? folded.map((trend) => (
                  <TrendInboxRow
                    key={trend.dossierId}
                    environmentId={environmentId}
                    trend={trend}
                    isActive={trend.dossierId === activeDossierId}
                  />
                ))
              : null}
          </SidebarMenu>
        )}
      </SidebarGroup>
    </SidebarContent>
  );
}
