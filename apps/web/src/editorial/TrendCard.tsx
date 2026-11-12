import { useAtomValue } from "@effect/atom-react";
import {
  agoText,
  decisionActionText,
  priorDecisionText,
  ThreadId,
  type EditorialCardDecision,
  type EditorialCardItem,
  type EditorialGetJudgeOpinionResult,
  type EditorialTrendSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { useOpenLink } from "../browser/useOpenLink";
import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { formatDate, sourceLabel } from "./editorial.logic";
import { usePairsMode } from "./pairsMode";
import { editorialEnvironment } from "./state";
import { TrendDecision } from "./TrendDecision";
import {
  cardCoverageLine,
  cardCurveLine,
  cardFitLine,
  cardMovementLine,
  cardTitle,
  evidenceBySource,
  secondSourceText,
} from "./trendCard.logic";

// The brief trend card (engine v3, contract §1, approved by Miguel on 9 November 2026): three
// lines and a detail. Ranking, scores, growth, coverage tables, eligibility and novelty are
// not on screen; they stay in the dossier JSON.

export function ExternalLink({
  url,
  className,
  children,
}: {
  readonly url: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const openLink = useOpenLink(null);
  return (
    <a
      href={url}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        openLink(url, { event }).catch((error: unknown) => {
          console.error("Could not open the card link.", error);
        });
      }}
      className={cn(
        "rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
    >
      {children}
    </a>
  );
}

const shortTitle = (title: string, max = 48) =>
  title.length <= max ? title : `${title.slice(0, max - 1).trimEnd()}…`;

function Headline({ item }: { readonly item: EditorialCardItem }) {
  if (item.url === null) return <span>{shortTitle(item.title)}</span>;
  return (
    <ExternalLink url={item.url} className="text-foreground/90">
      {shortTitle(item.title)}
    </ExternalLink>
  );
}

function EvidenceGroups({ items }: { readonly items: ReadonlyArray<EditorialCardItem> }) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">El expediente no trae evidencia.</p>;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {evidenceBySource(items).map((group) => (
        <section key={group.source} aria-label={`Evidencia de ${sourceLabel(group.source)}`}>
          <h4 className="text-xs font-medium text-muted-foreground">{sourceLabel(group.source)}</h4>
          <ul className="mt-1 flex flex-col gap-1">
            {group.items.map((item) => (
              <li
                key={item.itemId ?? `${item.source}:${item.title}`}
                data-card-evidence={item.itemId ?? ""}
                className="flex min-w-0 flex-col text-sm"
              >
                {item.url === null ? (
                  <span className="text-foreground">{item.title}</span>
                ) : (
                  <ExternalLink
                    url={item.url}
                    className="inline-flex min-w-0 items-baseline gap-1 text-foreground"
                  >
                    <span className="min-w-0">{item.title}</span>
                    <ExternalLinkIcon
                      aria-hidden
                      className="size-3 shrink-0 translate-y-0.5 text-muted-foreground"
                    />
                  </ExternalLink>
                )}
                <span className="text-xs text-muted-foreground tabular-nums">
                  <code className="font-mono text-2xs">{item.itemId ?? "sin id"}</code>
                  {item.day === null ? null : ` · ${item.day}`}
                  {item.alsoIn && item.alsoIn.length > 0
                    ? ` · también en ${item.alsoIn.map(sourceLabel).join(", ")}`
                    : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function DetailBlock({
  title,
  children,
}: {
  readonly title: string | null;
  readonly children: ReactNode;
}) {
  if (title === null) return <div className="flex flex-col gap-1.5">{children}</div>;
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h4>
      {children}
    </section>
  );
}

/** "aceptado · utilidad 4 de 5 · «motivo» · 1 nov 2026, 10:00". */
function RecordedDecision({
  environmentId,
  decision,
}: {
  readonly environmentId: EnvironmentId;
  readonly decision: EditorialCardDecision;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p className="text-foreground">
        <span className="font-medium">{decisionActionText(decision.action)}</span>
        {decision.utility === null ? null : ` · utilidad ${decision.utility} de 5`}
        {decision.reason ? ` · «${decision.reason}»` : null}
      </p>
      <p className="text-xs text-muted-foreground">Registrada {formatDate(decision.decidedAt)}</p>
      <div>
        <Button
          size="xs"
          variant="outline"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: ThreadId.make(decision.threadId) }}
            />
          }
        >
          Abrir el hilo de video
        </Button>
      </div>
    </div>
  );
}

/**
 * The judges' opinion. Never in pairs mode; otherwise only once the operator recorded a
 * decision with utility, and the server checks that again before it answers.
 */
function JudgeOpinionView({
  pairsMode,
  decision,
  result,
  titled,
}: {
  readonly pairsMode: boolean;
  readonly decision: EditorialCardDecision | null;
  readonly result: EditorialGetJudgeOpinionResult | null;
  readonly titled: boolean;
}) {
  if (pairsMode) return null;
  const title = titled ? "Opinión de los jueces" : null;
  if (decision === null || decision.utility === null) {
    return (
      <DetailBlock title={title}>
        <p className="text-xs text-muted-foreground">
          Se muestra después de que registres tu decisión con utilidad.
        </p>
      </DetailBlock>
    );
  }
  if (result === null || result._tag !== "shown") {
    return result?._tag === "none" ? (
      <DetailBlock title={title}>
        <p className="text-xs text-muted-foreground">
          Esta tarjeta no tiene opinión de los jueces.
        </p>
      </DetailBlock>
    ) : null;
  }
  const { view } = result;
  return (
    <DetailBlock title={title}>
      <div data-judge-opinion="" className="flex flex-col gap-1.5 text-sm">
        <p className="text-xs text-warning-foreground">Opinión del modelo, no validada.</p>
        {view.utility === null ? null : (
          <p className="text-foreground">
            Utilidad media {view.utility.toLocaleString("es", { maximumFractionDigits: 1 })} de 5
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {view.opinions.map((opinion) => (
            <li key={opinion.judge} className="text-sm text-foreground/90">
              <span className="font-medium">{opinion.judge}</span>
              {opinion.utility === null ? null : ` · ${opinion.utility} de 5`}
              {` · ${opinion.reason}`}
              {opinion.angle ? (
                <span className="text-muted-foreground"> · ángulo: {opinion.angle}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </DetailBlock>
  );
}

/**
 * Fetches the opinion only when the view may show it. Untitled inside the dossier's own
 * "Opinión de los jueces" disclosure.
 */
export function JudgeOpinion({
  environmentId,
  trend,
  decision,
  titled = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
  readonly decision: EditorialCardDecision | null;
  readonly titled?: boolean;
}) {
  const pairsMode = usePairsMode();
  const allowed = !pairsMode && decision !== null && decision.utility !== null;
  if (!allowed) {
    return (
      <JudgeOpinionView pairsMode={pairsMode} decision={decision} result={null} titled={titled} />
    );
  }
  return (
    <LoadedJudgeOpinion
      environmentId={environmentId}
      trend={trend}
      decision={decision}
      titled={titled}
    />
  );
}

function LoadedJudgeOpinion({
  environmentId,
  trend,
  decision,
  titled,
}: {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
  readonly decision: EditorialCardDecision;
  readonly titled: boolean;
}) {
  const result = AsyncResult.getOrElse(
    useAtomValue(
      editorialEnvironment.judgeOpinion({
        environmentId,
        input: { runId: trend.runId, dossierId: trend.dossierId },
      }),
    ),
    () => null,
  );
  return <JudgeOpinionView pairsMode={false} decision={decision} result={result} titled={titled} />;
}

export interface TrendCardViewProps {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
  readonly cutoffAt: string | null;
  /** Whether the detail starts open; the dossier page opens it. */
  readonly defaultOpen?: boolean;
  /** Whether the title links to the dossier page (the list) or not (the page itself). */
  readonly linkTitle?: boolean;
}

export function TrendCardView({
  environmentId,
  trend,
  cutoffAt,
  defaultOpen = false,
  linkTitle = true,
}: TrendCardViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const card = trend.card;
  const title = cardTitle(trend);
  const titleNode = linkTitle ? (
    <Link
      to="/editorial/$environmentId/trends/$dossierId"
      params={{ environmentId, dossierId: trend.dossierId }}
      search={{ run: trend.runId }}
      className="rounded-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {title}
    </Link>
  ) : (
    <span className="font-medium text-foreground">{title}</span>
  );
  if (card === undefined) {
    return (
      <article data-trend-card="" className="rounded-lg border border-border px-4 py-3">
        <p className="text-sm">{titleNode}</p>
      </article>
    );
  }
  const movement = cardMovementLine(card, cutoffAt);
  const fit = cardFitLine(card);
  const coverage = cardCoverageLine(card);
  const second = secondSourceText(card, cutoffAt);
  const decision = card.decision ?? null;
  const detailId = `card-detail-${trend.dossierId}`;
  return (
    <article
      data-trend-card=""
      aria-label={title}
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground"
    >
      <p className="text-sm leading-snug">
        {titleNode}
        {movement === null ? null : <span className="text-muted-foreground"> · {movement}</span>}
      </p>
      <p className="text-xs text-muted-foreground tabular-nums">{cardCurveLine(card, cutoffAt)}</p>
      <p className="text-xs text-muted-foreground">
        {fit}
        {card.headlines.map((headline) => (
          <span key={headline.itemId ?? headline.title}>
            {fit.length > 0 || headline !== card.headlines[0] ? " · " : null}
            <Headline item={headline} />
          </span>
        ))}
      </p>
      {coverage === null ? null : <p className="text-xs text-warning-foreground">{coverage}</p>}
      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
          Detalle
        </button>
      </div>
      {open ? (
        <div id={detailId} className="mt-2 flex flex-col gap-4 border-t border-border pt-3">
          <DetailBlock title={`Evidencia (${card.evidence.length})`}>
            <EvidenceGroups items={card.evidence} />
          </DetailBlock>
          {card.firstSource !== null || second !== null ? (
            <DetailBlock title="Fuentes">
              <p className="text-sm text-foreground/90">
                {[
                  card.firstSource === null
                    ? null
                    : `apareció en ${card.firstSource.source} ${agoText(card.firstSource.day, cutoffAt)} (${card.firstSource.day})`,
                  second === null ? null : `${second} (${card.secondSource?.day})`,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </p>
            </DetailBlock>
          ) : null}
          {card.priorDecision ? (
            <DetailBlock title="Ya decidido">
              <p className="text-sm text-foreground">{priorDecisionText(card.priorDecision)}</p>
            </DetailBlock>
          ) : null}
          <DetailBlock title="Decisión">
            {decision === null ? (
              <TrendDecision environmentId={environmentId} trend={trend} bare />
            ) : (
              <RecordedDecision environmentId={environmentId} decision={decision} />
            )}
          </DetailBlock>
          <JudgeOpinion environmentId={environmentId} trend={trend} decision={decision} />
        </div>
      ) : null}
    </article>
  );
}
