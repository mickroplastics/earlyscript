import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EditorialBaselineImportResult,
  EditorialBaselineRecord,
  EditorialDurationStats,
  EditorialResultsSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { UploadIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDate } from "../editorial.logic";
import { editorialResultsEnvironment } from "../resultsState";
import { FigureFrame } from "./FigureFrame";
import {
  BASELINE_FIGURE_TEXT,
  BASELINE_SERIES,
  baselineChartMaxMs,
  baselineFigure,
  baselineComparisons,
  baselineFailureText,
  baselineNotes,
  baselineStatsText,
  baselineTableRows,
  csvFileProblem,
  dayText,
  formatMs,
  groupOf,
  hasBaseline,
  importResultText,
  issueText,
  minutesCell,
  outcomeLabel,
  provenanceText,
  seriesLabel,
  weekDaysText,
  weekMinutesText,
  weekRangeText,
  type BaselineComparison,
  type BaselineSeries,
} from "./manualBaseline.logic";

const SECTION_ID = "linea-base";

/** Assisted wears the primary hue; manual the neutral ink, lighter when it is an estimate. */
const SERIES_FILL: Readonly<Record<BaselineSeries, string>> = {
  assisted: "fill-primary",
  cronometrado: "fill-muted-foreground/70",
  reconstruido: "fill-muted-foreground/30",
};
const SERIES_SWATCH: Readonly<Record<BaselineSeries, string>> = {
  assisted: "bg-primary",
  cronometrado: "bg-muted-foreground/70",
  reconstruido: "bg-muted-foreground/30",
};

function SeriesSwatch({ series }: { readonly series: BaselineSeries }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-xs", SERIES_SWATCH[series])} />;
}

const medianText = (stats: EditorialDurationStats | null) =>
  stats === null || stats.medianMs === null ? "sin datos" : formatMs(stats.medianMs);

function ComparisonSide({
  series,
  stats,
  label,
}: {
  readonly series: BaselineSeries;
  readonly stats: EditorialDurationStats | null;
  readonly label: string;
}) {
  const secondary = series === "reconstruido";
  return (
    <div className="flex min-w-0 flex-col gap-0.5" data-series={series}>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <SeriesSwatch series={series} />
        {label}
      </span>
      <span
        className={cn(
          "font-medium tabular-nums",
          secondary ? "text-sm text-muted-foreground" : "text-base text-foreground",
        )}
      >
        {medianText(stats)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        n = {stats?.n ?? 0}
        {secondary ? " · estimación" : series === "cronometrado" ? " · cifra principal" : null}
      </span>
    </div>
  );
}

function ComparisonCard({ comparison }: { readonly comparison: BaselineComparison }) {
  return (
    <div
      data-baseline-comparison={comparison.key}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
    >
      <h3 className="text-xs font-medium text-foreground">{comparison.title} · mediana</h3>
      <div className="grid grid-cols-3 gap-3">
        <ComparisonSide series="assisted" stats={comparison.stats.assisted} label="Asistido" />
        <ComparisonSide
          series="cronometrado"
          stats={comparison.stats.cronometrado}
          label="Cronometrado"
        />
        <ComparisonSide
          series="reconstruido"
          stats={comparison.stats.reconstruido}
          label="Reconstruido"
        />
      </div>
      <p className="border-t border-border pt-2 text-xs text-muted-foreground">
        {comparison.assistedLabel}. {comparison.manualLabel}.
      </p>
    </div>
  );
}

const BAR_HEIGHT = 10;
const ROW_HEIGHT = 14;

/** The median as the bar, the interquartile range as a thin whisker, like the stage chart. */
function BaselineBar({
  series,
  stats,
  maxMs,
  title,
}: {
  readonly series: BaselineSeries;
  readonly stats: EditorialDurationStats | null;
  readonly maxMs: number;
  readonly title: string;
}) {
  const percent = (ms: number) => `${Math.min(100, (ms / maxMs) * 100)}%`;
  const median = stats?.medianMs ?? null;
  const label = `${seriesLabel(series)}, ${title}: ${stats ? baselineStatsText(stats) : "sin datos"}`;
  return (
    <div className="grid grid-cols-[9.5rem_minmax(0,1fr)_7.5rem] items-center gap-2">
      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <SeriesSwatch series={series} />
        {seriesLabel(series)}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <svg
              aria-hidden
              data-baseline-bar={`${series}:${title}`}
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
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <span className="truncate text-xs text-foreground tabular-nums">
        {medianText(stats)}
        <span className="text-muted-foreground"> · n = {stats?.n ?? 0}</span>
      </span>
    </div>
  );
}

function BaselineChart({
  comparisons,
}: {
  readonly comparisons: ReadonlyArray<BaselineComparison>;
}) {
  const maxMs = baselineChartMaxMs(comparisons);
  return (
    <figure className="flex max-w-3xl flex-col gap-3">
      <div
        role="img"
        aria-label="Mediana de búsqueda y de escritura, asistido frente al registro manual cronometrado y reconstruido. Los mismos datos están en la tabla siguiente."
        className="flex flex-col gap-3"
      >
        {comparisons.map((comparison) => (
          <div key={comparison.key} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-foreground">{comparison.title}</span>
            {BASELINE_SERIES.map((series) => (
              <BaselineBar
                key={series}
                series={series}
                title={comparison.title}
                maxMs={maxMs}
                stats={comparison.stats[series]}
              />
            ))}
          </div>
        ))}
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <span>Barra: mediana · trazo: rango intercuartílico</span>
        <span>Asistido por hilo; manual por bloque de trabajo</span>
        <span className="tabular-nums">Escala común hasta {formatMs(maxMs)}</span>
      </figcaption>
    </figure>
  );
}

function ComparisonTable({
  comparisons,
  record,
}: {
  readonly comparisons: ReadonlyArray<BaselineComparison>;
  readonly record: EditorialBaselineRecord;
}) {
  const both = groupOf(record, "conjunto");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Table aria-label="Búsqueda y escritura, asistido frente al registro manual">
        <TableHeader>
          <TableRow>
            <TableHead className="w-28">Mediana · RIC · n</TableHead>
            {BASELINE_SERIES.map((series) => (
              <TableHead key={series}>{seriesLabel(series)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {comparisons.map((comparison) => (
            <TableRow key={comparison.key}>
              <TableCell>{comparison.title}</TableCell>
              {BASELINE_SERIES.map((series) => {
                const stats = comparison.stats[series];
                return (
                  <TableCell key={series} className="whitespace-normal">
                    <span className="tabular-nums">
                      {stats ? baselineStatsText(stats) : "sin datos"}
                    </span>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {both ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          Las dos semanas juntas, mezclando cronometrado y reconstruido: búsqueda{" "}
          {baselineStatsText(both.search)}; escritura en bloques con escritura{" "}
          {baselineStatsText(both.writingNonZero)}; escritura en todos los bloques, descartes con 0
          min incluidos, {baselineStatsText(both.writing)}.
        </p>
      ) : null}
    </div>
  );
}

function WeeksAndOutcomes({ record }: { readonly record: EditorialBaselineRecord }) {
  const both = groupOf(record, "conjunto");
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-xs font-medium text-foreground">Tiempo registrado por semana</h3>
        <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          {record.weeks.map((week) => (
            <li key={week.from} className="flex flex-wrap justify-between gap-x-3 tabular-nums">
              <span className="text-foreground">{weekRangeText(week)}</span>
              <span>
                {weekMinutesText(week)} · {weekDaysText(week)}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Sin extrapolar los días sin registro ni descontar interrupciones. «Al menos»: un bloque
          tiene una parte sin medir.
        </p>
      </div>
      {both ? (
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-xs font-medium text-foreground">En qué terminó cada bloque</h3>
          <ul className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            {both.outcomes
              .filter((entry) => entry.blocks > 0)
              .map((entry) => (
                <li key={entry.resultado} className="flex justify-between gap-3 tabular-nums">
                  <span className="text-foreground">{outcomeLabel(entry.resultado)}</span>
                  <span>{entry.blocks}</span>
                </li>
              ))}
          </ul>
          <p className="text-xs text-muted-foreground tabular-nums">
            {both.blocksWithInterruptions} bloques con interrupciones anotadas ({both.interruptions}{" "}
            en total).
          </p>
        </div>
      ) : null}
    </div>
  );
}

function BlocksTable({ record }: { readonly record: EditorialBaselineRecord }) {
  const notes = baselineNotes(record);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Table aria-label="Bloques del registro manual">
        <TableHeader>
          <TableRow>
            <TableHead>Fecha</TableHead>
            <TableHead>Modo</TableHead>
            <TableHead className="text-end">Búsqueda</TableHead>
            <TableHead className="text-end">Escritura</TableHead>
            <TableHead className="text-end">Total</TableHead>
            <TableHead>Resultado</TableHead>
            <TableHead>Fuente</TableHead>
            <TableHead className="text-end">Interr.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {baselineTableRows(record).map((row) =>
            row.kind === "missing" ? (
              <TableRow key={row.fecha} data-baseline-missing={row.fecha}>
                <TableCell>
                  <span className="tabular-nums">{dayText(row.fecha)}</span>
                </TableCell>
                <TableCell colSpan={7}>
                  <span className="text-muted-foreground">Sin registro</span>
                </TableCell>
              </TableRow>
            ) : (
              <TableRow
                key={`${row.block.fecha}#${row.block.bloque}`}
                data-baseline-block={`${row.block.fecha}#${row.block.bloque}`}
              >
                <TableCell>
                  <span className="tabular-nums">
                    {dayText(row.block.fecha)}
                    {row.block.bloque > 1 ? (
                      <span className="text-muted-foreground"> · {row.block.bloque}</span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell>
                  <span aria-hidden>{row.block.modo === "cronometrado" ? "C" : "R"}</span>
                  <span className="sr-only">{row.block.modo}</span>
                </TableCell>
                {(["minBusqueda", "minEscritura", "minTotal"] as const).map((field) => {
                  const text = minutesCell(row.block, field);
                  return (
                    <TableCell key={field} className="text-end">
                      <span
                        className={cn(
                          "tabular-nums",
                          row.block[field] === null && "text-muted-foreground",
                        )}
                      >
                        {text}
                      </span>
                    </TableCell>
                  );
                })}
                <TableCell>{outcomeLabel(row.block.resultado)}</TableCell>
                <TableCell>{row.block.fuente ?? "sin dato"}</TableCell>
                <TableCell className="text-end">
                  <span className="tabular-nums">{row.block.interrupciones ?? "sin dato"}</span>
                </TableCell>
              </TableRow>
            ),
          )}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        C: cronometrado en el momento. R: reconstruido después. «Sin separar»: solo se anotó el
        total del bloque, que entra en el total pero no en búsqueda ni escritura.
      </p>
      {notes.length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer text-foreground">
            Observaciones del operador ({notes.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {notes.map((note) => (
              <li key={note.key}>
                <span className="text-foreground">{note.label}:</span> {note.text}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export type BaselineImportState =
  | { readonly _tag: "idle" }
  | { readonly _tag: "saving" }
  | { readonly _tag: "done"; readonly result: EditorialBaselineImportResult }
  | { readonly _tag: "failed"; readonly message: string };

function ImportStatus({ state }: { readonly state: BaselineImportState }) {
  if (state._tag === "idle") return null;
  if (state._tag === "saving") {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Guardando el registro…
      </p>
    );
  }
  if (state._tag === "failed") {
    return (
      <Alert variant="error">
        <AlertTitle>No se pudo importar el registro</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  const { result } = state;
  const issues = result.status === "rejected" ? result.errors : result.warnings;
  return (
    <Alert variant={result.status === "rejected" ? "error" : "info"}>
      <AlertTitle>{importResultText(result)}</AlertTitle>
      {issues.length > 0 ? (
        <AlertDescription>
          {result.status === "rejected" ? null : <span>Avisos que no impiden la importación:</span>}
          <ul className="flex list-disc flex-col gap-0.5 ps-4">
            {issues.map((issue) => (
              <li key={`${issue.line}:${issue.column}:${issue.message}`}>{issueText(issue)}</li>
            ))}
          </ul>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

/** The Manual baseline section with its data; `ManualBaselineSection` fetches. */
export function ManualBaselineView({
  record,
  failure,
  summary,
  importState,
  onImport,
}: {
  /** Null while loading or when the read failed. */
  readonly record: EditorialBaselineRecord | null;
  readonly failure: string | null;
  readonly summary: EditorialResultsSummary | null;
  readonly importState: BaselineImportState;
  readonly onImport: (file: File) => void;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const present = hasBaseline(record);
  const saving = importState._tag === "saving";
  const action = (
    <>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onImport(file);
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={saving || (record === null && failure === null)}
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        {saving ? "Guardando…" : present ? "Reemplazar registro" : "Importar registro CSV"}
      </Button>
    </>
  );
  const comparisons = record !== null && present ? baselineComparisons(record, summary) : [];
  return (
    <section
      id={SECTION_ID}
      aria-labelledby={`${SECTION_ID}-title`}
      className="flex min-w-0 scroll-mt-4 flex-col gap-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h2 id={`${SECTION_ID}-title`} className="text-sm font-medium text-foreground">
          Línea base manual
        </h2>
        {action}
      </div>
      <ImportStatus state={importState} />
      {failure !== null ? (
        <Alert variant="error">
          <AlertTitle>No se pudo leer el registro manual</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : record === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          Cargando el registro manual…
        </p>
      ) : !present ? (
        <p className="max-w-2xl text-sm text-muted-foreground">
          Aún no hay un registro manual importado. Importa el CSV de tu registro de carga, con un
          bloque de trabajo por fila, para verlo junto a los tiempos asistidos.
        </p>
      ) : (
        <>
          <p className="max-w-3xl text-sm text-foreground">{provenanceText(record)}</p>
          <p className="text-xs text-muted-foreground">
            Importado el {formatDate(record.provenance!.importedAt)} · sha256{" "}
            <span className="font-mono">{record.provenance!.sourceHash.slice(0, 12)}</span>
            {record.excludedByDomain > 0
              ? ` · ${record.excludedByDomain} filas guardadas quedan fuera por un valor fuera de dominio`
              : null}
          </p>
          <div className="grid gap-3 lg:grid-cols-2">
            {comparisons.map((comparison) => (
              <ComparisonCard key={comparison.key} comparison={comparison} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Descriptivo: un bloque manual no equivale a un hilo asistido (un bloque puede revisar
            varias ideas o ninguna llegar a ficha) y son semanas y temas distintos, así que las
            medianas se muestran lado a lado, sin restarlas. La cifra principal es la cronometrada;
            la reconstruida es una estimación.
          </p>
          <FigureFrame
            id="linea-base"
            {...BASELINE_FIGURE_TEXT}
            figure={baselineFigure(comparisons)}
          />
          <BaselineChart comparisons={comparisons} />
          <ComparisonTable comparisons={comparisons} record={record} />
          <WeeksAndOutcomes record={record} />
          <BlocksTable record={record} />
        </>
      )}
    </section>
  );
}

export function ManualBaselineSection({
  environmentId,
  summary,
}: {
  readonly environmentId: EnvironmentId;
  readonly summary: EditorialResultsSummary | null;
}) {
  const [importState, setImportState] = useState<BaselineImportState>({ _tag: "idle" });
  const result = useAtomValue(editorialResultsEnvironment.baseline({ environmentId, input: {} }));
  const importBaseline = useAtomCommand(editorialResultsEnvironment.importBaseline, {
    reportFailure: false,
  });
  const record = AsyncResult.getOrElse(result, () => null);
  const failure =
    record === null && result._tag === "Failure" && !result.waiting
      ? baselineFailureText(Option.getOrUndefined(Cause.findErrorOption(result.cause)))
      : null;

  const onImport = async (file: File) => {
    const problem = csvFileProblem(file);
    if (problem !== null) {
      setImportState({ _tag: "failed", message: problem });
      return;
    }
    setImportState({ _tag: "saving" });
    let csv: string;
    try {
      csv = await file.text();
    } catch {
      setImportState({ _tag: "failed", message: "El navegador no pudo leer el archivo." });
      return;
    }
    const outcome = await importBaseline({ environmentId, input: { csv } });
    if (outcome._tag === "Success") {
      setImportState({ _tag: "done", result: outcome.value });
      return;
    }
    if (isAtomCommandInterrupted(outcome)) {
      setImportState({ _tag: "idle" });
      return;
    }
    setImportState({
      _tag: "failed",
      message: baselineFailureText(squashAtomCommandFailure(outcome)),
    });
  };

  return (
    <ManualBaselineView
      record={record}
      failure={failure}
      summary={summary}
      importState={importState}
      onImport={(file) => void onImport(file)}
    />
  );
}
