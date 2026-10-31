import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EditorialDurationStats,
  EditorialResultsComparison,
  EditorialResultsDecision,
  EditorialResultsDecisionPage,
  EditorialResultsMode,
  EditorialResultsSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { InfoIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
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
import { useQuietThreadShells } from "../../state/entities";
import { formatDate } from "../editorial.logic";
import { EditorialEmptyPage, EditorialPage } from "../EditorialPage";
import { editorialResultsEnvironment } from "../resultsState";
import { EvidenceExportButton } from "./EvidenceExportButton";
import {
  COMPARISON_TEXT,
  RESULTS_MODES,
  RESULTS_STAGES,
  actionLabel,
  actionsText,
  decisionTotalText,
  citationDetail,
  comparisonCards,
  coverageNote,
  decisionsFailureText,
  decisionThreadFallback,
  formatCount,
  formatDuration,
  formatInteger,
  formatPercent,
  hasDecisions,
  hasInboxActivity,
  iqrText,
  medianDifferenceText,
  modeLabel,
  modeSummary,
  pageRangeText,
  provisionalNote,
  recordedTotalText,
  stageChartMaxMs,
  stageLabel,
  stageStats,
  statsText,
  utilityText,
  type ResultsSectionId,
} from "./results.logic";

const SPACE_LABEL = "Resultados";
const DECISIONS_PAGE_SIZE = 20;

/** Series marks: assisted wears the primary hue, manual the neutral ink. Text never does. */
const MODE_FILL: Readonly<Record<EditorialResultsMode, string>> = {
  assisted: "fill-primary",
  manual: "fill-muted-foreground/70",
};
const MODE_SWATCH: Readonly<Record<EditorialResultsMode, string>> = {
  assisted: "bg-primary",
  manual: "bg-muted-foreground/70",
};

function ResultsSection({
  id,
  title,
  note,
  actions,
  children,
}: {
  readonly id: ResultsSectionId;
  readonly title: string;
  readonly note?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 scroll-mt-4 flex-col gap-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-medium text-foreground">
          {title}
        </h2>
        {actions}
      </div>
      {children}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </section>
  );
}

function ResultsMetric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function ModeSwatch({ mode }: { readonly mode: EditorialResultsMode }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", MODE_SWATCH[mode])} />;
}

function ComparisonCard({ comparison }: { readonly comparison: EditorialResultsComparison }) {
  const text = COMPARISON_TEXT[comparison.key];
  const difference = medianDifferenceText(comparison.assisted, comparison.manual);
  const coverage = coverageNote(comparison);
  const side = (mode: EditorialResultsMode, stats: EditorialDurationStats) => (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ModeSwatch mode={mode} />
        {mode === "assisted" ? text.assisted : text.manual}
      </span>
      <span className="text-base font-medium text-foreground tabular-nums">
        {stats.medianMs === null ? "sin datos" : formatDuration(stats.medianMs)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {[iqrText(stats), `n = ${stats.n}`].filter(Boolean).join(" · ")}
      </span>
    </div>
  );
  return (
    <div
      data-comparison={comparison.key}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
    >
      <h3 className="text-xs font-medium text-foreground">{text.title} · mediana</h3>
      <div className="grid grid-cols-2 gap-3">
        {side("assisted", comparison.assisted)}
        {side("manual", comparison.manual)}
      </div>
      <p className="border-t border-border pt-2 text-xs text-muted-foreground">
        {difference ?? "Sin las dos medianas no hay diferencia que describir."}
        {coverage ? ` ${coverage}` : null}
      </p>
    </div>
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

const BAR_HEIGHT = 10;
const ROW_HEIGHT = 14;

/** One bar per mode: the median as the bar, the interquartile range as a thin whisker. */
function StageBar({
  mode,
  stats,
  maxMs,
  stage,
}: {
  readonly mode: EditorialResultsMode;
  readonly stats: EditorialDurationStats | undefined;
  readonly maxMs: number;
  readonly stage: (typeof RESULTS_STAGES)[number];
}) {
  const percent = (ms: number) => `${Math.min(100, (ms / maxMs) * 100)}%`;
  const median = stats?.medianMs ?? null;
  const label = `${modeLabel(mode)}, ${stageLabel(stage)}: ${stats ? statsText(stats) : "sin datos"}`;
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_7.5rem] items-center gap-2">
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <ModeSwatch mode={mode} />
        {modeLabel(mode)}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <svg
              aria-hidden
              data-stage-bar={`${mode}:${stage}`}
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
                className={MODE_FILL[mode]}
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
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <span className="truncate text-xs text-foreground tabular-nums">
        {median === null ? "sin datos" : formatDuration(median)}
        {stats ? <span className="text-muted-foreground"> · n = {stats.n}</span> : null}
      </span>
    </div>
  );
}

function StageChart({ summary }: { readonly summary: EditorialResultsSummary }) {
  const maxMs = stageChartMaxMs(summary);
  return (
    <figure className="flex max-w-3xl flex-col gap-3">
      <div
        role="img"
        aria-label="Mediana de tiempo activo por etapa, asistido frente a manual. Los mismos datos están en la tabla siguiente."
        className="flex flex-col gap-3"
      >
        {RESULTS_STAGES.map((stage) => (
          <div key={stage} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">{stageLabel(stage)}</span>
            {RESULTS_MODES.map((mode) => (
              <StageBar
                key={mode}
                mode={mode}
                stage={stage}
                maxMs={maxMs}
                stats={stageStats(modeSummary(summary, mode), stage)}
              />
            ))}
          </div>
        ))}
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span>Barra: mediana · trazo: rango intercuartílico</span>
        <span>Línea discontinua: la etapa no se registró en ese modo</span>
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
          <TableHead className="w-24">Etapa</TableHead>
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

function ThreadCell({
  decision,
  title,
}: {
  readonly decision: EditorialResultsDecision;
  readonly title: string | undefined;
}) {
  const label = title ?? decisionThreadFallback(decision);
  return title === undefined ? (
    <span className="block max-w-56 truncate text-foreground">{label}</span>
  ) : (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: decision.environmentId, threadId: decision.threadId }}
      className="block max-w-56 truncate rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {label}
    </Link>
  );
}

function DecisionsTable({
  page,
  threadTitles,
}: {
  readonly page: EditorialResultsDecisionPage;
  readonly threadTitles: ReadonlyMap<string, string>;
}) {
  return (
    <Table aria-label="Decisiones registradas">
      <TableHeader>
        <TableRow>
          <TableHead>Fecha</TableHead>
          <TableHead>Hilo</TableHead>
          <TableHead>Modo</TableHead>
          <TableHead>Acción</TableHead>
          <TableHead className="text-end">Utilidad</TableHead>
          <TableHead className="text-end">Total</TableHead>
          <TableHead className="text-end">Con cita</TableHead>
          <TableHead className="text-end">Vistas</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {page.decisions.map((decision) => (
          <TableRow
            key={decision.decisionId}
            data-decision={decision.decisionId}
            data-current={decision.current}
          >
            <TableCell>
              <span className="tabular-nums">{formatDate(decision.decidedAt)}</span>
            </TableCell>
            <TableCell>
              <ThreadCell decision={decision} title={threadTitles.get(decision.threadId)} />
            </TableCell>
            <TableCell>{modeLabel(decision.mode)}</TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5">
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
              <span className="tabular-nums">
                {decision.video?.views == null ? "sin dato" : formatInteger(decision.video.views)}
              </span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const DECISION_FILTERS: ReadonlyArray<{
  readonly value: "all" | EditorialResultsMode;
  readonly label: string;
}> = [
  { value: "all", label: "Todas" },
  { value: "assisted", label: "Asistido" },
  { value: "manual", label: "Manual" },
];

/** The decisions page as the table sees it: loading, failed with a reason, or loaded. */
export type ResultsDecisionsState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failure"; readonly message: string }
  | { readonly _tag: "ready"; readonly page: EditorialResultsDecisionPage };

export interface ResultsDecisionsControls {
  readonly state: ResultsDecisionsState;
  readonly onRetry: () => void;
  readonly filter: "all" | EditorialResultsMode;
  readonly onFilter: (filter: "all" | EditorialResultsMode) => void;
  readonly onPage: (offset: number) => void;
}

function NoDecisions() {
  return (
    <Empty>
      <div className="w-full max-w-lg px-8 py-10">
        <EmptyHeader className="max-w-none">
          <EmptyTitle>Aún no hay decisiones registradas</EmptyTitle>
          <EmptyDescription>
            Resultados se llena con cada hilo de video que cierres.
          </EmptyDescription>
        </EmptyHeader>
      </div>
    </Empty>
  );
}

function InboxMetrics({ summary }: { readonly summary: EditorialResultsSummary }) {
  const { inbox } = summary;
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
      <ResultsMetric label="Leídas" value={String(inbox.read)} detail="abiertas al menos una vez" />
      <ResultsMetric
        label="En observación"
        value={String(inbox.observing)}
        detail="seguir observando, sin descartar"
      />
      <ResultsMetric
        label="Descartadas"
        value={String(inbox.dismissed)}
        detail="con motivo registrado"
      />
      <ResultsMetric
        label="En producción"
        value={String(inbox.production)}
        detail="enlazadas a un hilo de video"
      />
    </div>
  );
}

function DecisionsPage({
  page,
  threadTitles,
  onPage,
}: {
  readonly page: EditorialResultsDecisionPage;
  readonly threadTitles: ReadonlyMap<string, string>;
  readonly onPage: (offset: number) => void;
}) {
  return (
    <>
      <DecisionsTable page={page} threadTitles={threadTitles} />
      {page.total > DECISIONS_PAGE_SIZE ? (
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
      ) : null}
    </>
  );
}

/** The Results space with its data; the page fetches, this renders. */
export function ResultsView({
  summary,
  decisions,
  threadTitles,
  exportAction,
}: {
  readonly summary: EditorialResultsSummary;
  readonly decisions: ResultsDecisionsControls;
  readonly threadTitles: ReadonlyMap<string, string>;
  /** «Exportar evidencia»; the page mounts it, the view only places it. */
  readonly exportAction?: ReactNode;
}) {
  if (!hasDecisions(summary)) {
    return (
      <>
        <NoDecisions />
        {hasInboxActivity(summary) ? (
          <ResultsSection
            id="bandeja"
            title="Bandeja de tendencias"
            note="Los conteos son independientes: una tendencia leída puede estar también en producción."
          >
            <InboxMetrics summary={summary} />
          </ResultsSection>
        ) : null}
      </>
    );
  }
  const assisted = modeSummary(summary, "assisted");
  const manual = modeSummary(summary, "manual");
  const provisional = provisionalNote(summary);
  const state = decisions.state;
  const recorded = summary.comparisons.find((comparison) => comparison.key === "recorded");
  return (
    <>
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">Resultados</h1>
          <p className="text-sm text-muted-foreground">
            {formatCount(summary.decisionCount, "decisión", "decisiones")}
            {summary.firstDecidedAt && summary.lastDecidedAt
              ? ` entre el ${formatDate(summary.firstDecidedAt)} y el ${formatDate(summary.lastDecidedAt)}`
              : null}
            {` · ${formatCount(assisted?.threads ?? 0, "hilo asistido", "hilos asistidos")} y ${formatCount(manual?.threads ?? 0, "manual", "manuales")} cerrados`}
          </p>
        </div>
        {exportAction}
      </header>

      <Alert variant="info">
        <InfoIcon />
        <AlertDescription>
          Comparación descriptiva sobre la decisión vigente de cada hilo, con hilos y temas
          distintos en cada modo. Estas diferencias son descriptivas: la comparación de la tesis es
          por pares, sobre el mismo tema y con revisores externos.
        </AlertDescription>
      </Alert>

      <ResultsSection
        id="tiempos"
        title="Tiempo por ficha"
        note={
          <>
            Tiempo activo registrado por el reloj del hilo, sin pausas.
            {provisional ? ` ${provisional}` : null}
          </>
        }
      >
        <div className="grid gap-3 lg:grid-cols-3">
          {comparisonCards(summary.comparisons).map((comparison) => (
            <ComparisonCard key={comparison.key} comparison={comparison} />
          ))}
        </div>
        {recorded ? <RecordedTotal comparison={recorded} /> : null}
      </ResultsSection>

      <ResultsSection id="etapas" title="Mediana por etapa">
        <StageChart summary={summary} />
        <StageTable summary={summary} />
      </ResultsSection>

      <ResultsSection
        id="utilidad"
        title="Utilidad y citas"
        note="Utilidad: la que registra el operador al decidir; las valoraciones de revisores externos no están aquí. Con cita: oraciones del guion decidido que llevan un marcador de evidencia. Es un conteo mecánico, no mide si la fuente respalda la afirmación."
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          {RESULTS_MODES.map((mode) => {
            const entry = modeSummary(summary, mode);
            if (!entry) return null;
            return (
              <ResultsMetric
                key={`utility-${mode}`}
                label={`Utilidad media, ${modeLabel(mode).toLowerCase()}`}
                value={utilityText(entry)}
                detail={`n = ${entry.utility.n} · ${actionsText(entry.actions)}`}
              />
            );
          })}
          {RESULTS_MODES.map((mode) => {
            const entry = modeSummary(summary, mode);
            if (!entry) return null;
            return (
              <ResultsMetric
                key={`citations-${mode}`}
                label={`Afirmaciones con cita, ${modeLabel(mode).toLowerCase()}`}
                value={
                  entry.citations.ratio === null
                    ? "sin datos"
                    : formatPercent(entry.citations.ratio)
                }
                detail={citationDetail(entry)}
              />
            );
          })}
        </div>
      </ResultsSection>

      <ResultsSection
        id="bandeja"
        title="Bandeja de tendencias"
        note="Los conteos son independientes: una tendencia leída puede estar también en producción."
      >
        <InboxMetrics summary={summary} />
      </ResultsSection>

      <ResultsSection
        id="video"
        title="Métricas de video"
        note="Registradas a mano en el hilo cerrado. Son descriptivas: no se atribuyen al sistema ni al modo de trabajo."
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          {RESULTS_MODES.map((mode) => {
            const entry = modeSummary(summary, mode);
            if (!entry) return null;
            return (
              <ResultsMetric
                key={mode}
                label={`Con métricas, ${modeLabel(mode).toLowerCase()}`}
                value={`${entry.withVideoResults} de ${entry.threads}`}
                detail="hilos con al menos una observación"
              />
            );
          })}
        </div>
      </ResultsSection>

      <ResultsSection
        id="decisiones"
        title="Decisiones"
        note="Las reemplazadas siguen en el registro y no cuentan en los agregados. «≥» marca un total con un tramo sin resolver."
        actions={
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
        }
      >
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
          <DecisionsPage page={state.page} threadTitles={threadTitles} onPage={decisions.onPage} />
        )}
      </ResultsSection>
    </>
  );
}

function useThreadTitles(): ReadonlyMap<string, string> {
  const shells = useQuietThreadShells();
  return new Map(shells.map((shell) => [shell.id, shell.title]));
}

export function ResultsPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [filter, setFilter] = useState<"all" | EditorialResultsMode>("all");
  const [offset, setOffset] = useState(0);
  const threadTitles = useThreadTitles();
  const summaryResult = useAtomValue(
    editorialResultsEnvironment.summary({ environmentId, input: {} }),
  );
  const decisionsAtom = editorialResultsEnvironment.decisions({
    environmentId,
    input: {
      limit: DECISIONS_PAGE_SIZE,
      ...(offset === 0 ? {} : { offset }),
      ...(filter === "all" ? {} : { mode: filter }),
    },
  });
  const decisionsResult = useAtomValue(decisionsAtom);
  const retryDecisions = useAtomRefresh(decisionsAtom);
  const summary = AsyncResult.getOrElse(summaryResult, () => null);
  const page = AsyncResult.getOrElse(decisionsResult, () => null);
  const decisionsState: ResultsDecisionsState =
    page !== null
      ? { _tag: "ready", page }
      : decisionsResult._tag === "Failure" && !decisionsResult.waiting
        ? {
            _tag: "failure",
            message: decisionsFailureText(
              Option.getOrUndefined(Cause.findErrorOption(decisionsResult.cause)),
            ),
          }
        : { _tag: "loading" };
  if (summary === null) {
    return summaryResult._tag === "Failure" ? (
      <EditorialEmptyPage
        space={SPACE_LABEL}
        title="No se pudieron leer los resultados"
        description="La base editorial de este entorno no respondió. Vuelve a abrir el espacio en un momento."
      />
    ) : (
      <EditorialPage space={SPACE_LABEL}>{null}</EditorialPage>
    );
  }
  return (
    <EditorialPage space={SPACE_LABEL}>
      <ResultsView
        summary={summary}
        threadTitles={threadTitles}
        exportAction={<EvidenceExportButton environmentId={environmentId} />}
        decisions={{
          state: decisionsState,
          onRetry: retryDecisions,
          filter,
          onFilter: (next) => {
            setFilter(next);
            setOffset(0);
          },
          onPage: setOffset,
        }}
      />
    </EditorialPage>
  );
}
