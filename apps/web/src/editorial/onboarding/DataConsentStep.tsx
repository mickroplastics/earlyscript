import type { SourceId } from "@earlyscript/editorial-contracts/source";
import { SOURCE_CATALOG } from "@earlyscript/editorial-contracts/sourceCatalog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EditorialSourcesView } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  ClockIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
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
import type { OnboardingStepProps } from "./steps";

// The step grows inside the wizard's own ScrollArea (WizardPopup): one scroll for the whole
// dialog, no nested one. Sources that cannot be captured get a compact row.

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

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-x-3 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

function CaptureSwitch({
  row,
  checked,
  disabled,
  describedBy,
  onChange,
}: {
  readonly row: ConsentSourceRow;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly describedBy: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
      <span aria-hidden>Capturar</span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(Boolean(value))}
        aria-label={`Capturar ${row.name}`}
        aria-describedby={describedBy}
      />
    </div>
  );
}

function ReadySourceRow({
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
  const termsId = useId();
  return (
    <li data-testid={`consent-source-${row.id}`} className="space-y-2 px-3 py-3 sm:px-4">
      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm font-medium text-foreground">{row.name}</p>
          <CaptureSwitch
            row={row}
            checked={checked}
            disabled={disabled}
            describedBy={termsId}
            onChange={onChange}
          />
        </div>
        <p id={termsId} className="mt-0.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <CircleCheckIcon aria-hidden className="mt-px size-3.5 shrink-0 text-success" />
          <span>
            {row.termsLine}
            {row.termsUrl ? (
              <>
                {" · "}
                <ExternalLink href={row.termsUrl}>Leer términos</ExternalLink>
              </>
            ) : null}
          </span>
        </p>
      </div>
      <dl className="space-y-1.5 text-xs leading-normal">
        <Field label="Licencia">
          {row.licenseUrl ? (
            <ExternalLink href={row.licenseUrl}>{row.licenseText}</ExternalLink>
          ) : (
            row.licenseText
          )}
        </Field>
        <Field label="Guarda">{row.storedText}</Field>
        <Field label="Conserva">{row.retentionText}</Field>
        {feedCount !== null ? (
          <Field label="Feeds">
            {feedCount} {feedCount === 1 ? "feed curado" : "feeds curados"}; los tuyos se agregan
            después en Ajustes › Editorial › Fuentes.
          </Field>
        ) : null}
      </dl>
    </li>
  );
}

function LockedSourceRow({ row }: { readonly row: ConsentSourceRow }) {
  const termsId = useId();
  const Icon = row.status === "blocked" ? CircleSlashIcon : ClockIcon;
  return (
    <li data-testid={`consent-source-${row.id}`} className="px-3 py-2.5 sm:px-4">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm font-medium text-foreground">{row.name}</p>
        <CaptureSwitch
          row={row}
          checked={false}
          disabled
          describedBy={termsId}
          onChange={() => {}}
        />
      </div>
      <p
        id={termsId}
        className={cn(
          "mt-0.5 flex items-start gap-1.5 text-xs",
          row.status === "blocked" ? "text-destructive-foreground" : "text-warning-foreground",
        )}
      >
        <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>
          {row.termsLine}
          {row.termsUrl ? (
            <>
              {" · "}
              <ExternalLink href={row.termsUrl}>Ver términos</ExternalLink>
            </>
          ) : null}
        </span>
      </p>
    </li>
  );
}

function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h2 id={headingId} className="text-sm font-semibold text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

const TEXT = "text-xs leading-relaxed text-muted-foreground";

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
      <p className={TEXT}>
        Solo se capturan las fuentes cuyos términos se leyeron. Que una fuente pese en el ranking se
        decide después, en Ajustes, tras un backtest.
      </p>
      <p className={TEXT} data-testid="consent-common-stored">
        {COMMON_STORED_LINE}
      </p>
      <ul
        aria-label="Fuentes que puedes capturar"
        className="divide-y rounded-lg border bg-background"
      >
        {ready.map((row) => (
          <ReadySourceRow
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
        <>
          <h3 className="pt-2 text-xs font-medium text-muted-foreground">
            Sin permiso para capturar todavía
          </h3>
          <ul
            aria-label="Fuentes sin permiso para capturar"
            className="divide-y rounded-lg border bg-background"
          >
            {locked.map((row) => (
              <LockedSourceRow key={row.id} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </>
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
  const errorId = useId();
  const hintId = useId();
  const policy = DATA_CONSENT_POLICY;
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
        console.error("Datos y permisos: no se pudo continuar", cause);
        setSaveError(UNEXPECTED_SAVE_ERROR);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-6" data-testid="data-consent-step">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Datos y permisos</h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{policy.intro}</p>
      </div>

      <Block title="Fuentes">
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
      </Block>

      <Block title="Qué sale de esta máquina">
        <div className={cn(TEXT, "space-y-1.5")}>
          <p>{policy.outbound[0]}</p>
          <ol className="space-y-1.5">
            {(["a", "b"] as const).map((marker, index) => (
              <li key={marker} className="grid grid-cols-[1.25rem_minmax(0,1fr)]">
                <span aria-hidden>{marker})</span>
                <span>{policy.outbound[index + 1]}</span>
              </li>
            ))}
          </ol>
          <p>{policy.outbound[3]}</p>
          <p>{policy.outbound[4]}</p>
        </div>
      </Block>

      <Block title="Conservación y borrado">
        <div className={cn(TEXT, "space-y-1.5")}>
          {view !== null ? <p data-testid="consent-corpus">{corpusText(view.corpus)}</p> : null}
          {policy.retention.map((text) => (
            <p key={text}>{text}</p>
          ))}
          <p>{policy.deletion[0]}</p>
          <CommandText
            text={view !== null ? deletionCommand(view.corpus.directory) : policy.deletionCommand}
          />
          <p>{policy.deletion[1]}</p>
        </div>
      </Block>

      <div className="space-y-4 border-t pt-4">
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground">
          <Checkbox
            className="mt-0.5"
            checked={accepted}
            disabled={saving}
            onCheckedChange={(checked) => setAccepted(checked === true)}
          />
          <span>{policy.accept}</span>
        </label>
        {view !== null && !accepted ? (
          <p id={hintId} className="-mt-2 pl-6.5 text-xs text-muted-foreground">
            Marca la casilla para continuar.
          </p>
        ) : null}
        {saveError !== null ? (
          <p
            id={errorId}
            role="alert"
            className="flex items-start gap-1.5 text-sm text-destructive-foreground"
          >
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{saveError}</span>
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          {onBack ? (
            <Button variant="ghost" onClick={onBack} disabled={saving}>
              <ArrowLeftIcon className="size-3.5" />
              Atrás
            </Button>
          ) : (
            <span />
          )}
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
            {saving ? "Guardando…" : "Continuar"}
            {saving ? null : <ArrowRightIcon className="size-3.5" />}
          </Button>
        </div>
      </div>
    </div>
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
      return `No se guardó «Capturar» de ${SOURCE_CATALOG[write.source].name}. ${reason} Vuelve a intentarlo.`;
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
