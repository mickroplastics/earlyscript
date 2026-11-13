import type { EditorialResultsSummary } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { FigureFrame } from "./FigureFrame";
import { RESULTS_FIGURE_TEXT, inboxFigure, videoFigure } from "./resultsFigures.logic";
import { RESULTS_MODES, modeLabel, modeSummary, videoCoverageText } from "./results.logic";
import { ResultsBox, SeriesSwatch } from "./resultsMarks";
import { hasVideoResults } from "./resultsOverview.logic";
import { PanelLead, PanelLeadText } from "./ResultsTabs";

function ResultsMetric({
  label,
  value,
  detail,
  muted = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly muted?: boolean;
}) {
  return (
    <ResultsBox className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-2xl leading-tight font-semibold tabular-nums",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </ResultsBox>
  );
}

/** Same order and words as the exported figure. */
const INBOX_METRICS = [
  { key: "read", label: "Leídas", detail: "abiertas al menos una vez" },
  { key: "observing", label: "En observación", detail: "seguir observando, sin descartar" },
  { key: "dismissed", label: "Descartadas", detail: "con motivo registrado" },
  { key: "production", label: "En producción", detail: "enlazadas a un hilo de video" },
] as const;

function VideoMetrics({ summary }: { readonly summary: EditorialResultsSummary }) {
  const entries = RESULTS_MODES.flatMap((mode) => {
    const entry = modeSummary(summary, mode);
    return entry ? [{ mode, entry }] : [];
  });
  if (!hasVideoResults(summary)) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-7 gap-y-3 rounded-xl border border-dashed border-border p-4">
        {entries.map(({ mode, entry }) => (
          <div key={mode} className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <SeriesSwatch series={mode} />
              Con métricas, {modeLabel(mode).toLowerCase()}
            </span>
            <span className="text-xl leading-tight font-semibold text-foreground tabular-nums">
              {videoCoverageText(entry)}
            </span>
          </div>
        ))}
        <p className="max-w-md min-w-0 flex-1 basis-64 text-xs text-muted-foreground">
          Todavía ningún hilo cerrado tiene una observación de video. Cuando se registre, aparecerá
          aquí y en la columna Vistas de Decisiones.
        </p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
      {entries.map(({ mode, entry }) => (
        <ResultsMetric
          key={mode}
          label={`Con métricas, ${modeLabel(mode).toLowerCase()}`}
          value={videoCoverageText(entry)}
          detail="hilos con al menos una observación"
        />
      ))}
    </div>
  );
}

/** «Bandeja y video»: the inbox counters, then the video metrics once there are decisions. */
export function InboxVideoTab({
  summary,
  withVideo,
}: {
  readonly summary: EditorialResultsSummary;
  /** Before the first decision there is no thread to have video metrics. */
  readonly withVideo: boolean;
}) {
  return (
    <>
      <PanelLead
        title="Bandeja de tendencias"
        action={
          <FigureFrame
            id="bandeja"
            variant="menu"
            {...RESULTS_FIGURE_TEXT.bandeja}
            figure={inboxFigure(summary)}
          />
        }
      >
        <PanelLeadText>
          Los conteos son independientes: una tendencia leída puede estar también en producción.
        </PanelLeadText>
      </PanelLead>
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {INBOX_METRICS.map((metric) => (
          <ResultsMetric
            key={metric.key}
            label={metric.label}
            value={String(summary.inbox[metric.key])}
            detail={metric.detail}
            muted={summary.inbox[metric.key] === 0}
          />
        ))}
      </div>
      {withVideo ? (
        <>
          <div className="pt-4">
            <PanelLead
              title="Métricas de video"
              action={
                <FigureFrame
                  id="video"
                  variant="menu"
                  {...RESULTS_FIGURE_TEXT.video}
                  figure={videoFigure(summary)}
                />
              }
            >
              <PanelLeadText>
                Se registran a mano en el hilo cerrado. Son descriptivas: no se atribuyen al sistema
                ni al modo de trabajo.
              </PanelLeadText>
            </PanelLead>
          </div>
          <VideoMetrics summary={summary} />
        </>
      ) : null}
    </>
  );
}
