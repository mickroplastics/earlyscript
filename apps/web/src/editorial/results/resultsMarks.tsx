import type { EditorialDurationStats, EditorialResultsMode } from "@t3tools/contracts";
import type { ComponentProps, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import type { BaselineSeries } from "./manualBaseline.logic";

type SeriesMark = EditorialResultsMode | BaselineSeries;

/** Assisted wears the primary hue; manual the neutral ink, lighter when it is an estimate. */
export const SERIES_FILL: Readonly<Record<SeriesMark, string>> = {
  assisted: "fill-primary",
  manual: "fill-muted-foreground/70",
  cronometrado: "fill-muted-foreground/70",
  reconstruido: "fill-muted-foreground/30",
};
export const SERIES_BACKGROUND: Readonly<Record<SeriesMark, string>> = {
  assisted: "bg-primary",
  manual: "bg-muted-foreground/70",
  cronometrado: "bg-muted-foreground/70",
  reconstruido: "bg-muted-foreground/30",
};

/** The colour key of a series; its name is always written beside it. */
export function SeriesSwatch({ series }: { readonly series: SeriesMark }) {
  return (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", SERIES_BACKGROUND[series])} />
  );
}

/** The surface of every box on the page; `components/ui` has no card. */
export function ResultsBox({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("min-w-0 rounded-xl border border-border bg-card p-4", className)}
      {...props}
    />
  );
}

/** A short note under a box: muted, small, with the key words set apart by `<b>`. */
export function ResultsNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
      {children}
    </p>
  );
}

const BAR_HEIGHT = 10;
const ROW_HEIGHT = 14;

/** Four columns shared by the stage and baseline charts: group, series, bar, value. */
export const STAGE_BAR_COLUMNS = "grid-cols-[7rem_5.5rem_minmax(0,1fr)_9rem]";
export const BASELINE_BAR_COLUMNS = "grid-cols-[7rem_8.5rem_minmax(0,1fr)_9rem]";

/**
 * One row of a median chart: the median as the bar, the interquartile range as a thin whisker,
 * a dashed line when the series has no thread. `group` names the first row of a group only.
 */
export function MedianBarRow({
  columns,
  group,
  series,
  label,
  stats,
  maxMs,
  tooltip,
  value,
  size,
  barProps,
}: {
  readonly columns: string;
  readonly group: ReactNode;
  readonly series: SeriesMark;
  readonly label: string;
  readonly stats: EditorialDurationStats | null | undefined;
  readonly maxMs: number;
  readonly tooltip: string;
  readonly value: string;
  readonly size: string;
  /** Marks the bar's `<svg>` for tests and tools, such as `data-stage-bar`. */
  readonly barProps: Readonly<Record<`data-${string}`, string>>;
}) {
  const percent = (ms: number) => `${Math.min(100, (ms / maxMs) * 100)}%`;
  const median = stats?.medianMs ?? null;
  return (
    <div className={cn("grid items-center gap-x-2.5", columns)}>
      <span className="min-w-0 self-start text-xs text-foreground">{group}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-2xs whitespace-nowrap text-muted-foreground">
        <SeriesSwatch series={series} />
        {label}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <svg
              aria-hidden
              {...barProps}
              width="100%"
              height={ROW_HEIGHT}
              className="overflow-visible"
            />
          }
        >
          {median === null ? (
            <line
              x1="0"
              x2="100%"
              y1={ROW_HEIGHT / 2}
              y2={ROW_HEIGHT / 2}
              className="stroke-border"
              strokeDasharray="2 3"
            />
          ) : (
            <>
              <rect
                x="0"
                y={(ROW_HEIGHT - BAR_HEIGHT) / 2}
                width={percent(median)}
                height={BAR_HEIGHT}
                rx={2}
                className={SERIES_FILL[series]}
              />
              {stats?.q1Ms != null && stats.q3Ms != null && stats.n > 1 ? (
                <line
                  data-iqr=""
                  x1={percent(stats.q1Ms)}
                  x2={percent(stats.q3Ms)}
                  y1={ROW_HEIGHT / 2}
                  y2={ROW_HEIGHT / 2}
                  strokeWidth={2}
                  strokeLinecap="round"
                  className="stroke-foreground/70"
                />
              ) : null}
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <span
        className={cn(
          "truncate text-xs tabular-nums",
          median === null ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
        <span className="text-muted-foreground"> · {size}</span>
      </span>
    </div>
  );
}
