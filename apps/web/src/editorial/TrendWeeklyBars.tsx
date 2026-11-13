import { cn } from "../lib/utils";
import type { MovementChart, MovementSeries } from "./trendDossier.logic";

// Fixed per source so a source looks the same on every dossier. Not blue: blue is the app's
// action colour (primary button, citations) and a single series would compete with it.
const SOURCE_COLORS: Readonly<Record<string, string>> = {
  hn: "bg-orange-500 dark:bg-orange-400",
  github: "bg-violet-500 dark:bg-violet-400",
  huggingface: "bg-amber-500 dark:bg-amber-300",
  npm: "bg-rose-500 dark:bg-rose-400",
  rss: "bg-teal-600 dark:bg-teal-400",
  total: "bg-primary",
};

export const sourceColor = (source: string) =>
  Object.hasOwn(SOURCE_COLORS, source) ? SOURCE_COLORS[source] : "bg-slate-500 dark:bg-slate-400";

const listFormat = new Intl.ListFormat("es", { type: "conjunction" });

function chartLabel(chart: MovementChart, weekLabels: ReadonlyArray<string>): string {
  const series = chart.series.map(
    (entry) =>
      `${entry.name}: ${listFormat.format(entry.weeks.map((week) => (week === null ? "sin captura" : String(week))))}`,
  );
  const span =
    weekLabels.length === 0
      ? ""
      : `, de la semana del ${weekLabels[0]} a la del ${weekLabels[weekLabels.length - 1]}`;
  return `Publicaciones por semana. ${series.join("; ")}${span}.`;
}

/** Label room above the tallest bar, so its value never leaves the plot. */
const LABEL_ROOM = "1rem";

function Bar({
  series,
  index,
  max,
  last,
}: {
  readonly series: MovementSeries;
  readonly index: number;
  readonly max: number;
  readonly last: boolean;
}) {
  const value = series.weeks[index] ?? null;
  return (
    <div className="flex h-full w-full max-w-6 min-w-0 flex-col items-center justify-end gap-0.5">
      <span
        className={cn(
          "text-2xs leading-none tabular-nums",
          value !== null && value > 0 ? "text-foreground" : "text-muted-foreground/70",
        )}
      >
        {value === null ? (
          <>
            <span aria-hidden>?</span>
            <span className="sr-only">sin captura</span>
          </>
        ) : (
          value
        )}
      </span>
      {value === null ? (
        <div className="h-3 w-full rounded-t-sm border border-dashed border-muted-foreground/50" />
      ) : (
        <div
          className={cn(
            "w-full rounded-t-sm",
            sourceColor(series.source),
            last ? "opacity-100" : "opacity-55",
          )}
          style={{
            height: `calc((100% - ${LABEL_ROOM}) * ${value / max})`,
            minHeight: 2,
          }}
        />
      )}
    </div>
  );
}

/** Weekly bars W3..W0 with their values; no axis, each bar says its number. */
export function TrendWeeklyBars({
  chart,
  weekLabels,
}: {
  readonly chart: MovementChart;
  readonly weekLabels: ReadonlyArray<string>;
}) {
  const weeks = weekLabels.map((_, index) => index);
  return (
    <figure role="img" aria-label={chartLabel(chart, weekLabels)} className="flex flex-col gap-1.5">
      <div className="relative h-32 border-b border-border">
        <div
          aria-hidden
          className="absolute inset-x-0 h-px bg-border/50"
          style={{ bottom: `calc((100% - ${LABEL_ROOM}) / 2)` }}
        />
        <div className="relative grid h-full grid-cols-4 gap-3">
          {weeks.map((index) => (
            <div key={index} className="flex h-full items-end justify-center gap-0.5">
              {chart.series.map((series) => (
                <Bar
                  key={series.source}
                  series={series}
                  index={index}
                  max={chart.max}
                  last={index === weeks.length - 1}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {weekLabels.map((label, index) => (
          <span
            key={label}
            className={cn(
              "text-center text-2xs leading-tight",
              index === weekLabels.length - 1
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {label}
          </span>
        ))}
      </div>
    </figure>
  );
}
