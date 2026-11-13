import {
  sourceCountText,
  type EditorialSourceCoverage,
  type EditorialTrendCard,
} from "@t3tools/contracts";
import { Fragment, useId } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { cn } from "../lib/utils";
import { sourceName } from "./editorial.logic";
import { DossierDisclosure } from "./TrendDossierDisclosure";
import { HelpMark } from "./TrendHelpMark";
import {
  activeCaptureText,
  coverageDaysText,
  incompleteSourcesText,
  movementChart,
  movementHeadline,
  quietSourcesText,
  weekRangeLabels,
  weekStartLabels,
} from "./trendDossier.logic";
import { sourceColor, TrendWeeklyBars } from "./TrendWeeklyBars";

const PARTIAL_HINT =
  "Esta fuente aún no tiene las 5 semanas de historia que se piden para comparar.";

const PartialMark = () => <HelpMark label="parcial" hint={PARTIAL_HINT} />;

const ACTIVE_CAPTURE_HINT =
  "Días con la captura diaria completa en la ventana de 28 días. Con días incompletos, sus cifras pueden quedarse cortas.";

function UncapturedCell() {
  return (
    <>
      <span aria-hidden>?</span>
      <span className="sr-only">sin captura</span>
    </>
  );
}

/** Every row of the curve, zeros and the unused source included, with the days captured. */
function WeeksBySource({
  card,
  weekLabels,
  coverage,
  cutoffAt,
}: {
  readonly card: EditorialTrendCard;
  readonly weekLabels: ReadonlyArray<string>;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
  readonly cutoffAt: string | null;
}) {
  const weekStarts = weekStartLabels(cutoffAt);
  const days = (source: string) => {
    const entry = coverage.find((candidate) => candidate.source === source);
    return entry === undefined ? "" : coverageDaysText(entry);
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <span className="block">Fuente</span>
            {coverage.length === 0 ? null : (
              <span className="block font-normal text-muted-foreground">días capturados</span>
            )}
          </TableHead>
          {weekStarts.map((start, index) => (
            <TableHead key={start}>
              <span className="block text-end font-normal text-muted-foreground">
                <span aria-hidden>{start}</span>
                <span className="sr-only">{weekLabels[index]}</span>
              </span>
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {card.curve.map((row) => (
          <TableRow key={row.source}>
            <TableCell>
              <span className="block whitespace-normal">
                {sourceName(row.source)}
                {row.status === "partial" ? (
                  <span className="text-muted-foreground"> · parcial</span>
                ) : null}
              </span>
              {days(row.source) === "" ? null : (
                <span className="block whitespace-normal text-muted-foreground tabular-nums">
                  {days(row.source)}
                </span>
              )}
            </TableCell>
            {row.status === "unused" ? (
              <TableCell colSpan={weekLabels.length}>
                <span className="block whitespace-normal text-muted-foreground">
                  se captura pero no se agrupa
                </span>
              </TableCell>
            ) : (
              weekLabels.map((label, index) => {
                const week = row.weeks[index] ?? null;
                return (
                  <TableCell key={label}>
                    <span className="block text-end tabular-nums">
                      {week === null ? <UncapturedCell /> : week}
                    </span>
                  </TableCell>
                );
              })
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The dossier's "Movimiento" card: publications per week by source, and what is unknown. */
export function TrendMovementPanel({
  card,
  cutoffAt,
  coverage,
}: {
  readonly card: EditorialTrendCard;
  readonly cutoffAt: string | null;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
}) {
  const headingId = useId();
  const chart = movementChart(card);
  const weekLabels = weekRangeLabels(cutoffAt);
  const headline = movementHeadline(chart);
  const quiet = quietSourcesText(chart, coverage, card.incompleteSources);
  const activeCapture = activeCaptureText(chart, coverage);
  const incomplete = incompleteSourcesText(card.incompleteSources, [
    ...(quiet?.saidSources ?? []),
    ...(activeCapture?.sources ?? []),
  ]);
  // Only a known total is that source's alone.
  const single = chart.series.length === 1 && headline.count !== null ? chart.series[0] : undefined;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 self-start rounded-xl border border-border bg-card p-4 text-card-foreground"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-foreground">
          Movimiento
        </h2>
        <span className="text-xs text-muted-foreground">Publicaciones por semana</span>
      </div>
      {card.curve.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Esta ficha no trae publicaciones por semana.
        </p>
      ) : (
        <>
          {chart.series.length === 0 ? null : (
            <TrendWeeklyBars chart={chart} weekLabels={weekLabels} />
          )}
          {/* A lone series names itself next to a known total; without one, here. */}
          {chart.series.length >= 2 || (chart.series.length === 1 && single === undefined) ? (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {chart.series.map((series) => (
                <li key={series.source} className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn("size-2 rounded-full", sourceColor(series.source))}
                  />
                  <span className="text-foreground">{series.name}</span>
                  {series.partial ? (
                    <>
                      <span aria-hidden>·</span>
                      <PartialMark />
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-col gap-0.5">
            <p className="flex items-baseline gap-2">
              {headline.count === null ? null : (
                <span className="text-2xl font-semibold text-foreground tabular-nums">
                  {headline.count}
                </span>
              )}
              <span className="min-w-0 text-xs text-muted-foreground">
                {headline.last}
                {single ? `, en ${single.name}` : null}
                {single?.partial ? (
                  <>
                    {" ("}
                    <PartialMark />)
                  </>
                ) : null}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {[headline.previous, sourceCountText(card.sourceCount)]
                .filter((part) => part !== null)
                .join(" · ")}
            </p>
          </div>
          {quiet || activeCapture || incomplete ? (
            // One paragraph, so short sentences share lines instead of stacking.
            <p className="text-xs text-warning-foreground">
              {[
                activeCapture ? (
                  <Fragment key="active">
                    <HelpMark label="Captura diaria incompleta" hint={ACTIVE_CAPTURE_HINT} />:{" "}
                    {activeCapture.days}.
                  </Fragment>
                ) : null,
                quiet?.text ? (
                  <span key="quiet" className="text-muted-foreground">
                    {quiet.text}
                  </span>
                ) : null,
                quiet?.partial ?? null,
                quiet?.uncaptured ?? null,
                incomplete,
              ]
                .filter((sentence) => sentence !== null)
                .map((sentence, index) => (
                  <Fragment key={typeof sentence === "string" ? sentence : `node-${index}`}>
                    {index === 0 ? null : " "}
                    {sentence}
                  </Fragment>
                ))}
            </p>
          ) : null}
          <DossierDisclosure label="Semanas por fuente">
            <WeeksBySource
              card={card}
              weekLabels={weekLabels}
              coverage={coverage}
              cutoffAt={cutoffAt}
            />
          </DossierDisclosure>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Describe actividad; no predice el éxito de un video.
      </p>
    </section>
  );
}
