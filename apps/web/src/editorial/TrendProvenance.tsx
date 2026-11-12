import { agoText, type EditorialTrendDossier } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { formatDate, sourceName } from "./editorial.logic";
import { usePairsMode } from "./pairsMode";
import { SECTION_TITLES } from "./trendCard.logic";
import { DossierDisclosure } from "./TrendDossierDisclosure";
import { movementBadge, storyPresentation } from "./trendDossier.logic";

function Entry({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{term}</dt>
      <dd className="flex flex-col gap-0.5 text-xs text-foreground/90">{children}</dd>
    </div>
  );
}

const yesNo = (value: boolean) => (value ? "sí" : "no");

/** Where the dossier comes from and the technical details nobody needs to decide. */
export function TrendProvenance({ dossier }: { readonly dossier: EditorialTrendDossier }) {
  // In pairs mode nothing tells which model drafted the summary.
  const pairsMode = usePairsMode();
  const { trend, run } = dossier;
  const card = trend.card;
  const presentation = storyPresentation(trend);
  const cutoffAt = run.cutoffAt;
  const sourceDay = (entry: { readonly source: string; readonly day: string }) =>
    `${sourceName(entry.source)} · ${formatDate(`${entry.day.slice(0, 10)}T00:00:00.000Z`)} (${agoText(entry.day, cutoffAt)})`;
  const badge = card ? movementBadge(card) : null;
  const classification = card
    ? [
        badge === null
          ? null
          : card.since === null
            ? badge.label
            : `${badge.label}, desde el ${formatDate(`${card.since.slice(0, 10)}T00:00:00.000Z`)}`,
        card.section === null ? null : SECTION_TITLES[card.section],
        `Tema recurrente: ${yesNo(card.perennial)}`,
        card.saturated === null ? null : `Saturado: ${yesNo(card.saturated)}`,
      ]
        .filter((part) => part !== null)
        .join(" · ")
    : null;
  return (
    <div className="border-t border-border pt-4">
      <DossierDisclosure label="Procedencia y detalles técnicos">
        <dl className="grid gap-x-6 gap-y-4 @2xl/dossier:grid-cols-2">
          {card && (card.firstSource !== null || card.secondSource !== null) ? (
            <Entry term="Primera publicación registrada">
              {card.firstSource === null ? null : <span>{sourceDay(card.firstSource)}</span>}
              {card.secondSource === null ? null : (
                <span>Después en {sourceDay(card.secondSource)}</span>
              )}
              <span className="text-muted-foreground">
                Primera entre las fuentes comparables; no es necesariamente el origen.
              </span>
            </Entry>
          ) : null}
          {classification ? <Entry term="Clasificación">{classification}</Entry> : null}
          <Entry term="Términos detectados">{trend.label}</Entry>
          <Entry term="Corrida">
            <span>
              {[
                cutoffAt === null ? "Sin corte" : `Corte: ${formatDate(cutoffAt)}`,
                run.configVersion === null ? null : `configuración ${run.configVersion}`,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </span>
            <code className="font-mono text-2xs break-all text-muted-foreground">{run.runId}</code>
            <code className="font-mono text-2xs break-all text-muted-foreground">
              {trend.dossierId}
            </code>
          </Entry>
          {presentation && !pairsMode ? (
            <Entry term="Relato">
              <span>
                Modelo: {presentation.model} · prompt {presentation.promptVersion} ·{" "}
                {formatDate(presentation.generatedAt)}
              </span>
              <span className="text-muted-foreground">
                Redactar no cambia el orden de la bandeja ni la clasificación.
              </span>
            </Entry>
          ) : null}
          {card?.origin === "derived" ? (
            <Entry term="Origen">
              Ficha reconstruida de una corrida anterior: no trae movimiento ni semanas por fuente.
            </Entry>
          ) : null}
        </dl>
      </DossierDisclosure>
    </div>
  );
}
