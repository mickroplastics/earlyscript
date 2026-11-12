import type { EditorialResultsMode, EditorialResultsSummary } from "@t3tools/contracts";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { cn } from "../../lib/utils";
import { ThreadCell, type ResultsDecisionsState } from "./DecisionsTab";
import { FigureFrame } from "./FigureFrame";
import { RESULTS_FIGURE_TEXT, utilityFigure } from "./resultsFigures.logic";
import { RESULTS_MODES, meanText, modeLabel, modeSummary } from "./results.logic";
import { ResultsBox, ResultsNote, SERIES_BACKGROUND, SeriesSwatch } from "./resultsMarks";
import { rowDateText, scriptRows } from "./resultsOverview.logic";
import { PanelLead, PanelLeadText } from "./ResultsTabs";

/** «Asistido · utilidad media 5,0 · 193 de 206 con cita», from the summary. */
function modeHeading(summary: EditorialResultsSummary, mode: EditorialResultsMode): string {
  const entry = modeSummary(summary, mode);
  const utility =
    entry?.utility.mean == null ? "sin utilidad" : `utilidad media ${meanText(entry.utility.mean)}`;
  const cited = entry
    ? `${entry.citations.cited} de ${entry.citations.claims} con cita`
    : "sin guion";
  return `${modeLabel(mode)} · ${utility} · ${cited}`;
}

function ScriptsTable({
  mode,
  state,
  reference,
  threadTitles,
}: {
  readonly mode: EditorialResultsMode;
  readonly state: Extract<ResultsDecisionsState, { _tag: "ready" }>;
  readonly reference: string | null;
  readonly threadTitles: ReadonlyMap<string, string>;
}) {
  const rows = scriptRows(state.page.decisions, mode);
  if (rows.length === 0) {
    return <p className="py-2 text-xs text-muted-foreground">Ningún hilo cerrado en este modo.</p>;
  }
  return (
    <Table aria-label={`Guiones decididos, ${modeLabel(mode).toLowerCase()}`}>
      <TableHeader>
        <TableRow>
          <TableHead>Hilo</TableHead>
          <TableHead>Decidido</TableHead>
          <TableHead className="w-24">Frases con cita</TableHead>
          <TableHead className="text-end">Con cita</TableHead>
          <TableHead className="text-end">Út.</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((decision) => {
          const script = decision.script;
          const share = script && script.claims > 0 ? script.cited / script.claims : 0;
          return (
            <TableRow key={decision.decisionId} data-script-row={decision.threadId}>
              <TableCell>
                <ThreadCell
                  decision={decision}
                  title={threadTitles.get(decision.threadId)}
                  className="max-w-36"
                />
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground tabular-nums">
                  {rowDateText(decision.decidedAt, reference)}
                </span>
              </TableCell>
              <TableCell>
                <span
                  aria-hidden
                  className="block h-1.5 w-20 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className={cn("block h-full rounded-full", SERIES_BACKGROUND[mode])}
                    style={{ width: `${share * 100}%` }}
                  />
                </span>
              </TableCell>
              <TableCell className="text-end">
                <span className={cn("tabular-nums", script === null && "text-muted-foreground")}>
                  {script === null ? "sin guion" : `${script.cited} de ${script.claims}`}
                </span>
              </TableCell>
              <TableCell className="text-end">
                <span className="tabular-nums">{decision.utility}</span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** «Utilidad y citas»: one decided script per row, side by side per mode. */
export function QualityTab({
  summary,
  scripts,
  onRetry,
  threadTitles,
}: {
  readonly summary: EditorialResultsSummary;
  readonly scripts: ResultsDecisionsState;
  readonly onRetry: () => void;
  readonly threadTitles: ReadonlyMap<string, string>;
}) {
  return (
    <>
      <PanelLead
        title="¿Qué tan útiles y citados salieron los guiones?"
        action={
          <FigureFrame
            id="utilidad"
            variant="menu"
            {...RESULTS_FIGURE_TEXT.utilidad}
            figure={utilityFigure(summary)}
          />
        }
      >
        <PanelLeadText>
          Un guion por fila. Utilidad: la que registró el operador al decidir. Con cita: frases del
          guion decidido que llevan un marcador de fuente.
        </PanelLeadText>
      </PanelLead>
      {scripts._tag === "failure" ? (
        <Alert variant="error">
          <AlertTitle>No se pudieron leer los guiones</AlertTitle>
          <AlertDescription>{scripts.message}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={onRetry}>
              Reintentar
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <div className="grid gap-3 @3xl:grid-cols-2">
          {RESULTS_MODES.map((mode) => (
            <ResultsBox key={mode} className="flex flex-col gap-2 px-3 py-3">
              <h3 className="flex items-center gap-1.5 px-1 text-xs text-foreground tabular-nums">
                <SeriesSwatch series={mode} />
                {modeHeading(summary, mode)}
              </h3>
              {scripts._tag === "loading" ? (
                <p role="status" className="px-1 py-2 text-xs text-muted-foreground">
                  Cargando guiones…
                </p>
              ) : (
                <ScriptsTable
                  mode={mode}
                  state={scripts}
                  reference={summary.lastDecidedAt}
                  threadTitles={threadTitles}
                />
              )}
            </ResultsBox>
          ))}
        </div>
      )}
      {scripts._tag === "ready" && scripts.page.total > scripts.page.decisions.length ? (
        <ResultsNote>
          Se muestran las {scripts.page.decisions.length} decisiones más recientes.
        </ResultsNote>
      ) : null}
      <ResultsNote>
        <b>Conteo mecánico:</b> no mide si la fuente respalda la afirmación. <b>Utilidad:</b> solo
        la del operador; las valoraciones de revisores externos no están aquí.
      </ResultsNote>
    </>
  );
}
