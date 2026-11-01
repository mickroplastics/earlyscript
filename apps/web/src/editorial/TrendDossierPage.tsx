import { useAtomValue } from "@effect/atom-react";
import type {
  EditorialCurveDay,
  EditorialDossierId,
  EditorialEvidenceItem,
  EditorialRunId,
  EditorialSourceCoverage,
  EditorialTrendDossier,
  EditorialTrendInboxState,
  EditorialTrendKey,
  EditorialTrendPresentation,
  EditorialTrendSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState, type MouseEvent, type ReactNode } from "react";

import { useOpenLink } from "../browser/useOpenLink";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Group, GroupSeparator } from "../components/ui/group";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../components/ui/menu";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useClientSettings } from "../hooks/useSettings";
import { cn } from "../lib/utils";
import { useAtomCommand } from "../state/use-atom-command";
import {
  citationSegments,
  coverageStatus,
  coverageText,
  evidenceHeading,
  evidenceLinks,
  formatDate,
  formatDay,
  formatDecimal,
  growthText,
  snoozePresetLabel,
  snoozeStateText,
  sourceLabel,
  trendSourceText,
  whyHereReasons,
} from "./editorial.logic";
import { EditorialEmptyPage, EditorialPage } from "./EditorialPage";
import {
  CITATION_EVIDENCE_LIMIT,
  DOSSIER_EVIDENCE_PAGE_SIZE as EVIDENCE_PAGE_SIZE,
  presentationEnvironment,
} from "./presentationState";
import { editorialEnvironment } from "./state";
import { useTrendActions, type TrendActions } from "./trendActions";
import { TrendDismissDialog } from "./TrendDismissDialog";
import { useTrendInbox } from "./TrendInbox";

const SPACE_LABEL = "Tendencias";

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
        <span>
          {presentation.model} · {formatDate(presentation.generatedAt)} · no cambia el orden ni el
          puntaje
        </span>
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

/** "Seguir observando": growth by default, or one of the thread snooze times. */
function KeepWatchingControl({
  environmentId,
  trendKey,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly trendKey: EditorialTrendKey;
  readonly actions: TrendActions;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [open, setOpen] = useState(false);
  const presets = open
    ? // oxlint-disable-next-line react/purity -- Presets are resolved only while the menu is open, so each opening reads a fresh time.
      resolveSnoozePresets(new Date(), timestampFormat, environmentId)
    : [];
  return (
    <Group aria-label="Seguir observando">
      <Button size="sm" variant="outline" onClick={() => void actions.keepWatching(trendKey)}>
        Seguir observando
      </Button>
      <GroupSeparator />
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={<Button size="icon-sm" variant="outline" aria-label="Observar hasta…" />}
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          <MenuItem onClick={() => void actions.keepWatching(trendKey)}>Hasta que crezca</MenuItem>
          <MenuSeparator />
          {presets.map((preset) => (
            <MenuItem
              key={preset.id}
              onClick={() => {
                const picked = pickSnoozePreset(presets, preset.id, timestampFormat, environmentId);
                if (picked) void actions.keepWatching(trendKey, picked);
              }}
            >
              {snoozePresetLabel(preset.label)}
              <MenuShortcut>{preset.whenLabel}</MenuShortcut>
            </MenuItem>
          ))}
          <MenuItem
            onClick={async () => {
              const choice = await requestCustomSnooze();
              if (choice) void actions.keepWatching(trendKey, choice);
            }}
          >
            Personalizado…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
}

function trendStateText(state: EditorialTrendInboxState | undefined): string | null {
  if (state?.dismissed) return `Descartada: ${state.dismissed.reason}`;
  if (state?.snoozed) return snoozeStateText(state.snoozed);
  if (state?.production) return "En producción.";
  return null;
}

/** The three exits of the dossier, each replaced by its way back once taken. */
function TrendDecision({
  environmentId,
  trend,
}: {
  readonly environmentId: EnvironmentId;
  readonly trend: EditorialTrendSummary;
}) {
  const actions = useTrendActions(environmentId);
  const [dismissing, setDismissing] = useState(false);
  const [creating, setCreating] = useState(false);
  const { trendKey, inbox: state } = trend;
  const title = trend.presentation?.title ?? trend.label;
  const status = trendStateText(state);
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
      <div role="group" aria-label="Decisión" className="flex flex-wrap gap-2">
        {trendKey === undefined ? (
          <p className="text-sm text-muted-foreground">
            Este servidor no identifica la tendencia entre corridas; actualízalo para decidir.
          </p>
        ) : (
          <>
            {state?.production ? (
              <Button
                size="sm"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={{
                      environmentId,
                      threadId: ThreadId.make(state.production.threadId),
                    }}
                  />
                }
              >
                Abrir hilo de video
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={creating}
                onClick={async () => {
                  setCreating(true);
                  // The button comes back even if the action throws.
                  await actions
                    .createVideo({ ...trend, trendKey })
                    .finally(() => setCreating(false));
                }}
              >
                Crear hilo de video
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={creating}
              title="Mismo tema, sin asistente ni expediente: para comparar por pares"
              onClick={async () => {
                setCreating(true);
                // The button comes back even if the action throws.
                await actions
                  .createVideo({ ...trend, trendKey }, "manual")
                  .finally(() => setCreating(false));
              }}
            >
              Crear hilo manual
            </Button>
            {state?.snoozed ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void actions.returnToInbox(trendKey)}
              >
                Volver a la bandeja
              </Button>
            ) : state?.dismissed ? null : (
              <KeepWatchingControl
                environmentId={environmentId}
                trendKey={trendKey}
                actions={actions}
              />
            )}
            {state?.dismissed ? (
              <Button size="sm" variant="outline" onClick={() => void actions.reopen(trendKey)}>
                Reabrir
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setDismissing(true)}>
                Descartar…
              </Button>
            )}
          </>
        )}
      </div>
      {dismissing && trendKey !== undefined ? (
        <TrendDismissDialog
          trendTitle={title}
          onConfirm={(reason) => actions.dismiss(trendKey, reason)}
          onClose={() => setDismissing(false)}
        />
      ) : null}
    </div>
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
  const reasons = whyHereReasons({
    trend,
    affinityThreshold: dossier.affinityThreshold,
    coverage: dossier.coverage,
  });
  return (
    <>
      <header className="flex min-w-0 flex-col gap-2">
        {presentation ? (
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
        {presentation ? (
          <p className="text-xs text-muted-foreground">Términos del motor: {trend.label}</p>
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
        <TrendPresentationSummary
          presentation={presentation}
          evidence={citationEvidence ?? dossier.evidence}
          actions={presentationActions}
        />
      ) : presentationActions ? (
        <DraftPresentationPrompt actions={presentationActions} />
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
        <DossierSection title={evidenceHeading(dossier.evidenceTotal, dossier.evidenceRange)}>
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

      <TrendDecision environmentId={environmentId} trend={trend} />
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
