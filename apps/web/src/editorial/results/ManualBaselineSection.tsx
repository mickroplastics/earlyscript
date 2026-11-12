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
import { cn } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { editorialResultsEnvironment } from "../resultsState";
import { FigureFrame } from "./FigureFrame";
import { ResultsDisclosure } from "./ResultsDisclosure";
import {
  BASELINE_BAR_COLUMNS,
  MedianBarRow,
  ResultsBox,
  ResultsNote,
  SeriesSwatch,
} from "./resultsMarks";
import { shortResultsDate } from "./resultsOverview.logic";
import { formatCount } from "./results.logic";
import { PanelLead, PanelLeadText } from "./ResultsTabs";
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
          "text-lg leading-tight font-semibold tabular-nums",
          secondary ? "text-muted-foreground" : "text-foreground",
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
    <ResultsBox data-baseline-comparison={comparison.key} className="flex flex-col gap-3 p-3.5">
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
      <p className="mt-auto border-t border-border pt-2 text-xs text-muted-foreground">
        {comparison.assistedLabel}. {comparison.manualLabel}.
      </p>
    </ResultsBox>
  );
}

function BaselineChart({
  comparisons,
}: {
  readonly comparisons: ReadonlyArray<BaselineComparison>;
}) {
  const maxMs = baselineChartMaxMs(comparisons);
  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <div
        role="img"
        aria-label="Mediana de búsqueda y de escritura, asistido frente al registro manual cronometrado y reconstruido. Los mismos datos están en la tabla con RIC."
        className="flex flex-col gap-3"
      >
        {comparisons.map((comparison) => (
          <div key={comparison.key} className="flex flex-col gap-1.5">
            {BASELINE_SERIES.map((series, index) => {
              const stats = comparison.stats[series];
              return (
                <MedianBarRow
                  key={series}
                  columns={BASELINE_BAR_COLUMNS}
                  group={index === 0 ? comparison.title : null}
                  series={series}
                  label={seriesLabel(series)}
                  stats={stats}
                  maxMs={maxMs}
                  tooltip={`${seriesLabel(series)}, ${comparison.title}: ${stats ? baselineStatsText(stats) : "sin datos"}`}
                  value={medianText(stats)}
                  size={`n = ${stats?.n ?? 0}`}
                  barProps={{ "data-baseline-bar": `${series}:${comparison.title}` }}
                />
              );
            })}
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
    <div className="grid gap-4 @3xl:grid-cols-2">
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

/** The operator's note on a block or a missing day, wrapped in its own column. */
function Observation({ text }: { readonly text: string | null | undefined }) {
  return (
    <span className="block max-w-80 min-w-56 text-2xs whitespace-normal text-muted-foreground">
      {text ?? ""}
    </span>
  );
}

function BlocksTable({ record }: { readonly record: EditorialBaselineRecord }) {
  const notes = new Map(baselineNotes(record).map((note) => [note.key, note.text]));
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
            <TableHead>Observación</TableHead>
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
                <TableCell>
                  <Observation text={notes.get(row.fecha)} />
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
                <TableCell>
                  <Observation text={notes.get(`${row.block.fecha}#${row.block.bloque}`)} />
                </TableCell>
              </TableRow>
            ),
          )}
        </TableBody>
      </Table>
      <ResultsNote>
        C: cronometrado en el momento. R: reconstruido después. «Sin separar»: solo se anotó el
        total del bloque, que entra en el total pero no en búsqueda ni escritura.
      </ResultsNote>
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
  const provenance = present ? record?.provenance : null;
  return (
    <>
      <PanelLead
        title="Antes de la app: registro manual"
        action={<div className="shrink-0">{action}</div>}
      >
        {record !== null && provenance ? (
          <>
            <PanelLeadText>{provenanceText(record)}</PanelLeadText>
            <p className="text-2xs text-muted-foreground tabular-nums">
              Importado el {shortResultsDate(provenance.importedAt, { year: true })} · sha256{" "}
              <span className="font-mono">{provenance.sourceHash.slice(0, 12)}</span>
              {record.excludedByDomain > 0
                ? ` · ${record.excludedByDomain} filas guardadas quedan fuera por un valor fuera de dominio`
                : null}
            </p>
          </>
        ) : null}
      </PanelLead>
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
      ) : !present || !provenance ? (
        <p className="max-w-2xl text-sm text-muted-foreground">
          Aún no hay un registro manual importado. Importa el CSV de tu registro de carga, con un
          bloque de trabajo por fila, para verlo junto a los tiempos asistidos.
        </p>
      ) : (
        <>
          <div className="grid gap-3 @3xl:grid-cols-2">
            {comparisons.map((comparison) => (
              <ComparisonCard key={comparison.key} comparison={comparison} />
            ))}
          </div>
          <ResultsBox className="flex flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <h3 className="text-xs font-medium text-foreground">
                Buscar y escribir: asistido frente al registro de{" "}
                {monthsText(provenance.from, provenance.to)}
              </h3>
              <FigureFrame
                id="linea-base"
                variant="menu"
                {...BASELINE_FIGURE_TEXT}
                figure={baselineFigure(comparisons)}
              />
            </div>
            <BaselineChart comparisons={comparisons} />
          </ResultsBox>
          <ResultsNote>
            <b>Lado a lado, sin restar:</b> un bloque manual no equivale a un hilo asistido (un
            bloque puede revisar varias ideas o ninguna llegar a ficha) y son semanas y temas
            distintos. La cifra principal es la cronometrada; la reconstruida es una estimación. Las
            interrupciones anotadas no se descontaron.
          </ResultsNote>
          <ResultsDisclosure title="Tabla con RIC" subtitle="asistido, cronometrado y reconstruido">
            <ComparisonTable comparisons={comparisons} record={record} />
          </ResultsDisclosure>
          <ResultsDisclosure
            title="Semanas y en qué terminó cada bloque"
            subtitle={`${formatCount(record.weeks.length, "semana", "semanas")} · ${formatCount(record.blocks.length, "bloque", "bloques")}`}
          >
            <WeeksAndOutcomes record={record} />
          </ResultsDisclosure>
          <ResultsDisclosure
            title={`Los ${record.blocks.length} bloques del registro`}
            subtitle="con observaciones del operador"
          >
            <BlocksTable record={record} />
          </ResultsDisclosure>
        </>
      )}
    </>
  );
}

/** "octubre", or "septiembre a octubre" when the record spans two months. */
function monthsText(from: string, to: string): string {
  const month = (day: string) => dayText(day).replace(/^\d+ de /, "");
  return month(from) === month(to) ? month(from) : `${month(from)} a ${month(to)}`;
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
