import type { EditorialEvidenceItem, EditorialTrendDossier } from "@t3tools/contracts";
import { ExternalLinkIcon, GlobeIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { citationSegments, sourceLabel, whyHereReasons } from "../editorial.logic";
import { cardMovementLine } from "../trendCard.logic";
import { sourceUrl, type NumberedSource } from "./videoWorkspace.logic";

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** «2 nov 2026», the calendar day the source carries (UTC, as the engine stores it). */
export function sourceDay(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return `${day} ${MONTHS[(month ?? 1) - 1]} ${year}`;
}

function SourceNumber({
  number,
  label,
  onOpen,
}: {
  readonly number: number;
  readonly label: string;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onOpen}
      className="ms-0.5 rounded px-px align-super font-semibold text-2xs text-primary leading-none hover:bg-primary/16 focus-visible:outline-2 focus-visible:outline-ring"
    >
      {number}
    </button>
  );
}

/** Segments keyed by where they start in the text, stable across renders. */
function keyed(segments: ReturnType<typeof citationSegments>) {
  let offset = 0;
  return segments.map((segment) => {
    const key = `${segment.kind}-${offset}`;
    offset += segment.kind === "text" ? segment.text.length : 1;
    return { key, segment };
  });
}

/** One sentence block of the trend's summary, its citations renumbered like the script's. */
function SummaryText({
  text,
  ordered,
  onOpenSource,
}: {
  readonly text: string;
  readonly ordered: ReadonlyArray<EditorialEvidenceItem>;
  readonly onOpenSource: (id: string) => void;
}) {
  return (
    <p className="text-base leading-7">
      {keyed(citationSegments(text, ordered)).map(({ key, segment }) =>
        segment.kind === "text" ? (
          <span key={key}>{segment.text}</span>
        ) : (
          <SourceNumber
            key={key}
            number={segment.number}
            label={`Fuente ${segment.number}`}
            onOpen={() => onOpenSource(segment.itemId)}
          />
        ),
      )}
    </p>
  );
}

/** The trend card as the thread starts: what happened, why it matters, the video angle. */
export function TopicPanel({
  dossier,
  sources,
  onOpenSource,
  trendLink,
}: {
  readonly dossier: EditorialTrendDossier;
  readonly sources: ReadonlyArray<NumberedSource>;
  readonly onOpenSource: (id: string) => void;
  readonly trendLink: React.ReactNode;
}) {
  const { trend, run } = dossier;
  // `citationSegments` numbers by position: hand it the evidence in the script's order.
  const ordered = sources.flatMap((source) => (source.evidence ? [source.evidence] : []));
  const summary = trend.presentation?.summary;
  const cited = new Set(trend.presentation?.citedItemIds ?? []);
  const citedSources = sources.filter((source) => cited.has(source.id));
  const chips = [
    trend.card ? cardMovementLine(trend.card, run.cutoffAt) : null,
    run.cutoffAt ? `Corrida del ${sourceDay(run.cutoffAt)}` : null,
    `${dossier.evidenceTotal} fuentes`,
  ].filter((chip): chip is string => chip !== null && chip.length > 0);
  const blocks = summary
    ? [
        { label: "Qué pasó", text: summary.whatHappened },
        { label: "Por qué importa al canal", text: summary.whyItMatters },
        { label: "Ángulo de video", text: summary.videoAngle, angle: true },
      ]
    : [];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip}
            className="rounded-full border px-2.5 py-0.5 text-muted-foreground text-xs first-letter:uppercase"
          >
            {chip}
          </span>
        ))}
      </div>
      {blocks.length > 0 ? (
        blocks.map((block) => (
          <section
            key={block.label}
            className={cn(
              "flex flex-col gap-1.5",
              block.angle && "rounded-lg border border-primary/24 bg-primary/5 p-3.5",
            )}
          >
            <h3
              className={cn(
                "font-medium text-2xs uppercase tracking-wider",
                block.angle ? "text-primary" : "text-muted-foreground",
              )}
            >
              {block.label}
            </h3>
            <SummaryText text={block.text} ordered={ordered} onOpenSource={onOpenSource} />
          </section>
        ))
      ) : (
        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-2xs text-muted-foreground uppercase tracking-wider">
            Por qué está aquí
          </h3>
          <p className="text-base leading-7">
            {whyHereReasons({
              trend,
              affinityThreshold: dossier.affinityThreshold,
              coverage: dossier.coverage,
            }).join(" ")}
          </p>
        </section>
      )}
      {citedSources.length > 0 ? (
        <section className="flex flex-col rounded-lg border">
          <h3 className="border-b px-3.5 py-2 font-medium text-2xs text-muted-foreground uppercase tracking-wider">
            Fuentes citadas arriba · misma numeración que en el guion
          </h3>
          <ul className="flex flex-col divide-y">
            {citedSources.map((source) => (
              <SourceRow key={source.id} source={source} onOpen={onOpenSource} compact />
            ))}
          </ul>
        </section>
      ) : null}
      {trend.presentation ? (
        <p className="text-muted-foreground text-xs">
          Resumen redactado por un modelo; la evidencia manda. {trendLink}
        </p>
      ) : (
        <p className="text-muted-foreground text-xs">{trendLink}</p>
      )}
    </div>
  );
}

function SourceRow({
  source,
  onOpen,
  compact = false,
}: {
  readonly source: NumberedSource;
  readonly onOpen: (id: string) => void;
  readonly compact?: boolean;
}) {
  const evidence = source.evidence;
  const url = sourceUrl(evidence);
  return (
    <li className="flex items-start gap-3 px-3.5 py-2.5">
      <span className="w-5 shrink-0 pt-px text-right font-semibold text-primary text-sm tabular-nums">
        {source.number}
      </span>
      <div className="min-w-0 flex-1">
        {evidence ? (
          <button
            type="button"
            className="text-left text-sm leading-snug hover:underline"
            onClick={() => onOpen(source.id)}
          >
            {evidence.title}
          </button>
        ) : (
          <p className="text-muted-foreground text-sm">Fuente que no está en el expediente</p>
        )}
        <p className="text-muted-foreground text-xs">
          {evidence
            ? [sourceLabel(evidence.source), sourceDay(evidence.publishedAt), evidence.author]
                .filter(Boolean)
                .join(" · ")
            : source.id}
          {compact
            ? ""
            : source.uses > 0
              ? ` · citada ${source.uses === 1 ? "1 vez" : `${source.uses} veces`} en ${source.sections.join(", ")}`
              : " · no se cita en el guion"}
        </p>
      </div>
      {compact || url === null ? null : (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button size="xs" variant="ghost-muted" onClick={() => onOpen(source.id)}>
            <GlobeIcon aria-hidden />
            Abrir
          </Button>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Abrir fuera de la app"
            render={<a href={url} target="_blank" rel="noreferrer" />}
          >
            <ExternalLinkIcon aria-hidden />
          </Button>
        </div>
      )}
    </li>
  );
}

/** Every source of the dossier, numbered as everywhere else, with how the script uses it. */
export function SourcesPanel({
  sources,
  onOpenSource,
}: {
  readonly sources: ReadonlyArray<NumberedSource>;
  readonly onOpenSource: (id: string) => void;
}) {
  const cited = sources.filter((source) => source.uses > 0).length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        {sources.length} fuentes del expediente
        {cited > 0 ? `; el guion cita ${cited}` : ""}. Las abres aquí al lado, en el navegador.
      </p>
      <ul className="flex flex-col divide-y rounded-lg border">
        {sources.map((source) => (
          <SourceRow key={source.id} source={source} onOpen={onOpenSource} />
        ))}
      </ul>
    </div>
  );
}
