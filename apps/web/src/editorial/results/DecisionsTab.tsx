import type {
  EditorialResultsDecision,
  EditorialResultsDecisionPage,
  EditorialResultsMode,
  EditorialResultsSummary,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Fragment, useId } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Label } from "../../components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import {
  actionLabel,
  decisionThreadLabel,
  decisionTotalText,
  formatInteger,
  modeLabel,
  pageRangeText,
  trialName,
} from "./results.logic";
import { ResultsBox, ResultsNoteList, SeriesSwatch } from "./resultsMarks";
import { localTimeZone, rowDateText, timeZoneLabel } from "./resultsOverview.logic";

export const DECISIONS_PAGE_SIZE = 20;

/** A decisions read as a view sees it: loading, failed with a reason, or loaded. */
export type ResultsDecisionsState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failure"; readonly message: string }
  | { readonly _tag: "ready"; readonly page: EditorialResultsDecisionPage };

export type DecisionFilter = "all" | EditorialResultsMode;

export interface ResultsDecisionsControls {
  readonly state: ResultsDecisionsState;
  readonly onRetry: () => void;
  readonly filter: DecisionFilter;
  readonly onFilter: (filter: DecisionFilter) => void;
  /** Agent trials in the table, after the human decisions; off by default. */
  readonly showTrials: boolean;
  readonly onShowTrials: (show: boolean) => void;
  readonly onPage: (offset: number) => void;
}

const DECISION_FILTERS: ReadonlyArray<{
  readonly value: DecisionFilter;
  readonly label: string;
}> = [
  { value: "all", label: "Todas" },
  { value: "assisted", label: "Asistido" },
  { value: "manual", label: "Manual" },
];

/** An agent trial thread, as the summary lists it. */
interface TrialLink {
  readonly threadId: string;
  readonly environmentId: string;
}

/**
 * A thread's name, linked to it when the thread is known here, on up to two lines; the tooltip
 * carries it whole. Its column takes the table's spare width (`table-fixed`). An agent trial
 * always links, under `trialName` when its title is unknown.
 */
export function ThreadCell({
  decision,
  title,
  trialName,
}: {
  readonly decision: EditorialResultsDecision;
  readonly title: string | undefined;
  readonly trialName?: string | undefined;
}) {
  const label =
    title === undefined && trialName !== undefined
      ? trialName
      : decisionThreadLabel(decision, title);
  const classes = "line-clamp-2 whitespace-normal text-foreground [overflow-wrap:anywhere]";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          title === undefined && trialName === undefined ? (
            <span className={classes} />
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: decision.environmentId, threadId: decision.threadId }}
              className={cn(
                classes,
                "rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              )}
            />
          )
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function DecisionsTable({
  page,
  threadTitles,
  trials,
  reference,
  showTrials,
}: {
  readonly page: EditorialResultsDecisionPage;
  readonly threadTitles: ReadonlyMap<string, string>;
  readonly trials: ReadonlyArray<TrialLink>;
  /** The latest decision: dates in its year leave the year out. */
  readonly reference: string | null;
  readonly showTrials: boolean;
}) {
  const firstTrial = page.decisions.findIndex((decision) => decision.cohort === "trial");
  return (
    // The fixed columns take 44rem; the rest keeps the thread's column at least 12rem wide.
    <Table aria-label="Decisiones registradas" className="min-w-[56rem] table-fixed">
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">Fecha</TableHead>
          <TableHead>Hilo</TableHead>
          <TableHead className="w-32">Modo</TableHead>
          <TableHead className="w-36">Acción</TableHead>
          <TableHead className="w-16 text-end">Utilidad</TableHead>
          <TableHead className="w-24 text-end">Total</TableHead>
          <TableHead className="w-20 text-end">Con cita</TableHead>
          <TableHead className="w-20 text-end">Vistas</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {page.decisions.map((decision, index) => (
          <Fragment key={decision.decisionId}>
            {showTrials && index === firstTrial ? (
              <tr className="border-b bg-muted/40" data-trials-separator="">
                <td colSpan={8} className="px-2 py-1.5 text-xs text-muted-foreground">
                  Ensayos de agente: no cuentan en los indicadores.
                </td>
              </tr>
            ) : null}
            <TableRow data-decision={decision.decisionId} data-current={decision.current}>
              <TableCell>
                <span className="text-muted-foreground tabular-nums">
                  {rowDateText(decision.decidedAt, reference)}
                </span>
              </TableCell>
              <TableCell>
                <ThreadCell
                  decision={decision}
                  title={threadTitles.get(decision.threadId)}
                  trialName={
                    decision.cohort === "trial" ? trialName(trials, decision.threadId) : undefined
                  }
                />
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <SeriesSwatch series={decision.mode} />
                  {modeLabel(decision.mode)}
                  {decision.cohort === "trial" ? (
                    <Badge size="sm" variant="outline">
                      Ensayo
                    </Badge>
                  ) : null}
                </span>
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  {actionLabel(decision.action)}
                  {decision.current ? null : (
                    <Badge size="sm" variant="outline">
                      reemplazada
                    </Badge>
                  )}
                </span>
              </TableCell>
              <TableCell className="text-end">
                <span className="tabular-nums">{decision.utility}</span>
              </TableCell>
              <TableCell className="text-end">
                <span className="tabular-nums">{decisionTotalText(decision)}</span>
              </TableCell>
              <TableCell className="text-end">
                <span className="tabular-nums">
                  {decision.script === null
                    ? "sin guion"
                    : `${decision.script.cited} de ${decision.script.claims}`}
                </span>
              </TableCell>
              <TableCell className="text-end">
                <span
                  className={cn(
                    "tabular-nums",
                    decision.video?.views == null && "text-muted-foreground",
                  )}
                >
                  {decision.video?.views == null ? "sin dato" : formatInteger(decision.video.views)}
                </span>
              </TableCell>
            </TableRow>
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

export function NoDecisions() {
  return (
    <Empty>
      <div className="w-full max-w-lg px-8 py-10">
        <EmptyHeader className="max-w-none">
          <EmptyTitle>Aún no hay decisiones registradas</EmptyTitle>
          <EmptyDescription>
            Al registrar la decisión de un hilo de video aparecen aquí sus tiempos por etapa, su
            utilidad y las afirmaciones con cita del guion.
          </EmptyDescription>
        </EmptyHeader>
      </div>
    </Empty>
  );
}

function Pagination({
  page,
  onPage,
}: {
  readonly page: EditorialResultsDecisionPage;
  readonly onPage: (offset: number) => void;
}) {
  if (page.total <= DECISIONS_PAGE_SIZE) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {pageRangeText(page.offset, page.decisions.length, page.total)}
      </span>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={page.offset === 0}
        onClick={() => onPage(Math.max(0, page.offset - DECISIONS_PAGE_SIZE))}
      >
        Anteriores
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={page.offset + page.decisions.length >= page.total}
        onClick={() => onPage(page.offset + DECISIONS_PAGE_SIZE)}
      >
        Siguientes
      </Button>
    </div>
  );
}

/** «Decisiones»: the whole log, filtered by mode, with the agent trials on request. */
export function DecisionsTab({
  summary,
  decisions,
  threadTitles,
  trialLinks,
}: {
  readonly summary: EditorialResultsSummary;
  readonly decisions: ResultsDecisionsControls;
  readonly threadTitles: ReadonlyMap<string, string>;
  /**
   * Trials to link under the table: the ones without a decision once the whole log is read,
   * every trial when it could not be (no claim about which lack one), none while it loads.
   */
  readonly trialLinks: {
    readonly undecidedOnly: boolean;
    readonly trials: ReadonlyArray<TrialLink>;
  } | null;
}) {
  const checkboxId = useId();
  const trials = summary.trials ?? [];
  const state = decisions.state;
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label="Filtrar decisiones por modo"
          variant="segmented"
          size="compact"
          value={[decisions.filter]}
          onValueChange={(next) => {
            const selected = DECISION_FILTERS.find((entry) => entry.value === next[0]);
            if (selected) decisions.onFilter(selected.value);
          }}
        >
          {DECISION_FILTERS.map((entry) => (
            <Toggle key={entry.value} value={entry.value}>
              {entry.label}
            </Toggle>
          ))}
        </ToggleGroup>
        {trials.length > 0 ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id={checkboxId}
              checked={decisions.showTrials}
              onCheckedChange={(checked) => decisions.onShowTrials(checked === true)}
            />
            <Label htmlFor={checkboxId}>
              <span className="text-xs font-normal text-muted-foreground">
                Mostrar los {trials.length} ensayos de agente (fuera de los indicadores)
              </span>
            </Label>
          </div>
        ) : null}
      </div>
      {state._tag === "loading" ? (
        <p role="status" className="text-xs text-muted-foreground">
          Cargando decisiones…
        </p>
      ) : state._tag === "failure" ? (
        <Alert variant="error">
          <AlertTitle>No se pudieron leer las decisiones</AlertTitle>
          <AlertDescription>{state.message}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={decisions.onRetry}>
              Reintentar
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <>
          <ResultsBox className="p-1">
            <DecisionsTable
              page={state.page}
              threadTitles={threadTitles}
              trials={trials}
              reference={summary.lastDecidedAt}
              showTrials={decisions.showTrials}
            />
          </ResultsBox>
          <Pagination page={state.page} onPage={decisions.onPage} />
        </>
      )}
      {decisions.showTrials && trialLinks && trialLinks.trials.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-trial-links="">
          {trialLinks.undecidedOnly ? "Ensayos sin decisión:" : "Ensayos de agente:"}{" "}
          {trialLinks.trials.map((trial) => (
            <Link
              key={trial.threadId}
              to="/$environmentId/$threadId"
              params={{ environmentId: trial.environmentId, threadId: trial.threadId }}
              className="me-2 text-foreground underline underline-offset-2"
            >
              {threadTitles.get(trial.threadId) ?? trialName(trials, trial.threadId)}
            </Link>
          ))}
        </p>
      ) : null}
      <ResultsNoteList>
        <li>
          Hora de {timeZoneLabel(localTimeZone())}. El título abre su hilo. Utilidad de 1 a 5.
        </li>
        <li>
          Total: tiempo activo del reloj del hilo; «≥» marca un total con un tramo sin resolver: es
          un mínimo.
        </li>
        <li>Las reemplazadas siguen en el registro y no cuentan en los agregados.</li>
        <li>Vistas: «sin dato» mientras no haya métricas de video.</li>
      </ResultsNoteList>
    </>
  );
}
