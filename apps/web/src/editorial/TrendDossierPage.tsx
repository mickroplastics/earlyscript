import { useAtomValue } from "@effect/atom-react";
import type {
  EditorialCurveDay,
  EditorialDossierId,
  EditorialEvidenceItem,
  EditorialRunId,
  EditorialSourceCoverage,
  EditorialTrendDossier,
  EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { CircleCheckIcon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { useOpenLink } from "../browser/useOpenLink";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import {
  coverageStatus,
  coverageText,
  formatDate,
  formatDay,
  formatDecimal,
  growthText,
  sourceLabel,
  trendSourceText,
  whyHereReasons,
} from "./editorial.logic";
import { EditorialEmptyPage, EditorialPage } from "./EditorialPage";
import { editorialEnvironment } from "./state";
import { useTrendInbox } from "./TrendInbox";

const SPACE_LABEL = "Tendencias";
const EVIDENCE_PAGE_SIZE = 6;
const NEXT_UNIT_TOOLTIP = "Disponible en la siguiente unidad.";

function DossierSection({
  title,
  children,
  className,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-2", className)}>
      <h2 className="text-sm font-medium text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function DossierMetric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium text-foreground tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

function curveDayLabel(day: EditorialCurveDay): string {
  const date = formatDay(`${day.day}T00:00:00.000Z`);
  if (!day.known) return `${date}: sin captura`;
  return `${date}: ${day.items} ${day.items === 1 ? "publicación" : "publicaciones"}, ${day.authors} ${day.authors === 1 ? "autor" : "autores"}`;
}

/** Items per day. A day without capture is outlined, never drawn as a zero. */
function TrendCurve({ curve }: { readonly curve: ReadonlyArray<EditorialCurveDay> }) {
  const max = Math.max(1, ...curve.map((day) => (day.known ? day.items : 0)));
  const first = curve[0];
  const last = curve.at(-1);
  const unknownDays = curve.filter((day) => !day.known).length;
  const total = curve.reduce((sum, day) => sum + (day.known ? day.items : 0), 0);
  return (
    <figure className="flex flex-col gap-1.5">
      <div
        role="img"
        aria-label={`${total} publicaciones en ${curve.length} días${unknownDays > 0 ? `, ${unknownDays} días sin captura` : ""}.`}
        className="flex h-24 items-end gap-0.75 border-b border-border"
      >
        {curve.map((day) => (
          <Tooltip key={day.day}>
            <TooltipTrigger
              render={
                day.known ? (
                  <div
                    data-curve-day={day.day}
                    className={cn(
                      "min-w-0 flex-1 rounded-t-xs",
                      day.items === 0 ? "h-px bg-border" : "bg-primary/80",
                    )}
                    style={day.items === 0 ? undefined : { height: `${(day.items / max) * 100}%` }}
                  />
                ) : (
                  <div
                    data-curve-day={day.day}
                    data-unknown=""
                    className="h-full min-w-0 flex-1 rounded-t-xs border border-b-0 border-dashed border-muted-foreground/40"
                  />
                )
              }
            />
            <TooltipPopup side="top">{curveDayLabel(day)}</TooltipPopup>
          </Tooltip>
        ))}
      </div>
      <figcaption className="flex justify-between gap-2 text-2xs text-muted-foreground tabular-nums">
        <span>{first ? formatDay(`${first.day}T00:00:00.000Z`) : null}</span>
        {unknownDays > 0 ? <span>Contorno discontinuo: día sin captura</span> : null}
        <span>{last ? formatDay(`${last.day}T00:00:00.000Z`) : null}</span>
      </figcaption>
    </figure>
  );
}

function CoverageList({ coverage }: { readonly coverage: ReadonlyArray<EditorialSourceCoverage> }) {
  const incomplete = coverage.filter((entry) => coverageStatus(entry) !== "complete");
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {coverage.map((entry) => (
          <li
            key={entry.source}
            className="flex items-center gap-1.5 text-sm text-muted-foreground"
          >
            {coverageStatus(entry) === "complete" ? (
              <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
            ) : (
              <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            )}
            <span>{coverageText(entry)}</span>
          </li>
        ))}
      </ul>
      {incomplete.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>
            Cobertura parcial en {incomplete.map((entry) => sourceLabel(entry.source)).join(", ")}
          </AlertTitle>
          <AlertDescription>
            Hubo días capturados solo en parte o sin captura: los conteos de esa fuente son un piso,
            no el total.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

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
  const link = (item: EditorialEvidenceItem) => item.externalUrl ?? item.permalink;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {dossier.evidence.map((item) => {
          const url = link(item);
          return (
            <li key={item.itemId} className="flex min-w-0 flex-col gap-0.5">
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
              <span className="text-xs text-muted-foreground">
                {sourceLabel(item.source)} · {formatDate(item.publishedAt)}
                {item.author ? ` · ${item.author}` : null}
                {item.permalink && item.externalUrl && item.permalink !== item.externalUrl ? (
                  <>
                    {" · "}
                    <a
                      href={item.permalink}
                      onClick={(event) => open(event, item.permalink ?? "")}
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

function PendingAction({
  label,
  variant,
}: {
  readonly label: string;
  readonly variant: "default" | "outline";
}) {
  return (
    <Tooltip>
      {/* A disabled button gets no pointer events; the wrapper keeps the reason reachable. */}
      <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
        <Button size="sm" variant={variant} disabled>
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="top">{NEXT_UNIT_TOOLTIP}</TooltipPopup>
    </Tooltip>
  );
}

export function TrendDossierView({
  dossier,
  evidence,
  onEvidencePage,
}: {
  readonly dossier: EditorialTrendDossier;
  /** The evidence page shown; the dossier's own first page until another one loads. */
  readonly evidence: EditorialTrendDossier;
  readonly onEvidencePage: (offset: number) => void;
}) {
  const { trend } = dossier;
  const presentation = trend.presentation;
  const reasons = whyHereReasons({
    trend,
    affinityThreshold: dossier.affinityThreshold,
    coverage: dossier.coverage,
  });
  return (
    <>
      <header className="flex min-w-0 flex-col gap-2">
        <h1 className="text-xl font-semibold text-foreground">
          {presentation?.title ?? trend.label}
        </h1>
        {presentation ? (
          <p className="text-xs text-muted-foreground">
            Redactado por el asistente · términos del motor: {trend.label}
          </p>
        ) : trend.subtitle ? (
          <p className="text-sm text-muted-foreground">{trend.subtitle}</p>
        ) : null}
        <ul aria-label="Términos" className="flex flex-wrap gap-1">
          {trend.terms.map((term) => (
            <li key={term}>
              <Badge variant="secondary">{term}</Badge>
            </li>
          ))}
        </ul>
      </header>

      {presentation ? (
        <section className="flex flex-col gap-1.5 text-sm text-foreground">
          <p>{presentation.summary.whatHappened}</p>
          <p>{presentation.summary.whyItMatters}</p>
          <p>{presentation.summary.videoAngle}</p>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-4">
        <DossierMetric
          label="Por volumen"
          value={`#${trend.volumeRank}`}
          detail={`${trend.items7d} publicaciones en 7 días · ${trend.items28d} en 28`}
        />
        <DossierMetric
          label="Por puntaje"
          value={`#${trend.scoreRank}`}
          detail={`${formatDecimal(trend.score)} · ${growthText(trend.growth)}`}
        />
        <DossierMetric
          label="Afinidad con el canal"
          value={trend.affinity === null ? "sin dato" : formatDecimal(trend.affinity)}
          detail={`umbral ${formatDecimal(dossier.affinityThreshold)}`}
        />
        <DossierMetric
          label="Fuentes"
          value={String(trend.sourceCount)}
          detail={trendSourceText(trend)}
        />
      </section>

      <DossierSection title="Cobertura por fuente">
        <CoverageList coverage={dossier.coverage} />
      </DossierSection>

      <DossierSection title={`Publicaciones por día, últimos ${dossier.curve.length}`}>
        <TrendCurve curve={dossier.curve} />
      </DossierSection>

      <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <DossierSection title={`Evidencia (${dossier.evidenceTotal} de ${trend.items28d})`}>
          <EvidenceList dossier={evidence} onPage={onEvidencePage} />
        </DossierSection>
        <DossierSection title="Por qué está aquí">
          <ul className="flex list-disc flex-col gap-1.5 ps-4 text-sm text-muted-foreground marker:text-muted-foreground/60">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </DossierSection>
      </div>

      <div
        role="group"
        aria-label="Decisión"
        className="flex flex-wrap gap-2 border-t border-border pt-4"
      >
        <PendingAction label="Crear hilo de video" variant="default" />
        <PendingAction label="Seguir observando" variant="outline" />
        <PendingAction label="Descartar…" variant="outline" />
      </div>
    </>
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
      <EditorialEmptyPage
        space={SPACE_LABEL}
        title="Sin corridas"
        description="Todavía no hay corridas del motor en este entorno."
      />
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
  if (dossier === null) {
    return result._tag === "Failure" ? (
      <EditorialEmptyPage
        space={SPACE_LABEL}
        title="No se encontró el expediente"
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
        dossier={dossier}
        evidence={page ?? dossier}
        onEvidencePage={setEvidenceOffset}
      />
    </EditorialPage>
  );
}
