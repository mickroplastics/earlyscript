import type {
  EditorialResultsComparison,
  EditorialResultsMode,
  EditorialResultsSummary,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { durationAxis } from "./figureExport.logic";
import {
  RESULTS_MODES,
  actionsText,
  emptySideText,
  formatCount,
  formatDuration,
  iqrText,
  meanText,
  medianDifferenceText,
  modeLabel,
  modeSummary,
  provisionalNote,
  sizeText,
} from "./results.logic";
import { ResultsBox, SERIES_BACKGROUND, SERIES_FILL, SeriesSwatch } from "./resultsMarks";
import {
  citationShare,
  compactDurations,
  splitValueUnit,
  stripLayout,
  stripMaxMs,
  timeStripText,
  utilityBars,
  utilityDistributionText,
  type ProcessPoints,
} from "./resultsOverview.logic";

/** The dots of the time card: loading, unavailable (the medians alone), or one per thread. */
export type ProcessPointsState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly points: ProcessPoints | null };

function KpiCard({
  question,
  children,
  chart,
  foot,
}: {
  readonly question: string;
  readonly children: ReactNode;
  readonly chart: ReactNode;
  readonly foot: ReactNode;
}) {
  return (
    <ResultsBox className="flex flex-col gap-3">
      <h2 className="text-xs text-muted-foreground">{question}</h2>
      <div className="grid grid-cols-2 gap-2">{children}</div>
      {chart}
      <div className="mt-auto flex flex-col gap-0.5 border-t border-border pt-2 text-xs text-muted-foreground">
        {foot}
      </div>
    </ResultsBox>
  );
}

/** One mode of a card: its name, the figure large with a small unit, then a line or two. */
function KpiSide({
  mode,
  value,
  unit,
  empty,
  meta,
}: {
  readonly mode: EditorialResultsMode;
  readonly value: string | null;
  readonly unit: string;
  /** Said small in place of the figure when there is none. */
  readonly empty: string;
  readonly meta: ReadonlyArray<string>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-kpi-side={mode}>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SeriesSwatch series={mode} />
        {modeLabel(mode)}
      </span>
      {value === null ? (
        <span className="flex min-h-9 items-center text-xs text-muted-foreground">{empty}</span>
      ) : (
        <span className="flex min-h-9 items-baseline gap-1 whitespace-nowrap">
          <span className="text-3xl leading-tight font-semibold tracking-tight text-foreground tabular-nums">
            {value}
          </span>
          {unit ? <span className="text-sm font-medium text-muted-foreground">{unit}</span> : null}
        </span>
      )}
      {meta.map((line) => (
        <span key={line} className="text-xs text-muted-foreground tabular-nums">
          {line}
        </span>
      ))}
    </div>
  );
}

const STRIP_HEIGHT = 40;
const STRIP_AXIS = STRIP_HEIGHT / 2;
const STRIP_ROW: Readonly<Record<EditorialResultsMode, number>> = { assisted: 10, manual: 30 };
const DOT_RADIUS = 4.5;
const STACK_STEP = 4;

/**
 * One dot per thread on a shared duration scale, assisted above the axis and manual below; a
 * rule at each median. Without dots, the median and the interquartile range alone.
 */
function TimeStrip({
  comparison,
  state,
}: {
  readonly comparison: EditorialResultsComparison;
  readonly state: ProcessPointsState;
}) {
  const points = state._tag === "ready" ? state.points : null;
  const axis = durationAxis(stripMaxMs(points, comparison), formatDuration);
  const x = (ms: number) => `${Math.min(100, Math.max(0, (ms / axis.max) * 100))}%`;
  const labels = compactDurations(axis.ticks.slice(1).map((tick) => tick.label));
  return (
    <div className="flex flex-col gap-1">
      <svg
        role="img"
        aria-label={`Tiempo por ficha, proceso completo. ${timeStripText(points, comparison)}`}
        width="100%"
        height={STRIP_HEIGHT}
        className="overflow-visible"
        data-time-strip={points === null ? "medians" : "dots"}
      >
        <line x1="0" x2="100%" y1={STRIP_AXIS} y2={STRIP_AXIS} className="stroke-border" />
        {RESULTS_MODES.map((mode) => {
          const stats = comparison[mode];
          const row = STRIP_ROW[mode];
          const away = mode === "assisted" ? -1 : 1;
          return (
            <g key={mode}>
              {points === null && stats.q1Ms !== null && stats.q3Ms !== null && stats.n > 1 ? (
                <rect
                  x={x(stats.q1Ms)}
                  y={row - 1.5}
                  width={`${(Math.max(0, stats.q3Ms - stats.q1Ms) / axis.max) * 100}%`}
                  height={3}
                  rx={1.5}
                  className={SERIES_FILL[mode]}
                />
              ) : null}
              {points
                ? stripLayout(points[mode], axis.max).map((dot) => (
                    <circle
                      key={`${dot.ms}:${dot.stack}`}
                      data-dot={mode}
                      cx={`${dot.x * 100}%`}
                      cy={row + away * dot.stack * STACK_STEP}
                      r={DOT_RADIUS}
                      className={SERIES_FILL[mode]}
                    />
                  ))
                : null}
              {stats.medianMs === null ? null : (
                <line
                  x1={x(stats.medianMs)}
                  x2={x(stats.medianMs)}
                  y1={row - 6.5}
                  y2={row + 6.5}
                  strokeWidth={2}
                  strokeLinecap="round"
                  className="stroke-foreground"
                />
              )}
            </g>
          );
        })}
      </svg>
      <div aria-hidden className="relative h-3.5 text-2xs text-muted-foreground tabular-nums">
        <span className="absolute start-0">0</span>
        {axis.ticks.slice(1).map((tick, index) => {
          const last = index === axis.ticks.length - 2;
          return (
            <span
              key={tick.value}
              className={cn("absolute whitespace-nowrap", last ? "end-0" : "-translate-x-1/2")}
              style={last ? undefined : { left: x(tick.value) }}
            >
              {labels[index]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const HISTOGRAM_HEIGHT = 36;

/** Threads per utility score, both modes side by side in each score. */
function UtilityHistogram({ summary }: { readonly summary: EditorialResultsSummary }) {
  return (
    <div className="flex items-end gap-4">
      <div
        role="img"
        aria-label={utilityDistributionText(summary)}
        className="flex items-end gap-3.5"
      >
        {utilityBars(summary).map((group) => (
          <div key={group.score} className="flex flex-col items-center gap-1">
            <div className="flex items-end gap-0.5" style={{ height: HISTOGRAM_HEIGHT }}>
              {RESULTS_MODES.map((mode) => (
                <span
                  key={mode}
                  data-utility-bar={`${mode}:${group.score}`}
                  className={cn(
                    "w-2.5 rounded-t-xs",
                    SERIES_BACKGROUND[mode],
                    group.counts[mode] === 0 && "opacity-25",
                  )}
                  style={{
                    height:
                      group.counts[mode] === 0
                        ? 1
                        : Math.max(2, Math.round(group.heights[mode] * HISTOGRAM_HEIGHT)),
                  }}
                />
              ))}
            </div>
            <span className="text-2xs text-muted-foreground tabular-nums">{group.score}</span>
          </div>
        ))}
      </div>
      <span className="max-w-20 pb-4 text-2xs text-muted-foreground">fichas por puntuación</span>
    </div>
  );
}

/** The share of claims with a marker, assisted on top; the counts are written beside. */
function CitationTracks({ summary }: { readonly summary: EditorialResultsSummary }) {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      {RESULTS_MODES.map((mode) => (
        <span key={mode} className="block h-2.5 overflow-hidden rounded-full bg-muted">
          <span
            className={cn("block h-full rounded-full", SERIES_BACKGROUND[mode])}
            style={{ width: `${citationShare(modeSummary(summary, mode)) * 100}%` }}
          />
        </span>
      ))}
    </div>
  );
}

function TimeCard({
  summary,
  points,
}: {
  readonly summary: EditorialResultsSummary;
  readonly points: ProcessPointsState;
}) {
  const total = summary.comparisons.find((comparison) => comparison.key === "total");
  const provisional = provisionalNote(summary);
  const unavailable = points._tag === "ready" && points.points === null;
  return (
    <KpiCard
      question="Tiempo por ficha · mediana del proceso completo"
      chart={total ? <TimeStrip comparison={total} state={points} /> : null}
      foot={
        <>
          {total ? (
            <span className="font-medium text-foreground tabular-nums">
              {medianDifferenceText(total.assisted, total.manual)}
            </span>
          ) : null}
          <span>
            {unavailable
              ? "Puntos no disponibles: más de 100 decisiones o alguna fuera de dominio."
              : "Un punto por ficha · raya: mediana."}
          </span>
          {provisional ? <span>{provisional}</span> : null}
        </>
      }
    >
      {RESULTS_MODES.map((mode) => {
        const stats = total?.[mode];
        const [value, unit] =
          stats?.medianMs == null ? [null, ""] : splitValueUnit(formatDuration(stats.medianMs));
        const iqr = stats ? iqrText(stats) : null;
        return (
          <KpiSide
            key={mode}
            mode={mode}
            value={value}
            unit={unit}
            empty="Consulta la línea base manual"
            meta={[
              ...(iqr ? [iqr] : []),
              stats
                ? emptySideText(stats, modeSummary(summary, mode)?.provisionalClock ?? 0)
                : "n = 0",
            ]}
          />
        );
      })}
    </KpiCard>
  );
}

/** The three answers first: time per script, utility and cited claims, each mode side by side. */
export function ResultsHero({
  summary,
  points,
}: {
  readonly summary: EditorialResultsSummary;
  readonly points: ProcessPointsState;
}) {
  return (
    <div className="grid gap-3 @3xl:grid-cols-3">
      <TimeCard summary={summary} points={points} />
      <KpiCard
        question="Utilidad registrada por el operador · media, de 1 a 5"
        chart={<UtilityHistogram summary={summary} />}
        foot={<span>Las valoraciones de revisores externos no están aquí.</span>}
      >
        {RESULTS_MODES.map((mode) => {
          const entry = modeSummary(summary, mode);
          return (
            <KpiSide
              key={mode}
              mode={mode}
              value={entry?.utility.mean == null ? null : meanText(entry.utility.mean)}
              unit="de 5"
              empty="sin datos"
              meta={entry ? [actionsText(entry.actions)] : ["n = 0"]}
            />
          );
        })}
      </KpiCard>
      <KpiCard
        question="Frases del guion con marcador de fuente"
        chart={<CitationTracks summary={summary} />}
        foot={<span>Conteo mecánico: no mide si la fuente respalda la frase.</span>}
      >
        {RESULTS_MODES.map((mode) => {
          const entry = modeSummary(summary, mode);
          const citations = entry?.citations;
          return (
            <KpiSide
              key={mode}
              mode={mode}
              value={citations && citations.threads > 0 ? String(citations.cited) : null}
              unit={citations ? `de ${citations.claims}` : ""}
              empty="sin datos"
              meta={[
                citations === undefined
                  ? sizeText(0)
                  : citations.threads > 0
                    ? formatCount(citations.threads, "guion", "guiones")
                    : "sin versión decidida del guion",
              ]}
            />
          );
        })}
      </KpiCard>
    </div>
  );
}
