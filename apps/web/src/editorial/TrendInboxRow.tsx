import type { EditorialTrendSummary, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";

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

export function TrendInboxRow({
  environmentId,
  trend,
  isActive,
}: {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
  readonly isActive: boolean;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const presentation = trend.presentation;
  const stale = presentation?.status === "stale";
  return (
    <SidebarMenuItem>
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
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          {presentation ? (
            // The assistant's title replaces the engine label; the engine's words stay one hover away.
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    data-presentation-title=""
                    data-stale={stale ? "" : undefined}
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm",
                      stale ? "text-muted-foreground" : "text-foreground",
                      trend.isNew ? "font-medium" : "font-normal",
                    )}
                  />
                }
              >
                {presentation.title}
              </TooltipTrigger>
              <TooltipPopup side="right" className="max-w-72">
                {stale
                  ? "Desactualizado: se redactó sobre otra evidencia, perfil o prompt · "
                  : null}
                Redactado por el asistente · términos del motor: {trend.label}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm text-foreground",
                trend.isNew ? "font-medium" : "font-normal",
              )}
            >
              {trend.label}
            </span>
          )}
          {presentation ? (
            <span className="sr-only">
              {stale ? "Redacción desactualizada. " : null}Términos del motor: {trend.label}.
            </span>
          ) : null}
          {stale ? <HistoryIcon aria-hidden className="size-3 shrink-0 text-warning" /> : null}
          {trend.isNew ? <span className="sr-only">Nueva.</span> : null}
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
        <span className="truncate text-xs font-normal text-secondary-label tabular-nums">
          {trendRowMeta(trend)}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
