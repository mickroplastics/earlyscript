import {
  sourceCountText,
  type EditorialSourceCoverage,
  type EditorialTrendCard,
} from "@t3tools/contracts";
import { useId } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { sourceName } from "./editorial.logic";
import { DossierDisclosure } from "./TrendDossierDisclosure";
import {
  coverageDaysText,
  incompleteSourcesText,
  movementChart,
  movementHeadline,
  quietSourcesText,
  weekRangeLabels,
} from "./trendDossier.logic";
import { sourceColor, TrendWeeklyBars } from "./TrendWeeklyBars";

const PARTIAL_HINT =
  "Esta fuente aún no tiene las 5 semanas de historia que se piden para comparar.";

function PartialMark() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="cursor-default underline decoration-dotted underline-offset-2" />}
      >
        parcial
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        {PARTIAL_HINT}
      </TooltipPopup>
    </Tooltip>
  );
}

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
}: {
  readonly card: EditorialTrendCard;
  readonly weekLabels: ReadonlyArray<string>;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
}) {
  const days = (source: string) => {
    const entry = coverage.find((candidate) => candidate.source === source);
    return entry === undefined ? "" : coverageDaysText(entry);
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Fuente</TableHead>
          {weekLabels.map((label) => (
            <TableHead key={label}>
              <span className="block text-end font-normal whitespace-normal text-muted-foreground">
                {label}
              </span>
            </TableHead>
          ))}
          {coverage.length === 0 ? null : (
            <TableHead>
              <span className="block font-normal whitespace-normal text-muted-foreground">
                Días capturados
              </span>
            </TableHead>
          )}
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
            {coverage.length === 0 ? null : (
              <TableCell>
                <span className="block whitespace-normal text-muted-foreground tabular-nums">
                  {days(row.source)}
                </span>
              </TableCell>
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
  const incomplete = incompleteSourcesText(card.incompleteSources, quiet?.caveatSources ?? []);
  const single = chart.series.length === 1 ? chart.series[0] : undefined;
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
          {chart.series.length >= 2 ? (
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
          <div className="flex items-baseline gap-2">
            {headline.count === null ? null : (
              <span className="text-2xl font-semibold text-foreground tabular-nums">
                {headline.count}
              </span>
            )}
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              {headline.last}
              {single ? `, en ${single.name}` : null}
              {single?.partial ? (
                <>
                  {" ("}
                  <PartialMark />)
                </>
              ) : null}
              {headline.previous === null ? null : ` · ${headline.previous}`}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {sourceCountText(card.sourceCount)}
            </span>
          </div>
          {quiet || incomplete ? (
            <div className="flex flex-col gap-1 text-xs">
              {quiet ? <p className="text-muted-foreground">{quiet.text}</p> : null}
              {quiet?.caveat ? <p className="text-warning-foreground">{quiet.caveat}</p> : null}
              {incomplete ? <p className="text-warning-foreground">{incomplete}</p> : null}
            </div>
          ) : null}
          <DossierDisclosure label="Semanas por fuente">
            <WeeksBySource card={card} weekLabels={weekLabels} coverage={coverage} />
          </DossierDisclosure>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Describe actividad; no predice el éxito de un video.
      </p>
    </section>
  );
}
