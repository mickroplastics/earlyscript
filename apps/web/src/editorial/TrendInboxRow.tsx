import { ThreadId, type EditorialTrendSummary, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactElement } from "react";

import { cn } from "../lib/utils";
import { Badge } from "../components/ui/badge";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { sourceLabel } from "./editorial.logic";

const SPARK_BAR_WIDTH = 2;
const SPARK_GAP = 1;
const SPARK_HEIGHT = 12;

/**
 * Fourteen days of items. A day the engine did not capture is a faint full-height bar,
 * so a gap never reads as a quiet day.
 */
export function TrendSparkline({
  values,
  className,
}: {
  readonly values: ReadonlyArray<number | null>;
  readonly className?: string;
}) {
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  const width = values.length * (SPARK_BAR_WIDTH + SPARK_GAP) - SPARK_GAP;
  return (
    <svg
      aria-hidden
      className={cn("shrink-0 overflow-visible", className)}
      width={width}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${width} ${SPARK_HEIGHT}`}
    >
      {values.map((value, index) => {
        const x = index * (SPARK_BAR_WIDTH + SPARK_GAP);
        if (value === null) {
          return (
            <rect
              // oxlint-disable-next-line react/no-array-index-key -- days are positional
              key={index}
              x={x}
              y={0}
              width={SPARK_BAR_WIDTH}
              height={SPARK_HEIGHT}
              rx={0.5}
              className="fill-muted-foreground/20"
            />
          );
        }
        const height = Math.max(1, Math.round((value / max) * SPARK_HEIGHT));
        return (
          <rect
            // oxlint-disable-next-line react/no-array-index-key -- days are positional
            key={index}
            x={x}
            y={SPARK_HEIGHT - height}
            width={SPARK_BAR_WIDTH}
            height={height}
            rx={0.5}
            className={value === 0 ? "fill-muted-foreground/35" : "fill-primary"}
          />
        );
      })}
    </svg>
  );
}

/** "11 publ. · 11 autores · puntaje #13": fits the default sidebar width. */
function trendRowMeta(trend: EditorialTrendSummary): string {
  const authors = `${trend.authors7d} ${trend.authors7d === 1 ? "autor" : "autores"}`;
  return `${trend.items7d} publ. · ${authors} · puntaje #${trend.scoreRank}`;
}

/** The way back of a snoozed or dismissed row, shown on hover like a thread's wake button. */
export interface TrendRowAction {
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly onClick: () => void;
}

export function TrendInboxRow({
  environmentId,
  trend,
  isActive,
  action,
  onContextMenu,
}: {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
  readonly isActive: boolean;
  readonly action?: TrendRowAction;
  readonly onContextMenu?: (
    trend: EditorialTrendSummary,
    position: { readonly x: number; readonly y: number },
  ) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const title = trend.presentation?.title ?? trend.label;
  const production = trend.inbox?.production ?? null;
  const dismissed = trend.inbox?.dismissed ?? null;
  // Read, snoozed and dismissed rows recede like a seen thread; new ones keep full weight.
  const recede = !trend.isNew;
  const row: ReactElement = (
    <SidebarMenuButton
      isActive={isActive}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "h-auto flex-col items-stretch gap-0.5 px-2.5 py-1.5 text-sidebar-foreground",
        "data-[active=true]:bg-sidebar-row-active light:data-[active=true]:ring-1 light:data-[active=true]:ring-inset light:data-[active=true]:ring-sidebar-border/70",
      )}
      render={
        <Link
          to="/editorial/$environmentId/trends/$dossierId"
          params={{ environmentId, dossierId: trend.dossierId }}
          search={{ run: trend.runId }}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
          onContextMenu={
            onContextMenu
              ? (event: ReactMouseEvent) => {
                  event.preventDefault();
                  onContextMenu(trend, { x: event.clientX, y: event.clientY });
                }
              : undefined
          }
        />
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        {trend.isNew ? (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            trend.isNew ? "font-medium text-foreground" : "font-normal",
            recede && "text-foreground/75",
          )}
        >
          {title}
        </span>
        {trend.isNew ? <span className="sr-only">Nueva.</span> : null}
        {production ? <span className="sr-only">En producción.</span> : null}
        {dismissed ? <span className="sr-only">Descartada: {dismissed.reason}.</span> : null}
        <TrendSparkline values={trend.sparkline} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-secondary-label">
        {trend.sources.map((source) => (
          <Badge key={source} size="sm" variant="secondary">
            {sourceLabel(source)}
          </Badge>
        ))}
        <span className="min-w-0 flex-1 truncate">{trend.subtitle}</span>
      </span>
      <span
        className={cn(
          "truncate text-xs font-normal text-secondary-label tabular-nums",
          // Room for the production badge, a sibling over this line.
          production && "pe-22",
        )}
      >
        {trendRowMeta(trend)}
      </span>
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem>
      {dismissed ? (
        <Tooltip>
          <TooltipTrigger render={row} />
          <TooltipPopup side="right">Motivo: {dismissed.reason}</TooltipPopup>
        </Tooltip>
      ) : (
        row
      )}
      {production ? (
        // A sibling of the row link: a link cannot contain another one.
        <Badge
          size="sm"
          variant="info"
          className="absolute end-2.5 bottom-1.5"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: ThreadId.make(production.threadId) }}
              aria-label={`En producción: abrir el hilo de video de ${title}`}
            />
          }
        >
          en producción
        </Badge>
      ) : null}
      {action ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`${action.label}: ${title}`}
                onClick={action.onClick}
                className="pointer-events-none absolute top-1 end-1.5 inline-flex size-6 cursor-pointer items-center justify-center rounded-md bg-sidebar-row-hover text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100"
              />
            }
          >
            <action.Icon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">{action.label}</TooltipPopup>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}
