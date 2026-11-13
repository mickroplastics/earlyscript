import type { SourceId } from "@earlyscript/editorial-contracts/source";
import { SOURCE_CATALOG } from "@earlyscript/editorial-contracts/sourceCatalog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  PRESENTATION_EVIDENCE_LIMIT,
  PRESENTATION_EXCERPT_CHARS,
  type EditorialSourcesView,
} from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment, useId, useState, type ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Spinner } from "../../components/ui/spinner";
import { Switch } from "../../components/ui/switch";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { editorialSourcesEnvironment } from "../settings/sourcesState";
import { failureText } from "../settings/sourcesText";
import { namesList, SOURCE_DIGEST } from "./consentSummary";
import {
  buildAcceptance,
  COMMON_STORED_LINE,
  consentSourceRows,
  corpusText,
  DATA_CONSENT_POLICY,
  deletionCommand,
  pendingWrites,
  selectedSources,
  shownCollect,
  type CaptureDraft,
  type ConsentSourceRow,
  type DataConsentAcceptance,
} from "./dataConsent.logic";
import {
  HIGHLIGHTED_OUTBOUND,
  OTHER_OUTBOUND,
  OTHER_OUTBOUND_PREFIX,
  otherOutboundItem,
} from "./dataOutbound";
import type { OnboardingStepProps } from "./steps";
import { SectionLabel, StepLayout } from "./wizardLayout";

// What the operator accepts is DATA_CONSENT_POLICY and the texts `policyHash` covers. The step
// shows a three-line summary and folds that wording into each source row and into «Ver cada
// conexión, conservación y borrado»; opening them is never taken as accepting.

const formatCount = (count: number) => count.toLocaleString("es");

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </a>
  );
}

const digestOf = (row: ConsentSourceRow) =>
  SOURCE_DIGEST[row.id] ?? { name: row.name, stored: row.storedText };

function SourceRow({
  row,
  checked,
  disabled,
  feedCount,
  onChange,
}: {
  readonly row: ConsentSourceRow;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly feedCount: number | null;
  readonly onChange: (checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const digest = digestOf(row);
  return (
    <li data-testid={`consent-source-${row.id}`} className="min-w-0">
      <div className="flex min-h-11 items-center gap-3 px-3.5">
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onChange(Boolean(value))}
          aria-label={`Leer ${digest.name}`}
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="w-28 shrink-0 truncate text-sm text-foreground">{digest.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {digest.stored}
          </span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        </button>
      </div>
      {open ? (
        <dl
          id={detailId}
          className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3.5 pb-3 pl-17 text-xs leading-relaxed"
        >
          <dt className="text-muted-foreground">Términos</dt>
          <dd className="text-foreground">
            {row.licenseUrl ? (
              <ExternalLink href={row.licenseUrl}>{row.licenseText}</ExternalLink>
            ) : (
              row.licenseText
            )}{" "}
            · {row.termsLine.replace(/^Términos leídos/u, "leídos")}
            {row.termsUrl ? (
              <>
                {" · "}
                <ExternalLink href={row.termsUrl}>abrir</ExternalLink>
              </>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Se guarda</dt>
          <dd className="text-foreground">
            {row.storedText} {row.retentionText}
          </dd>
          {feedCount !== null ? (
            <>
              <dt className="text-muted-foreground">Feeds</dt>
              <dd className="text-foreground">
                {feedCount} {feedCount === 1 ? "feed curado" : "feeds curados"}; los tuyos se
                agregan después en Ajustes.
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </li>
  );
}

function SourcesList({
  view,
  draft,
  disabled,
  onChange,
}: {
  readonly view: EditorialSourcesView;
  readonly draft: CaptureDraft;
  readonly disabled: boolean;
  readonly onChange: (source: SourceId, collect: boolean) => void;
}) {
  const rows = consentSourceRows(view.sources);
  const ready = rows.filter((row) => row.capturable);
  const locked = rows.filter((row) => !row.capturable);
  const feeds = view.rssFeeds.filter((feed) => feed.origin === "default" && !feed.excluded).length;
  return (
    <>
      <ul
        aria-label="Fuentes que se leerán"
        className="divide-y overflow-hidden rounded-lg border bg-background"
      >
        {ready.map((row) => (
          <SourceRow
            key={row.id}
            row={row}
            checked={shownCollect(row, draft)}
            disabled={disabled}
            feedCount={row.id === "rss" && feeds > 0 ? feeds : null}
            onChange={(collect) => onChange(row.id, collect)}
          />
        ))}
      </ul>
      {locked.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="consent-locked">
          Sin permiso confirmado, no se leen: {namesList(locked.map((row) => digestOf(row).name))}.
        </p>
      ) : null}
    </>
  );
}

/** One of the three lines of «Qué sale de tu equipo». */
function OutboundLine({
  tone,
  title,
  children,
}: {
  readonly tone: "muted" | "accent" | "success";
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2.5 border-t border-dashed py-3.5 first:border-t-0">
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-1.5 rounded-full",
          tone === "muted" && "bg-muted-foreground",
          tone === "accent" && "bg-primary",
          tone === "success" && "bg-success",
        )}
      />
      <div className="min-w-0">
        <p className="text-sm text-foreground">{title}</p>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </li>
  );
}

function OutboundSummary({ onDetail }: { readonly onDetail: () => void }) {
  return (
    <div data-testid="consent-summary">
      <SectionLabel tone="accent">Qué sale de tu equipo</SectionLabel>
      <ul className="mt-2 border-t border-dashed">
        <OutboundLine tone="muted" title="A cada fuente activada">
          Solo peticiones de lectura, con pausas y respetando sus límites.
        </OutboundLine>
        <OutboundLine tone="accent" title="A tu asistente de IA, con tu cuenta">
          <p>Cuando redacta los títulos de cada noche, por ejemplo:</p>
          <dl className="my-2.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 rounded-lg border bg-background px-3 py-2.5">
            <dt>Tu perfil del canal</dt>
            <dd className="text-end">nombre, audiencia, temas</dd>
            <dt>Cifras de la tendencia</dt>
            <dd className="text-end">publicaciones por semana</dd>
            <dt>Hasta {formatCount(PRESENTATION_EVIDENCE_LIMIT)} publicaciones</dt>
            <dd className="text-end">
              {formatCount(PRESENTATION_EXCERPT_CHARS)} caracteres cada una
            </dd>
          </dl>
          <p>Y en un guion, lo que le escribas y lo que lea por ti.</p>
        </OutboundLine>
        <OutboundLine tone="success" title="Lo demás, sin tus textos">
          Descarga del modelo y consultas de versiones y precios. Sin telemetría.
        </OutboundLine>
      </ul>
      <button
        type="button"
        onClick={onDetail}
        className="mt-1 rounded-sm text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        Ver cada conexión, conservación y borrado
      </button>
    </div>
  );
}

/** A shell command that wraps between words only; a long path may still break inside. */
function CommandText({ text }: { readonly text: string }) {
  const words = text.split(" ");
  return (
    <pre className="rounded-md bg-muted px-2.5 py-2 font-mono text-2xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
      {words.map((word, index) => (
        // oxlint-disable-next-line no-array-index-key -- a fixed command; words repeat ("|").
        <Fragment key={index}>
          {index > 0 ? " " : null}
          <span className={word.length > 24 ? "break-all" : "whitespace-nowrap"}>{word}</span>
        </Fragment>
      ))}
    </pre>
  );
}

/**
 * The full wording the operator accepts, as `policyHash` covers it: every connection, how long
 * the data stays, how it is deleted, and the sources that may not be read.
 */
function OutboundDetail({
  view,
  onBack,
}: {
  readonly view: EditorialSourcesView | null;
  readonly onBack: () => void;
}) {
  const policy = DATA_CONSENT_POLICY;
  const locked =
    view === null ? [] : consentSourceRows(view.sources).filter((row) => !row.capturable);
  return (
    <div data-testid="consent-detail" className="flex flex-col gap-5 text-xs leading-relaxed">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ArrowLeftIcon aria-hidden className="size-3.5" />
        Qué sale de tu equipo
      </button>
      <p className="text-muted-foreground">{policy.intro}</p>
      <section className="flex flex-col gap-2">
        <SectionLabel tone="accent">Todas las conexiones</SectionLabel>
        <p className="text-muted-foreground">{policy.outbound[0]}</p>
        <ul className="flex flex-col divide-y divide-dashed">
          {HIGHLIGHTED_OUTBOUND.map((entry) => (
            <li key={entry.id} data-outbound-id={entry.id} className="py-2 text-muted-foreground">
              <span className="text-foreground">{entry.where}</span> · {entry.detail}
            </li>
          ))}
        </ul>
        {/* Same text as otherOutboundLine(), which policyHash covers; one row per entry. */}
        <div data-testid="consent-other-outbound" className="text-muted-foreground">
          <p>{OTHER_OUTBOUND_PREFIX.trim()}</p>
          <ul className="mt-1 flex flex-col divide-y divide-dashed">
            {OTHER_OUTBOUND.map((entry, index) => (
              <li key={entry.id} data-outbound-id={entry.id} className="py-1.5">
                {otherOutboundItem(entry)}
                {index === OTHER_OUTBOUND.length - 1 ? "." : ";"}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-muted-foreground">{policy.outbound[1]}</p>
        <p className="text-muted-foreground">{policy.outbound[2]}</p>
      </section>
      <section className="flex flex-col gap-2 text-muted-foreground">
        <SectionLabel tone="accent">Conservación y borrado</SectionLabel>
        {view !== null ? <p data-testid="consent-corpus">{corpusText(view.corpus)}</p> : null}
        {policy.retention.map((text) => (
          <p key={text}>{text}</p>
        ))}
        <p data-testid="consent-common-stored">{COMMON_STORED_LINE}</p>
        <p>{policy.deletion[0]}</p>
        <details className="group/command">
          <summary className="w-fit cursor-pointer text-foreground">
            Orden para borrar desde la terminal
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            <CommandText
              text={view !== null ? deletionCommand(view.corpus.directory) : policy.deletionCommand}
            />
            <p>{policy.deletion[1]}</p>
          </div>
        </details>
      </section>
      {locked.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionLabel tone="accent">Sin permiso confirmado</SectionLabel>
          <ul className="flex flex-col gap-1.5">
            {locked.map((row) => (
              <li key={row.id} data-testid={`consent-locked-${row.id}`}>
                <span className="text-foreground">{digestOf(row).name}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {row.termsLine}
                  {row.termsUrl ? (
                    <>
                      {" · "}
                      <ExternalLink href={row.termsUrl}>ver términos</ExternalLink>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

const UNEXPECTED_SAVE_ERROR = "No se pudo guardar la elección de fuentes. Vuelve a intentarlo.";

export type SaveSwitches = (
  writes: ReadonlyArray<{ readonly source: SourceId; readonly collect: boolean }>,
) => Promise<string | null>;

export interface DataConsentViewProps {
  /** Null while the list loads or after it failed. */
  readonly view: EditorialSourcesView | null;
  /** Spanish sentence of a failed list; null otherwise. */
  readonly loadError: string | null;
  readonly onRetry: () => void;
  /** Writes the switches; resolves to null when all were saved, else a Spanish sentence. */
  readonly save: SaveSwitches;
  readonly onBack: (() => void) | null;
  readonly onContinue: (acceptance: DataConsentAcceptance) => void;
}

/** The step without its RPC wiring: what the browser test renders. */
export function DataConsentView({
  view,
  loadError,
  onRetry,
  save,
  onBack,
  onContinue,
}: DataConsentViewProps) {
  const [draft, setDraft] = useState<CaptureDraft>({});
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const errorId = useId();
  const hintId = useId();
  const canContinue = view !== null && accepted && !saving;

  // A promise chain, not try/finally: React Compiler does not compile try without catch.
  const submit = () => {
    if (view === null || !canContinue) return;
    const rows = consentSourceRows(view.sources);
    setSaving(true);
    setSaveError(null);
    void save(pendingWrites(rows, draft))
      .then((error) => {
        if (error !== null) {
          setSaveError(error);
          return;
        }
        return buildAcceptance(selectedSources(rows, draft)).then(onContinue);
      })
      .catch((cause: unknown) => {
        console.error("Tus datos: no se pudo continuar", cause);
        setSaveError(UNEXPECTED_SAVE_ERROR);
      })
      .finally(() => setSaving(false));
  };

  return (
    <StepLayout
      testId="data-consent-step"
      title="Tus datos"
      description="Antes de leer nada, eliges qué fuentes se leen y ves qué sale de tu equipo."
      aside={
        detail ? (
          <OutboundDetail view={view} onBack={() => setDetail(false)} />
        ) : (
          <OutboundSummary onDetail={() => setDetail(true)} />
        )
      }
      footer={
        <>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {onBack ? (
              <Button variant="ghost" onClick={onBack} disabled={saving}>
                <ArrowLeftIcon className="size-3.5" />
                Atrás
              </Button>
            ) : null}
            <label className="flex max-w-xl cursor-pointer items-start gap-2.5 text-sm text-foreground">
              <Checkbox
                className="mt-0.5"
                checked={accepted}
                disabled={saving}
                onCheckedChange={(checked) => setAccepted(checked === true)}
              />
              <span>{DATA_CONSENT_POLICY.accept}</span>
            </label>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {saveError !== null ? (
              <p
                id={errorId}
                role="alert"
                className="flex max-w-xs items-start gap-1.5 text-xs text-destructive-foreground"
              >
                <TriangleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                <span>{saveError}</span>
              </p>
            ) : null}
            {view !== null && !accepted ? (
              <span id={hintId} className="sr-only">
                Marca la casilla para continuar.
              </span>
            ) : null}
            <Button
              disabled={!canContinue}
              onClick={submit}
              {...(saveError !== null
                ? { "aria-describedby": errorId }
                : view !== null && !accepted
                  ? { "aria-describedby": hintId }
                  : {})}
            >
              {saving ? <Spinner size="sm" aria-hidden role="presentation" /> : null}
              {saving ? "Guardando…" : "Aceptar y continuar"}
            </Button>
          </div>
        </>
      }
    >
      <section className="flex flex-col gap-2.5" aria-label="Fuentes">
        <SectionLabel>Fuentes que se leerán</SectionLabel>
        {view !== null ? (
          <SourcesList
            view={view}
            draft={draft}
            disabled={saving}
            onChange={(source, collect) => {
              setSaveError(null);
              setDraft((current) => ({ ...current, [source]: collect }));
            }}
          />
        ) : loadError === null ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
            <Spinner size="sm" tone="muted" aria-hidden role="presentation" />
            Cargando fuentes…
          </p>
        ) : (
          <Alert variant="error">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>No se pudieron leer las fuentes</AlertTitle>
            <AlertDescription>
              <p>{loadError}</p>
              <Button size="xs" variant="outline" className="mt-2 w-fit" onClick={onRetry}>
                <RotateCwIcon aria-hidden />
                Reintentar
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </section>
    </StepLayout>
  );
}

/** Step 1 of the first-run wizard on the given environment, which runs the captures. */
export function DataConsentStep({ environmentId, onContinue, onBack }: OnboardingStepProps) {
  const query = useEnvironmentQuery(editorialSourcesEnvironment.list({ environmentId, input: {} }));
  const update = useAtomCommand(editorialSourcesEnvironment.update, { reportFailure: false });

  // One write at a time, in list order; the first failure stops and names its source.
  const save: SaveSwitches = async (writes) => {
    for (const write of writes) {
      const result = await update({ environmentId, input: write });
      if (result._tag === "Success") continue;
      const reason = isAtomCommandInterrupted(result)
        ? "Se canceló."
        : failureText(squashAtomCommandFailure(result));
      return `No se guardó la lectura de ${SOURCE_CATALOG[write.source].name}. ${reason} Vuelve a intentarlo.`;
    }
    return null;
  };

  return (
    <DataConsentView
      view={query.data}
      loadError={
        query.data === null && query.error !== null
          ? failureText(query.failure ?? new Error(query.error))
          : null
      }
      onRetry={query.refresh}
      save={save}
      onBack={onBack}
      onContinue={(acceptance) => onContinue({ ...acceptance })}
    />
  );
}
