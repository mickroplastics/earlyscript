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
import {
  ResultsBox,
  SERIES_BACKGROUND,
  SERIES_FILL,
  SeriesSwatch,
  TRACK_BACKGROUND,
} from "./resultsMarks";
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
  type StripDot,
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
    <ResultsBox className="flex flex-col gap-3 @3xl:row-span-4 @3xl:grid @3xl:grid-rows-subgrid">
      <h2 className="text-xs text-balance text-muted-foreground">{question}</h2>
      <div className="grid grid-cols-2 gap-2">{children}</div>
      <div className="flex min-w-0 flex-col justify-end">{chart}</div>
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

const DOT_RADIUS = 4;
/** One dot's height and a hair: stacked dots touch without overlapping. */
const STACK_STEP = 9;
/** From the axis to the centre of the first dot of each mode. */
const ROW_OFFSET = 7;
/** Room above and below the outer dots for the median rule. */
const STRIP_EDGE = 7;
/**
 * Closest two dots may sit on one row, as a share of the scale: a dot and a hair on the
 * narrowest card (about 220 px of strip).
 */
const DOT_GAP = (2 * DOT_RADIUS + 1) / 220;

const outerStack = (dots: ReadonlyArray<StripDot>) =>
  dots.reduce((outer, dot) => Math.max(outer, dot.stack), 0);

/**
 * One dot per thread on a shared duration scale, assisted above the axis and manual below; dots
 * too close to tell apart stack outwards, never sideways. A rule at each median. Without dots,
 * the median and the interquartile range alone.
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
  const dots: Readonly<Record<EditorialResultsMode, ReadonlyArray<StripDot>>> = {
    assisted: points ? stripLayout(points.assisted, axis.max, DOT_GAP) : [],
    manual: points ? stripLayout(points.manual, axis.max, DOT_GAP) : [],
  };
  const axisY = STRIP_EDGE + ROW_OFFSET + outerStack(dots.assisted) * STACK_STEP;
  const height = axisY + ROW_OFFSET + outerStack(dots.manual) * STACK_STEP + STRIP_EDGE;
  return (
    // The end padding leaves the last tick's label room to sit centred on its tick.
    <div className="flex flex-col gap-1 pe-5">
      <svg
        role="img"
        aria-label={`Tiempo por ficha, proceso completo. ${timeStripText(points, comparison)}`}
        width="100%"
        height={height}
        className="overflow-visible"
        data-time-strip={points === null ? "medians" : "dots"}
      >
        <line x1="0" x2="100%" y1={axisY} y2={axisY} className="stroke-border" />
        {RESULTS_MODES.map((mode) => {
          const stats = comparison[mode];
          const away = mode === "assisted" ? -1 : 1;
          const row = axisY + away * ROW_OFFSET;
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
              {dots[mode].map((dot) => (
                <circle
                  key={`${dot.ms}:${dot.stack}`}
                  data-dot={mode}
                  cx={`${dot.x * 100}%`}
                  cy={row + away * dot.stack * STACK_STEP}
                  r={DOT_RADIUS}
                  className={SERIES_FILL[mode]}
                />
              ))}
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
        {axis.ticks.slice(1).map((tick, index) => (
          <span
            key={tick.value}
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: x(tick.value) }}
          >
            {labels[index]}
          </span>
        ))}
      </div>
    </div>
  );
}

const HISTOGRAM_HEIGHT = 40;

/**
 * Threads per utility score, both modes side by side in each score, on one baseline: a score
 * nobody gave has no column.
 */
function UtilityHistogram({ summary }: { readonly summary: EditorialResultsSummary }) {
  const groups = utilityBars(summary);
  return (
    <div className="flex items-end gap-4">
      <div role="img" aria-label={utilityDistributionText(summary)} className="flex flex-col gap-1">
        <div
          className="flex items-end gap-3.5 border-b border-border"
          style={{ height: HISTOGRAM_HEIGHT }}
        >
          {groups.map((group) => (
            <div key={group.score} className="flex w-5.5 items-end justify-center gap-0.5">
              {RESULTS_MODES.map((mode) => (
                <span
                  key={mode}
                  data-utility-bar={`${mode}:${group.score}`}
                  className={cn("w-2.5 rounded-t-xs", SERIES_BACKGROUND[mode])}
                  style={{
                    height:
                      group.counts[mode] === 0
                        ? 0
                        : Math.max(2, Math.round(group.heights[mode] * HISTOGRAM_HEIGHT)),
                  }}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="flex gap-3.5 text-2xs text-muted-foreground tabular-nums">
          {groups.map((group) => (
            <span key={group.score} className="w-5.5 text-center">
              {group.score}
            </span>
          ))}
        </div>
      </div>
      <span className="max-w-20 pb-4 text-2xs text-muted-foreground">fichas por puntuación</span>
    </div>
  );
}

/** The share of claims with a marker, assisted on top; the counts are written beside. */
function CitationTracks({ summary }: { readonly summary: EditorialResultsSummary }) {
  return (
    <div aria-hidden className="my-auto flex flex-col gap-3">
      {RESULTS_MODES.map((mode) => (
        <span key={mode} className={cn("block h-3 overflow-hidden rounded-full", TRACK_BACKGROUND)}>
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

/**
 * The three answers first: time per script, utility and cited claims, each mode side by side.
 * The cards share their rows (question, figures, chart, foot) so each line reads across.
 */
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
        question={"Utilidad registrada por el operador · media, de 1\u00a0a\u00a05"}
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
