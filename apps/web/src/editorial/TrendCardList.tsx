import type { EditorialInbox, EditorialTrendSummary, EnvironmentId } from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { blindCards, blindCardsMarkdown, downloadTextFile } from "./blindExport";
import { formatDay } from "./editorial.logic";
import { usePairsMode } from "./pairsMode";
import { TrendCardView } from "./TrendCard";
import { cardSections, SECTION_TITLES } from "./trendCard.logic";

function CardSection({
  title,
  environmentId,
  trends,
  cutoffAt,
}: {
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly trends: ReadonlyArray<EditorialTrendSummary>;
  readonly cutoffAt: string | null;
}) {
  if (trends.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">
        {title} <span className="font-normal text-muted-foreground">({trends.length})</span>
      </h2>
      <div className="flex flex-col gap-2">
        {trends.map((trend) => (
          <TrendCardView
            key={trend.dossierId}
            environmentId={environmentId}
            trend={trend}
            cutoffAt={cutoffAt}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Tendencias with no dossier open: the run's brief cards, "En movimiento" and "De fondo" in the
 * engine's order (one list for an older run). Snoozed and dismissed trends stay in the sidebar.
 */
export function TrendCardList({
  environmentId,
  inbox,
}: {
  readonly environmentId: EnvironmentId;
  readonly inbox: EditorialInbox;
}) {
  const pairsMode = usePairsMode();
  const run = inbox.run;
  const cutoffAt = run?.cutoffAt ?? null;
  const active = inbox.trends.filter(
    (trend) => trend.inbox?.dismissed == null && trend.inbox?.snoozed == null,
  );
  const sections = cardSections(active);
  const exportBlind = () => {
    if (run === null) return;
    const day = cutoffAt?.slice(0, 10) ?? "sin-corte";
    downloadTextFile(
      `tarjetas-ciegas-${day}.md`,
      blindCardsMarkdown(blindCards(run, inbox.trends)),
      "text/markdown;charset=utf-8",
    );
  };
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-foreground">Tendencias</h1>
          <p className="text-xs text-muted-foreground">
            {cutoffAt === null ? "Corrida sin corte" : `Corte del ${formatDay(cutoffAt)}`} · semanas
            W3→W2→W1→W0, la última es la previa al corte
            {pairsMode ? " · modo pares activo" : null}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={exportBlind} disabled={run === null}>
          <DownloadIcon aria-hidden />
          Exportar ciega
        </Button>
      </header>
      {sections === null ? (
        <CardSection
          title="Tendencias de la corrida"
          environmentId={environmentId}
          trends={active}
          cutoffAt={cutoffAt}
        />
      ) : (
        <>
          <CardSection
            title={SECTION_TITLES.moving}
            environmentId={environmentId}
            trends={sections.moving}
            cutoffAt={cutoffAt}
          />
          <CardSection
            title={SECTION_TITLES.background}
            environmentId={environmentId}
            trends={sections.background}
            cutoffAt={cutoffAt}
          />
        </>
      )}
    </div>
  );
}
