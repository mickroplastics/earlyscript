import { useAtomValue } from "@effect/atom-react";
import {
  agoText,
  type EditorialDossierId,
  type EditorialEvidenceItem,
  type EditorialRunId,
  type EditorialTrendCard,
  type EditorialTrendDossier,
  type EditorialTrendKey,
  type EditorialTrendPresentation,
  type EditorialTrendSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  ExternalLinkIcon,
  PanelLeftIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useId, useState } from "react";

import { useOpenLink } from "../browser/useOpenLink";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useSidebar, useSidebarVisibility } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import { citationSegments, evidenceLinks, formatDate, sourceName } from "./editorial.logic";
import { EditorialEmptyPage, EditorialPage } from "./EditorialPage";
import {
  CITATION_EVIDENCE_LIMIT,
  DOSSIER_EVIDENCE_ALL_LIMIT,
  DOSSIER_EVIDENCE_PAGE_SIZE as EVIDENCE_PAGE_SIZE,
  presentationEnvironment,
} from "./presentationState";
import { usePairsMode } from "./pairsMode";
import { editorialEnvironment } from "./state";
import { useTrendActions } from "./trendActions";
import { ExternalLink } from "./TrendCard";
import { TrendCardList } from "./TrendCardList";
import { TrendDecisionPanel } from "./TrendDecisionPanel";
import {
  decisionPanelState,
  evidenceAlsoIn,
  movementBadge,
  profileFitText,
} from "./trendDossier.logic";
import { TrendEvidenceList } from "./TrendEvidenceList";
import { useTrendInbox } from "./TrendInbox";
import { useEditorialJobActivity } from "./TrendJobIndicator";
import { TrendMovementPanel } from "./TrendMovementPanel";
import { TrendProvenance } from "./TrendProvenance";

const SPACE_LABEL = "Tendencias";

/** A citation number that opens its evidence, like the evidence list's links. */
function CitationLink({
  number,
  item,
}: {
  readonly number: number;
  readonly item: EditorialEvidenceItem;
}) {
  const openLink = useOpenLink(null);
  const url = evidenceLinks(item).title;
  const label = `Evidencia ${number}: ${item.title}`;
  const className =
    "ms-0.5 inline-block rounded-xs px-0.5 align-super text-2xs leading-none font-medium tabular-nums";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          url ? (
            <a
              href={url}
              aria-label={label}
              data-citation={item.itemId}
              onClick={(event) => {
                event.preventDefault();
                openLink(url, { event }).catch((error: unknown) => {
                  console.error("Could not open the cited evidence.", error);
                });
              }}
              className={cn(
                className,
                "text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              )}
            />
          ) : (
            <span
              aria-label={label}
              data-citation={item.itemId}
              className={cn(className, "text-muted-foreground")}
            />
          )
        }
      >
        {number}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        {sourceName(item.source)} · {item.title} ·{" "}
        <code className="font-mono text-2xs">{item.itemId}</code>
      </TooltipPopup>
    </Tooltip>
  );
}

function CitedText({
  text,
  evidence,
}: {
  readonly text: string;
  readonly evidence: ReadonlyArray<EditorialEvidenceItem>;
}) {
  return (
    <>
      {citationSegments(text, evidence).map((segment, index) =>
        segment.kind === "text" ? (
          // oxlint-disable-next-line react/no-array-index-key -- segments are positional
          <span key={index}>{segment.text}</span>
        ) : (
          <CitationLink
            // oxlint-disable-next-line react/no-array-index-key -- the same item can be cited twice
            key={index}
            number={segment.number}
            item={segment.item}
          />
        ),
      )}
    </>
  );
}

/** Drafting is a human action: these come from the page, the view only renders them. */
export interface TrendPresentationActions {
  readonly busy: "draft" | "regenerate" | null;
  readonly error: string | null;
  readonly onDraft: () => void;
  readonly onRegenerate: () => void;
}

function PresentationError({ message }: { readonly message: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive-foreground">
      <TriangleAlertIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>No se pudo redactar: {message}</span>
    </p>
  );
}

function DraftPresentationPrompt({ actions }: { readonly actions: TrendPresentationActions }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          El asistente puede escribir un título y un resumen que citan la evidencia. Usa el modelo
          de redacción de Ajustes.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={actions.busy !== null}
          onClick={actions.onDraft}
        >
          {actions.busy === "draft" ? <Spinner /> : <SparklesIcon aria-hidden />}
          {actions.busy === "draft" ? "Redactando…" : "Redactar con el asistente"}
        </Button>
      </div>
      {actions.error ? <PresentationError message={actions.error} /> : null}
    </div>
  );
}

/** Without a summary, the card's two latest headlines stand in for "what happened". */
function RecentHeadlines({ card }: { readonly card: EditorialTrendCard }) {
  if (card.headlines.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">Titulares recientes</h3>
      <ul className="flex flex-col gap-1.5">
        {card.headlines.map((headline) => (
          <li key={headline.itemId ?? headline.title} className="flex min-w-0 flex-col text-sm">
            {headline.url === null ? (
              <span className="text-foreground">{headline.title}</span>
            ) : (
              <ExternalLink
                url={headline.url}
                className="inline-flex min-w-0 items-baseline gap-1 self-start text-foreground"
              >
                <span className="min-w-0">{headline.title}</span>
                <ExternalLinkIcon
                  aria-hidden
                  className="size-3 shrink-0 translate-y-0.5 text-muted-foreground"
                />
              </ExternalLink>
            )}
            <span className="text-xs text-muted-foreground">
              {sourceName(headline.source)}
              {headline.day === null
                ? null
                : ` · ${formatDate(`${headline.day.slice(0, 10)}T00:00:00.000Z`)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Qué pasó", the fit with the channel and the video angle, each with its citations. */
function TrendStory({
  presentation,
  card,
  evidence,
  actions,
}: {
  readonly presentation: EditorialTrendPresentation | undefined;
  readonly card: EditorialTrendCard | undefined;
  readonly evidence: ReadonlyArray<EditorialEvidenceItem>;
  readonly actions: TrendPresentationActions | undefined;
}) {
  // In pairs mode nothing tells that a model drafted the summary.
  const pairsMode = usePairsMode();
  const headingId = useId();
  const fit = card ? (
    <p className="text-xs text-muted-foreground">
      {profileFitText(card.fit)}
      {card.saturated === true ? " · Tema ya muy tratado." : null}
    </p>
  ) : null;
  if (presentation === undefined) {
    return (
      <section aria-label="Relato" className="flex min-w-0 flex-col gap-4">
        {actions ? <DraftPresentationPrompt actions={actions} /> : null}
        {card ? <RecentHeadlines card={card} /> : null}
        {fit ? (
          <div className="flex flex-col gap-1.5 border-t border-border pt-4">
            <h3 className="text-xs font-medium text-muted-foreground">Encaje con el canal</h3>
            {fit}
          </div>
        ) : null}
      </section>
    );
  }
  const stale = presentation.status === "stale";
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      {stale ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Redacción desactualizada</AlertTitle>
          <AlertDescription>
            Se escribió con una evidencia, un perfil del canal o una versión del prompt anteriores.
            Regenera para leer una redacción sobre la ficha actual.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h2 id={headingId} className="text-sm font-semibold text-foreground">
            Qué pasó
          </h2>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {pairsMode ? null : (
              <>
                <span>Redactado por el asistente</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span>{formatDate(presentation.generatedAt)}</span>
            {actions ? (
              <Button
                size="xs"
                variant={stale ? "outline" : "ghost-muted"}
                disabled={actions.busy !== null}
                onClick={actions.onRegenerate}
              >
                {actions.busy === "regenerate" ? <Spinner /> : <RefreshCwIcon aria-hidden />}
                {actions.busy === "regenerate" ? "Regenerando…" : "Regenerar"}
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-base leading-relaxed text-foreground">
          <CitedText text={presentation.summary.whatHappened} evidence={evidence} />
        </p>
      </div>
      <section
        aria-label="Encaje con el canal"
        className="flex flex-col gap-1.5 border-t border-border pt-4"
      >
        <h3 className="text-xs font-medium text-muted-foreground">Encaje con el canal</h3>
        <p className="text-sm leading-relaxed text-foreground">
          <CitedText text={presentation.summary.whyItMatters} evidence={evidence} />
        </p>
        {fit}
      </section>
      <section
        aria-label="Ángulo de video"
        className="flex flex-col gap-1 border-s-2 border-primary/50 ps-3"
      >
        <h3 className="text-xs font-medium text-muted-foreground">Ángulo de video</h3>
        <p className="text-sm leading-relaxed text-foreground">
          <CitedText text={presentation.summary.videoAngle} evidence={evidence} />
        </p>
      </section>
      {actions?.error ? <PresentationError message={actions.error} /> : null}
    </section>
  );
}

/** Movement badge, since when, the recurring mark and the trend's state. */
function TrendDossierHeader({
  trend,
  title,
  cutoffAt,
}: {
  readonly trend: EditorialTrendSummary;
  readonly title: string;
  readonly cutoffAt: string | null;
}) {
  const card = trend.card;
  const movement = card ? movementBadge(card) : null;
  const status = decisionPanelState(trend).badge;
  return (
    <header className="flex min-w-0 flex-col gap-2">
      {movement || card?.since || card?.perennial || status ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {movement ? <Badge variant={movement.variant}>{movement.label}</Badge> : null}
          {card?.since ? <span>desde {agoText(card.since, cutoffAt)}</span> : null}
          {card?.perennial ? (
            <>
              <span aria-hidden>·</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="cursor-default underline decoration-dotted underline-offset-2" />
                  }
                >
                  tema recurrente
                </TooltipTrigger>
                <TooltipPopup side="top" className="max-w-64">
                  Tuvo actividad varias semanas antes de este movimiento.
                </TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          {status ? (
            <Badge variant={status.variant} className="ms-auto">
              {status.label}
            </Badge>
          ) : null}
        </div>
      ) : null}
      <h1 className="max-w-3xl text-2xl font-semibold tracking-tight text-balance text-foreground">
        {title}
      </h1>
    </header>
  );
}

export function TrendDossierView({
  environmentId,
  dossier,
  allEvidence = null,
  onShowAllEvidence,
  onEvidencePage,
  citationEvidence,
  presentationActions,
}: {
  readonly environmentId: EnvironmentId;
  readonly dossier: EditorialTrendDossier;
  /** Every evidence item (or a page of fifty) once asked for; `null` until it loads. */
  readonly allEvidence?: EditorialTrendDossier | null;
  /** Asks the page to load every evidence item. */
  readonly onShowAllEvidence?: () => void;
  readonly onEvidencePage: (offset: number) => void;
  /** Evidence the assistant could cite, in dossier order; the first page until it loads. */
  readonly citationEvidence?: ReadonlyArray<EditorialEvidenceItem>;
  readonly presentationActions?: TrendPresentationActions;
}) {
  const { trend } = dossier;
  const presentation = trend.presentation;
  const card = trend.card;
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  return (
    <div className="@container/dossier flex min-w-0 flex-col gap-6">
      <TrendDossierHeader
        trend={trend}
        title={presentation?.title ?? trend.label}
        cutoffAt={dossier.run.cutoffAt}
      />
      <div className="grid gap-8 @3xl/dossier:grid-cols-[minmax(0,1fr)_22rem]">
        <TrendStory
          presentation={presentation}
          card={card}
          evidence={citationEvidence ?? dossier.evidence}
          actions={presentationActions}
        />
        {card === undefined ? null : (
          <TrendMovementPanel
            card={card}
            cutoffAt={dossier.run.cutoffAt}
            coverage={dossier.coverage}
          />
        )}
      </div>
      <TrendDecisionPanel environmentId={environmentId} trend={trend} />
      <TrendEvidenceList
        dossier={dossier}
        allEvidence={allEvidence}
        expanded={evidenceExpanded}
        onExpandedChange={(expanded) => {
          setEvidenceExpanded(expanded);
          if (expanded) onShowAllEvidence?.();
        }}
        onPage={onEvidencePage}
        alsoIn={evidenceAlsoIn(card)}
      />
      <TrendProvenance dossier={dossier} />
    </div>
  );
}

/** Opens the inbox in the sidebar, which is a sheet on a narrow window. */
function OpenInboxButton() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  if (useSidebarVisibility()) return null;
  return (
    <Button
      variant="outline"
      className="mt-5"
      onClick={() => (isMobile ? setOpenMobile(true) : setOpen(true))}
    >
      <PanelLeftIcon aria-hidden />
      Abrir la bandeja
    </Button>
  );
}

/**
 * Tendencias with no dossier open: the run's brief cards once it has trends; before that, a
 * pointer to the first-run card at the top of the inbox.
 */
export function TrendsEmptyPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const inbox = AsyncResult.getOrElse(useTrendInbox(environmentId, "new-first-growth"), () => null);
  const active = useEditorialJobActivity(environmentId);
  if (inbox !== null && (inbox.run === null || inbox.trends.length === 0) && active !== null) {
    return (
      <EditorialEmptyPage
        space={SPACE_LABEL}
        title="Corrida en curso"
        description="Sigue sus fases en la bandeja de Tendencias. Sus tendencias aparecen allí cuando termina la importación."
      >
        <OpenInboxButton />
      </EditorialEmptyPage>
    );
  }
  if (inbox !== null && (inbox.run === null || inbox.trends.length === 0)) {
    return (
      <EditorialEmptyPage
        space={SPACE_LABEL}
        title={
          inbox.run === null ? "Todavía no hay corridas" : "La última corrida no trajo tendencias"
        }
        description={
          inbox.run === null
            ? "Lanza la primera corrida desde la bandeja de Tendencias, en la barra lateral. Allí verás sus fases mientras corre y, al terminar, sus tendencias."
            : "La bandeja de Tendencias explica por qué y muestra la próxima corrida."
        }
      >
        <OpenInboxButton />
      </EditorialEmptyPage>
    );
  }
  if (inbox === null) return <EditorialPage space={SPACE_LABEL}>{null}</EditorialPage>;
  return (
    <EditorialPage space={SPACE_LABEL}>
      <TrendCardList environmentId={environmentId} inbox={inbox} />
    </EditorialPage>
  );
}

export function TrendDossierPage({
  environmentId,
  runId,
  dossierId,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: EditorialRunId | null;
  readonly dossierId: EditorialDossierId;
}) {
  const inbox = AsyncResult.getOrElse(useTrendInbox(environmentId, "new-first-growth"), () => null);
  const resolvedRunId = runId ?? inbox?.run?.runId ?? null;
  if (resolvedRunId === null) {
    return inbox !== null && inbox.run === null ? (
      <TrendsEmptyPage environmentId={environmentId} />
    ) : (
      <EditorialPage space={SPACE_LABEL}>{null}</EditorialPage>
    );
  }
  return (
    <LoadedTrendDossierPage
      // A new dossier starts on its first evidence page.
      key={`${resolvedRunId}:${dossierId}`}
      environmentId={environmentId}
      runId={resolvedRunId}
      dossierId={dossierId}
    />
  );
}

function LoadedTrendDossierPage({
  environmentId,
  runId,
  dossierId,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: EditorialRunId;
  readonly dossierId: EditorialDossierId;
}) {
  const [allEvidenceAsked, setAllEvidenceAsked] = useState(false);
  const [evidenceOffset, setEvidenceOffset] = useState(0);
  const firstPage = { runId, dossierId, evidenceLimit: EVIDENCE_PAGE_SIZE };
  const result = useAtomValue(editorialEnvironment.dossier({ environmentId, input: firstPage }));
  const dossier = AsyncResult.getOrElse(result, () => null);
  // Citations can point past the first evidence page; the assistant read at most twelve.
  const citationInput = { runId, dossierId, evidenceLimit: CITATION_EVIDENCE_LIMIT };
  const citationResult = useAtomValue(
    editorialEnvironment.dossier({ environmentId, input: citationInput }),
  );
  const citationDossier = AsyncResult.getOrElse(citationResult, () => null);
  const citationEvidence = citationDossier?.evidence;
  // "Ver toda la evidencia": the citation query already holds every item of a small dossier;
  // a larger one asks for pages of fifty. Until asked, this reads the citation query again.
  const needsAllQuery = allEvidenceAsked && (dossier?.evidenceTotal ?? 0) > CITATION_EVIDENCE_LIMIT;
  const allResult = useAtomValue(
    editorialEnvironment.dossier({
      environmentId,
      input: needsAllQuery
        ? {
            runId,
            dossierId,
            evidenceLimit: DOSSIER_EVIDENCE_ALL_LIMIT,
            ...(evidenceOffset === 0 ? {} : { evidenceOffset }),
          }
        : citationInput,
    }),
  );
  const allEvidence = allEvidenceAsked ? AsyncResult.getOrElse(allResult, () => null) : null;
  const presentationActions = usePresentationActions(environmentId, { runId, dossierId });
  const { markRead } = useTrendActions(environmentId);
  const unreadKey = dossier?.trend.isNew ? dossier.trend.trendKey : undefined;
  const recordRead = useEffectEvent((trendKey: EditorialTrendKey) => {
    void markRead({ trendKey, runId, dossierId });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening a dossier records it as read on the server, as visiting a thread does
  useEffect(() => {
    if (unreadKey !== undefined) recordRead(unreadKey);
  }, [unreadKey]);
  if (dossier === null) {
    return result._tag === "Failure" ? (
      <EditorialEmptyPage
        space={SPACE_LABEL}
        title="No se encontró la ficha de tendencia"
        description="Puede que la corrida ya no esté en el directorio de corridas."
      />
    ) : (
      <EditorialPage space={SPACE_LABEL}>{null}</EditorialPage>
    );
  }
  return (
    <EditorialPage
      space={SPACE_LABEL}
      title={dossier.trend.presentation?.title ?? dossier.trend.label}
    >
      <TrendDossierView
        environmentId={environmentId}
        dossier={dossier}
        allEvidence={allEvidence}
        onShowAllEvidence={() => setAllEvidenceAsked(true)}
        onEvidencePage={setEvidenceOffset}
        presentationActions={presentationActions}
        {...(citationEvidence === undefined ? {} : { citationEvidence })}
      />
    </EditorialPage>
  );
}

/** Server reasons in the operator's words; anything else keeps the provider's message. */
function presentationErrorText(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "reason" in error) {
    switch (error.reason) {
      case "unavailable":
        return "este servidor no tiene activada la redacción.";
      case "run-not-found":
      case "dossier-not-found":
        return "la ficha de tendencia ya no está en el directorio de corridas.";
      case "storage-failed":
        return "no se pudo guardar en la base editorial.";
      case "provider-disabled":
        return "el proveedor del modelo de redacción está desactivado. Actívalo en Ajustes › Proveedores o elige otro modelo en Ajustes › Editorial › Redacción.";
      case "budget-reached":
        return "se alcanzó el tope mensual de redacciones. Súbelo en Ajustes › Editorial o espera al mes siguiente.";
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function usePresentationActions(
  environmentId: EnvironmentId,
  target: { readonly runId: EditorialRunId; readonly dossierId: EditorialDossierId },
): TrendPresentationActions {
  const [busy, setBusy] = useState<TrendPresentationActions["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  // The error shows in place, next to the button; no toast on top of it.
  const ensure = useAtomCommand(presentationEnvironment.ensure, { reportFailure: false });
  const regenerate = useAtomCommand(presentationEnvironment.regenerate, { reportFailure: false });
  const run = (kind: "draft" | "regenerate") => {
    setBusy(kind);
    setError(null);
    const command = kind === "draft" ? ensure : regenerate;
    void command({ environmentId, input: target }).then((result) => {
      setBusy(null);
      if (result._tag === "Failure") setError(presentationErrorText(result.cause));
    });
  };
  return {
    busy,
    error,
    onDraft: () => run("draft"),
    onRegenerate: () => run("regenerate"),
  };
}
