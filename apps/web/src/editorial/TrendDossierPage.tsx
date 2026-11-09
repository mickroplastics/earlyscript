import { useAtomValue } from "@effect/atom-react";
import type {
  EditorialDossierId,
  EditorialEvidenceItem,
  EditorialRunId,
  EditorialTrendDossier,
  EditorialTrendKey,
  EditorialTrendPresentation,
  EnvironmentId,
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
import { useEffect, useEffectEvent, useState, type MouseEvent } from "react";

import { useOpenLink } from "../browser/useOpenLink";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useSidebar, useSidebarVisibility } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import {
  citationSegments,
  evidenceHeading,
  evidenceLinks,
  formatDate,
  sourceLabel,
} from "./editorial.logic";
import { EditorialEmptyPage, EditorialPage } from "./EditorialPage";
import {
  CITATION_EVIDENCE_LIMIT,
  DOSSIER_EVIDENCE_PAGE_SIZE as EVIDENCE_PAGE_SIZE,
  presentationEnvironment,
} from "./presentationState";
import { usePairsMode } from "./pairsMode";
import { editorialEnvironment } from "./state";
import { useTrendActions } from "./trendActions";
import { TrendCardView } from "./TrendCard";
import { TrendCardList } from "./TrendCardList";
import { TrendDecision } from "./TrendDecision";
import { useTrendInbox } from "./TrendInbox";
import { useEditorialJobActivity } from "./TrendJobIndicator";

const SPACE_LABEL = "Tendencias";

function EvidenceList({
  dossier,
  onPage,
}: {
  readonly dossier: EditorialTrendDossier;
  readonly onPage: (offset: number) => void;
}) {
  const openLink = useOpenLink(null);
  const open = (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault();
    openLink(url, { event }).catch((error: unknown) => {
      console.error("Could not open the evidence link.", error);
    });
  };
  const from = dossier.evidenceOffset + 1;
  const to = dossier.evidenceOffset + dossier.evidence.length;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {dossier.evidence.map((item, index) => {
          const links = evidenceLinks(item);
          const url = links.title;
          return (
            <li
              key={item.itemId}
              id={evidenceAnchorId(item.itemId)}
              data-evidence-number={dossier.evidenceOffset + index + 1}
              className="flex min-w-0 flex-col gap-0.5"
            >
              {url ? (
                <a
                  href={url}
                  onClick={(event) => open(event, url)}
                  className="group/evidence inline-flex min-w-0 items-baseline gap-1 rounded-sm text-sm font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="min-w-0">{item.title}</span>
                  <ExternalLinkIcon
                    aria-hidden
                    className="size-3 shrink-0 translate-y-0.5 text-muted-foreground"
                  />
                </a>
              ) : (
                <span className="text-sm font-medium text-foreground">{item.title}</span>
              )}
              {item.excerpt ? (
                <p className="line-clamp-3 text-xs text-foreground/80">{item.excerpt}</p>
              ) : null}
              <span className="text-xs text-muted-foreground">
                <span className="tabular-nums">{dossier.evidenceOffset + index + 1}</span>
                {" · "}
                {sourceLabel(item.source)} · {formatDate(item.publishedAt)}
                {item.author ? ` · ${item.author}` : null}
                {links.discussion ? (
                  <>
                    {" · "}
                    <a
                      href={links.discussion}
                      onClick={(event) => open(event, links.discussion ?? "")}
                      className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      discusión
                    </a>
                  </>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {dossier.evidenceTotal > EVIDENCE_PAGE_SIZE ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {from}–{to} de {dossier.evidenceTotal}
          </span>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={dossier.evidenceOffset === 0}
            onClick={() => onPage(Math.max(0, dossier.evidenceOffset - EVIDENCE_PAGE_SIZE))}
          >
            Anteriores
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={to >= dossier.evidenceTotal}
            onClick={() => onPage(dossier.evidenceOffset + EVIDENCE_PAGE_SIZE)}
          >
            Siguientes
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const evidenceAnchorId = (itemId: string) => `evidence-${itemId}`;

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
        {sourceLabel(item.source)} · {item.title}
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

const SUMMARY_PARTS = [
  { key: "whatHappened", label: "Qué pasó" },
  { key: "whyItMatters", label: "Por qué importa al canal" },
  { key: "videoAngle", label: "Ángulo de video" },
] as const;

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

function TrendPresentationSummary({
  presentation,
  evidence,
  actions,
}: {
  readonly presentation: EditorialTrendPresentation;
  readonly evidence: ReadonlyArray<EditorialEvidenceItem>;
  readonly actions: TrendPresentationActions | undefined;
}) {
  return (
    <section aria-label="Resumen del asistente" className="flex flex-col gap-3">
      {presentation.status === "stale" ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Redacción desactualizada</AlertTitle>
          <AlertDescription>
            Se escribió con una evidencia, un perfil del canal o una versión del prompt anteriores.
            Regenera para leer una redacción sobre la ficha actual.
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="flex flex-col gap-2.5 text-sm text-foreground">
        {SUMMARY_PARTS.map((part) => (
          <div key={part.key} className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{part.label}</dt>
            <dd className="leading-relaxed">
              <CitedText text={presentation.summary[part.key]} evidence={evidence} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{formatDate(presentation.generatedAt)} · no cambia el orden ni el puntaje</span>
        {actions ? (
          <Button
            size="xs"
            variant={presentation.status === "stale" ? "outline" : "ghost-muted"}
            disabled={actions.busy !== null}
            onClick={actions.onRegenerate}
          >
            {actions.busy === "regenerate" ? <Spinner /> : <RefreshCwIcon aria-hidden />}
            {actions.busy === "regenerate" ? "Regenerando…" : "Regenerar"}
          </Button>
        ) : null}
      </div>
      {actions?.error ? <PresentationError message={actions.error} /> : null}
    </section>
  );
}

function DraftPresentationPrompt({ actions }: { readonly actions: TrendPresentationActions }) {
  return (
    <section
      aria-label="Resumen del asistente"
      className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          El asistente puede escribir un título y un resumen de tres partes que citan la evidencia.
          Usa el modelo de generación de texto de Ajustes.
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
    </section>
  );
}

export function TrendDossierView({
  environmentId,
  dossier,
  evidence,
  onEvidencePage,
  citationEvidence,
  presentationActions,
}: {
  readonly environmentId: EnvironmentId;
  readonly dossier: EditorialTrendDossier;
  /** The evidence page shown; the dossier's own first page until another one loads. */
  readonly evidence: EditorialTrendDossier;
  readonly onEvidencePage: (offset: number) => void;
  /** Evidence the assistant could cite, in dossier order; the first page until it loads. */
  readonly citationEvidence?: ReadonlyArray<EditorialEvidenceItem>;
  readonly presentationActions?: TrendPresentationActions;
}) {
  const { trend } = dossier;
  const presentation = trend.presentation;
  // In pairs mode nothing tells which model drafted the title or which engine made the card.
  const pairsMode = usePairsMode();
  return (
    <>
      <header className="flex min-w-0 flex-col gap-2">
        {presentation && !pairsMode ? (
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <SparklesIcon aria-hidden className="size-3.5" />
            Redactado por el asistente
            {presentation.status === "stale" ? (
              <Badge variant="warning" size="sm">
                Desactualizado
              </Badge>
            ) : null}
          </p>
        ) : null}
        <h1 className="text-xl font-semibold text-foreground">
          {presentation?.title ?? trend.label}
        </h1>
        {presentation && !pairsMode ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Detalles técnicos</summary>
            <p className="mt-2">Términos del motor: {trend.label}</p>
            <p>Modelo: {presentation.model}</p>
          </details>
        ) : null}
      </header>

      {trend.card === undefined ? null : (
        <TrendCardView
          environmentId={environmentId}
          trend={trend}
          cutoffAt={dossier.run.cutoffAt}
          defaultOpen
          linkTitle={false}
        />
      )}

      {presentation ? (
        <TrendPresentationSummary
          presentation={presentation}
          evidence={citationEvidence ?? dossier.evidence}
          actions={presentationActions}
        />
      ) : presentationActions ? (
        <DraftPresentationPrompt actions={presentationActions} />
      ) : null}

      <details className="group/evidence-all">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          {evidenceHeading(dossier.evidenceTotal, dossier.evidenceRange)}
        </summary>
        <div className="mt-3">
          <EvidenceList dossier={evidence} onPage={onEvidencePage} />
        </div>
      </details>

      {trend.card === undefined ? (
        <TrendDecision environmentId={environmentId} trend={trend} />
      ) : null}
    </>
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
  const [evidenceOffset, setEvidenceOffset] = useState(0);
  const firstPage = { runId, dossierId, evidenceLimit: EVIDENCE_PAGE_SIZE };
  const result = useAtomValue(editorialEnvironment.dossier({ environmentId, input: firstPage }));
  // The first page is the dossier query itself; later pages only fetch their evidence.
  const pageResult = useAtomValue(
    editorialEnvironment.dossier({
      environmentId,
      input: evidenceOffset === 0 ? firstPage : { ...firstPage, evidenceOffset },
    }),
  );
  const dossier = AsyncResult.getOrElse(result, () => null);
  const page = AsyncResult.getOrElse(pageResult, () => null);
  // Citations can point past the first evidence page; the assistant read at most twelve.
  const citationResult = useAtomValue(
    editorialEnvironment.dossier({
      environmentId,
      input: { runId, dossierId, evidenceLimit: CITATION_EVIDENCE_LIMIT },
    }),
  );
  const citationEvidence = AsyncResult.getOrElse(citationResult, () => null)?.evidence;
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
        evidence={page ?? dossier}
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
