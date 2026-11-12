import type {
  EditorialDurationStats,
  EditorialResultsComparison,
  EditorialResultsMode,
  EditorialResultsSummary,
} from "@t3tools/contracts";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { cn } from "../../lib/utils";
import { FigureFrame } from "./FigureFrame";
import { RESULTS_FIGURE_TEXT, stagesFigure, timesFigure } from "./resultsFigures.logic";
import {
  COMPARISON_TEXT,
  RESULTS_MODES,
  RESULTS_STAGES,
  comparisonCards,
  coverageNote,
  emptySideText,
  formatDuration,
  iqrText,
  medianDifferenceText,
  modeLabel,
  modeSummary,
  provisionalNote,
  recordedTotalText,
  sizeText,
  stageLabel,
  stageStats,
  statsText,
} from "./results.logic";
import { ResultsDisclosure } from "./ResultsDisclosure";
import {
  MedianBarRow,
  ResultsBox,
  ResultsNote,
  STAGE_BAR_COLUMNS,
  SeriesSwatch,
} from "./resultsMarks";
import { stageChartWithTotalMaxMs } from "./resultsOverview.logic";
import { PanelLead, PanelLeadText } from "./ResultsTabs";

function comparisonOf(summary: EditorialResultsSummary, key: EditorialResultsComparison["key"]) {
  return summary.comparisons.find((comparison) => comparison.key === key);
}

/** One side of a phase card: the median large, then its spread and n on one line. */
function ComparisonSide({
  mode,
  stats,
  provisional,
}: {
  readonly mode: EditorialResultsMode;
  readonly stats: EditorialDurationStats;
  readonly provisional: number;
}) {
  const iqr = iqrText(stats);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SeriesSwatch series={mode} />
        {modeLabel(mode)}
      </span>
      <span
        className={
          stats.medianMs === null
            ? "text-xs text-muted-foreground"
            : "text-lg leading-tight font-semibold text-foreground tabular-nums"
        }
      >
        {stats.medianMs === null ? "Consulta la línea base manual" : formatDuration(stats.medianMs)}
      </span>
      {iqr ? <span className="text-xs text-muted-foreground tabular-nums">{iqr}</span> : null}
      <span className="text-xs text-muted-foreground tabular-nums">
        {emptySideText(stats, provisional)}
      </span>
    </div>
  );
}

function ComparisonCard({
  comparison,
  summary,
}: {
  readonly comparison: EditorialResultsComparison;
  readonly summary: EditorialResultsSummary;
}) {
  const text = COMPARISON_TEXT[comparison.key];
  return (
    <ResultsBox data-comparison={comparison.key} className="flex flex-col gap-3 p-3.5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-xs font-medium text-foreground">{text.title}</h3>
        <p className="text-xs text-muted-foreground">{text.measures}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {RESULTS_MODES.map((mode) => (
          <ComparisonSide
            key={mode}
            mode={mode}
            stats={comparison[mode]}
            provisional={modeSummary(summary, mode)?.provisionalClock ?? 0}
          />
        ))}
      </div>
      <p className="mt-auto border-t border-border pt-2 text-xs text-muted-foreground tabular-nums">
        {medianDifferenceText(comparison.assisted, comparison.manual)}
      </p>
    </ResultsBox>
  );
}

/** Every timed thread, partial ones included, kept apart from the whole process. */
function RecordedTotal({ comparison }: { readonly comparison: EditorialResultsComparison }) {
  const coverage = coverageNote(comparison);
  return (
    <p data-comparison={comparison.key} className="text-xs text-muted-foreground tabular-nums">
      {recordedTotalText(comparison)}.{coverage ? ` ${coverage}` : null}
    </p>
  );
}

function medianText(stats: EditorialDurationStats | undefined) {
  return stats?.medianMs == null ? "sin datos" : formatDuration(stats.medianMs);
}

/**
 * The stages as median bars per mode on one scale, then the whole process apart under a rule:
 * the same figure as «Mediana por etapa», plus the total the overview card states.
 */
function StageChart({ summary }: { readonly summary: EditorialResultsSummary }) {
  const total = comparisonOf(summary, "total");
  const maxMs = stageChartWithTotalMaxMs(summary, total);
  const groups = [
    ...RESULTS_STAGES.map((stage) => ({
      key: stage,
      label: stageLabel(stage),
      detail: null,
      stats: (mode: EditorialResultsMode) => stageStats(modeSummary(summary, mode), stage),
    })),
    ...(total
      ? [
          {
            key: "total",
            label: "Total",
            detail: "proceso completo",
            stats: (mode: EditorialResultsMode) => total[mode],
          },
        ]
      : []),
  ];
  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <div
        role="img"
        aria-label="Mediana de tiempo activo por etapa y del proceso completo, asistido frente a manual. Los mismos datos están en la tabla por etapa y en las tarjetas por fase."
        className="flex flex-col gap-3"
      >
        {groups.map((group) => (
          <div
            key={group.key}
            className={cn(
              "flex flex-col gap-1.5",
              group.key === "total" && "border-t border-border pt-3",
            )}
          >
            {RESULTS_MODES.map((mode, index) => {
              const stats = group.stats(mode);
              const where = group.detail ? `${group.label}, ${group.detail}` : group.label;
              return (
                <MedianBarRow
                  key={mode}
                  columns={STAGE_BAR_COLUMNS}
                  group={
                    index === 0 ? (
                      group.label
                    ) : group.detail ? (
                      <span className="text-2xs text-muted-foreground">{group.detail}</span>
                    ) : null
                  }
                  series={mode}
                  label={modeLabel(mode)}
                  stats={stats}
                  maxMs={maxMs}
                  tooltip={`${modeLabel(mode)}, ${where}: ${stats ? statsText(stats) : "sin datos"}`}
                  value={medianText(stats)}
                  size={sizeText(stats?.n ?? 0)}
                  barProps={{ "data-stage-bar": `${mode}:${group.key}` }}
                />
              );
            })}
          </div>
        ))}
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        {RESULTS_MODES.map((mode) => (
          <span key={mode} className="flex items-center gap-1.5">
            <SeriesSwatch series={mode} />
            {modeLabel(mode)}
          </span>
        ))}
        <span>Línea discontinua: sin hilos medidos en esa etapa y modo</span>
        <span className="tabular-nums">Escala común hasta {formatDuration(maxMs)}</span>
      </figcaption>
    </figure>
  );
}

function StageTable({ summary }: { readonly summary: EditorialResultsSummary }) {
  const rows = [
    ...RESULTS_STAGES.map((stage) => ({
      key: stage,
      label: stageLabel(stage),
      stats: (mode: EditorialResultsMode) => stageStats(modeSummary(summary, mode), stage),
    })),
    {
      key: "total",
      label: "Total registrado",
      stats: (mode: EditorialResultsMode) => modeSummary(summary, mode)?.total,
    },
  ];
  return (
    <Table aria-label="Tiempo activo por etapa y modo">
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Etapa</TableHead>
          {RESULTS_MODES.map((mode) => (
            <TableHead key={mode}>{modeLabel(mode)}: mediana · RIC · n</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.key}>
            <TableCell>{row.label}</TableCell>
            {RESULTS_MODES.map((mode) => {
              const stats = row.stats(mode);
              return (
                <TableCell key={mode}>
                  <span className="tabular-nums">{stats ? statsText(stats) : "sin datos"}</span>
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** «Tiempo por etapa»: where the time goes, the three phases, the recorded total, the table. */
export function TimeTab({ summary }: { readonly summary: EditorialResultsSummary }) {
  const recorded = comparisonOf(summary, "recorded");
  const provisional = provisionalNote(summary);
  return (
    <>
      <PanelLead
        title="¿Dónde se va el tiempo?"
        action={
          <FigureFrame
            id="etapas"
            variant="menu"
            {...RESULTS_FIGURE_TEXT.etapas}
            figure={stagesFigure(summary)}
          />
        }
      >
        <PanelLeadText>
          Mediana de tiempo activo por etapa, medido por el reloj del hilo, sin pausas. La barra es
          la mediana; el trazo, la mitad central de los hilos.
        </PanelLeadText>
      </PanelLead>
      <ResultsBox>
        <StageChart summary={summary} />
      </ResultsBox>

      <div className="flex min-w-0 flex-col gap-3 pt-2">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <h3 className="text-xs font-medium text-foreground">
            Por fase · mediana de cada modo, con su diferencia
          </h3>
          <FigureFrame
            id="tiempos"
            variant="menu"
            {...RESULTS_FIGURE_TEXT.tiempos}
            figure={timesFigure(summary)}
          />
        </div>
        <div className="grid gap-3 @3xl:grid-cols-3">
          {comparisonCards(summary.comparisons).map((comparison) => (
            <ComparisonCard key={comparison.key} comparison={comparison} summary={summary} />
          ))}
        </div>
        {recorded ? <RecordedTotal comparison={recorded} /> : null}
        <ResultsNote>
          Tiempo activo registrado por el reloj del hilo, sin pausas.
          {provisional ? ` ${provisional}` : null}
        </ResultsNote>
      </div>

      <ResultsDisclosure title="Tabla por etapa" subtitle="mediana · RIC · n">
        <StageTable summary={summary} />
        <ResultsNote>
          RIC: rango intercuartílico, del primer al tercer cuartil (la mitad central de los hilos);
          solo con dos hilos o más. Sobre la decisión vigente de cada hilo.
        </ResultsNote>
      </ResultsDisclosure>
    </>
  );
}
