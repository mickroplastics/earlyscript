import type {
  EditorialDurationStats,
  EditorialResultsComparison,
  EditorialResultsMode,
  EditorialResultsSummary,
} from "@t3tools/contracts";

import {
  durationAxis,
  type FigureBarGroup,
  type FigureBarRow,
  type FigureBody,
  type FigureSeries,
} from "./figureExport.logic";
import {
  COMPARISON_TEXT,
  RESULTS_MODES,
  RESULTS_STAGES,
  actionsText,
  citationDetail,
  coverageNote,
  formatDuration,
  formatPercent,
  medianDifferenceText,
  modeLabel,
  modeSummary,
  stageChartMaxMs,
  stageLabel,
  stageStats,
  statsText,
  utilityText,
} from "./results.logic";

/** The two modes as print series: assisted blue, manual grey, as on the page. */
const MODE_SERIES: ReadonlyArray<FigureSeries> = RESULTS_MODES.map((mode) => ({
  key: mode,
  label: modeLabel(mode),
  color: mode === "assisted" ? "primary" : "neutral",
}));

/** Threads closed in both modes: the n of the provenance line. */
export function resultsThreadCount(summary: EditorialResultsSummary): number {
  return summary.modes.reduce((sum, mode) => sum + mode.threads, 0);
}

function barRow(
  mode: EditorialResultsMode,
  stats: EditorialDurationStats | undefined,
): FigureBarRow {
  return {
    series: mode,
    value: stats?.medianMs ?? null,
    // The page draws the whisker only with more than one thread; the print does the same.
    low: stats && stats.n > 1 ? stats.q1Ms : null,
    high: stats && stats.n > 1 ? stats.q3Ms : null,
    text: stats ? statsText(stats) : "sin datos",
  };
}

const BAR_NOTES = [
  "Barra: mediana",
  "Trazo: rango intercuartílico (RIC)",
  "Línea discontinua: sin registro en ese modo",
];

function comparisonGroup(comparison: EditorialResultsComparison): FigureBarGroup {
  const difference = medianDifferenceText(comparison.assisted, comparison.manual);
  const note = [difference, coverageNote(comparison)].filter((part) => part !== null).join(". ");
  return {
    label: COMPARISON_TEXT[comparison.key].title,
    rows: [barRow("assisted", comparison.assisted), barRow("manual", comparison.manual)],
    ...(note.length > 0 ? { note } : {}),
  };
}

function maxOf(stats: ReadonlyArray<EditorialDurationStats>): number {
  return Math.max(0, ...stats.flatMap((entry) => [entry.q3Ms ?? 0, entry.medianMs ?? 0]));
}

/**
 * «Tiempo por ficha»: the comparison cards and the recorded total as median bars per mode, on
 * one duration scale. The difference of medians stays in words under each group.
 */
export function timesFigure(summary: EditorialResultsSummary): FigureBody {
  const groups = summary.comparisons.map(comparisonGroup);
  const max = maxOf(summary.comparisons.flatMap((entry) => [entry.assisted, entry.manual]));
  return {
    kind: "bars",
    series: MODE_SERIES,
    groups,
    axis: durationAxis(max, formatDuration),
    notes: BAR_NOTES,
  };
}

/** «Mediana por etapa»: the stage chart of the page, same scale rule. */
export function stagesFigure(summary: EditorialResultsSummary): FigureBody {
  return {
    kind: "bars",
    series: MODE_SERIES,
    groups: RESULTS_STAGES.map((stage) => ({
      label: stageLabel(stage),
      rows: RESULTS_MODES.map((mode) =>
        barRow(mode, stageStats(modeSummary(summary, mode), stage)),
      ),
    })),
    axis: durationAxis(stageChartMaxMs(summary), formatDuration),
    notes: BAR_NOTES,
  };
}

/** «Utilidad y citas»: the four tiles of the page. */
export function utilityFigure(summary: EditorialResultsSummary): FigureBody {
  const entries = RESULTS_MODES.flatMap((mode) => {
    const entry = modeSummary(summary, mode);
    return entry ? [{ mode, entry }] : [];
  });
  return {
    kind: "metrics",
    series: MODE_SERIES,
    metrics: [
      ...entries.map(({ mode, entry }) => ({
        label: `Utilidad media, ${modeLabel(mode).toLowerCase()}`,
        value: utilityText(entry),
        detail: `n = ${entry.utility.n} · ${actionsText(entry.actions)}`,
        series: mode,
      })),
      ...entries.map(({ mode, entry }) => ({
        label: `Afirmaciones con cita, ${modeLabel(mode).toLowerCase()}`,
        value: entry.citations.ratio === null ? "sin datos" : formatPercent(entry.citations.ratio),
        detail: citationDetail(entry),
        series: mode,
      })),
    ],
    notes: [
      "Utilidad registrada por el operador, de 1 a 5",
      "Con cita: conteo mecánico de marcadores",
    ],
  };
}

/** «Bandeja de tendencias»: the four independent counters. */
export function inboxFigure(summary: EditorialResultsSummary): FigureBody {
  const { inbox } = summary;
  return {
    kind: "metrics",
    metrics: [
      { label: "Leídas", value: String(inbox.read), detail: "abiertas al menos una vez" },
      {
        label: "En observación",
        value: String(inbox.observing),
        detail: "seguir observando, sin descartar",
      },
      { label: "Descartadas", value: String(inbox.dismissed), detail: "con motivo registrado" },
      {
        label: "En producción",
        value: String(inbox.production),
        detail: "enlazadas a un hilo de video",
      },
    ],
    notes: ["Conteos independientes: una tendencia leída puede estar también en producción"],
  };
}

/** «Métricas de video»: threads with at least one observation, per mode. */
export function videoFigure(summary: EditorialResultsSummary): FigureBody {
  return {
    kind: "metrics",
    series: MODE_SERIES,
    columns: 2,
    metrics: RESULTS_MODES.flatMap((mode) => {
      const entry = modeSummary(summary, mode);
      return entry
        ? [
            {
              label: `Con métricas, ${modeLabel(mode).toLowerCase()}`,
              value: `${entry.withVideoResults} de ${entry.threads}`,
              detail: "hilos con al menos una observación",
              series: mode,
            },
          ]
        : [];
    }),
    notes: ["Registradas a mano; no se atribuyen al sistema ni al modo de trabajo"],
  };
}

/** Figure titles and captions of the Results page, kept apart from the page layout. */
export const RESULTS_FIGURE_TEXT = {
  tiempos: {
    title: "Tiempo activo por ficha, asistido frente a manual",
    caption:
      "Mediana y rango intercuartílico del tiempo activo registrado por el reloj de cada hilo, sin pausas, sobre la decisión vigente de cada hilo. Hilos y temas distintos en cada modo: la comparación es descriptiva, no un efecto del sistema.",
  },
  etapas: {
    title: "Mediana de tiempo activo por etapa",
    caption:
      "Mediana y rango intercuartílico por etapa y modo, en una escala común. Una etapa sin registro en un modo aparece como línea discontinua, no como cero.",
  },
  utilidad: {
    title: "Utilidad y afirmaciones con cita",
    caption:
      "Utilidad media registrada por el operador al decidir (escala de 1 a 5) y proporción de oraciones del guion decidido con marcador de evidencia. El conteo de citas es mecánico: no mide si la fuente respalda la afirmación. Sin valoraciones de revisores externos.",
  },
  bandeja: {
    title: "Bandeja de tendencias",
    caption:
      "Tendencias leídas, en observación, descartadas y en producción. Los conteos son independientes entre sí.",
  },
  video: {
    title: "Hilos con métricas de video",
    caption:
      "Hilos cerrados con al menos una observación de métricas de video registrada a mano. Descriptivo: no se atribuye al sistema ni al modo de trabajo.",
  },
} as const;
