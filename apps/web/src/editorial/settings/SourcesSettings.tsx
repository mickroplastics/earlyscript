import type { SourceId } from "@earlyscript/editorial-contracts/source";
import {
  isCatalogSourceId,
  SOURCE_CATALOG,
  type SourceAccess,
  type SourceCost,
  type SourceGovernance,
  type SourceRetention,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EditorialSourceBacktest,
  EditorialSourceEntry,
  EditorialSourcesView,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronRightIcon, LockIcon } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";

import {
  SettingsPageContainer,
  useSettingsSearchTarget,
  useSettingsSearchTargetId,
} from "../../components/settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { capitalize, relativeDay, type Tone } from "./editorialStatus.logic";
import {
  DefaultFeeds,
  Fold,
  UserFeeds,
  type FeedOutcome,
  type RssFeedControls,
} from "./RssFeedsSettings";
import { EDITORIAL_RSS_SECTION_ID, EDITORIAL_SOURCES_SECTION_ID } from "./settingsEntry";
import { NoEnvironment, SettingsPageHeader } from "./SettingsPageHeader";
import {
  dayCells,
  deletionOf,
  firstSentence,
  namesList,
  rankBlockText,
  sourceStatus,
  type DayState,
} from "./sources.logic";
import { editorialSourcesEnvironment } from "./sourcesState";
import { failureText } from "./sourcesText";

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "text-foreground",
  running: "text-info-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  idle: "text-muted-foreground",
};

const DAY_CLASS: Readonly<Record<DayState, string>> = {
  ok: "bg-success/80",
  failed: "bg-destructive/80",
  limited: "bg-warning/80",
  partial: "bg-warning/80",
  missing: "bg-muted",
};

const ACCESS_TEXT: Readonly<Record<SourceAccess, string>> = {
  public: "sin clave",
  token: "con token",
  approval: "requiere aprobación",
};
const COST_TEXT: Readonly<Record<SourceCost, string>> = {
  none: "sin costo",
  metered: "pago por uso",
  subscription: "por suscripción",
};
const RETENTION_TEXT: Readonly<Record<SourceRetention, string>> = {
  "frozen-corpus": "Todo lo capturado, sin plazo fijado",
  "30-days": "Máximo 30 días",
  ephemeral: "No se guarda: se usa y se descarta",
};

const dayFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const formatDate = (day: string) => dayFormat.format(new Date(`${day.slice(0, 10)}T00:00:00Z`));
const formatMetric = (value: number | null) =>
  value === null ? "sin dato" : value.toLocaleString("es", { maximumFractionDigits: 2 });

export type SourcePatch = { readonly collect?: boolean; readonly rank?: boolean };

/** A change that asks first: what it does to the trends and that it is recorded. */
type PendingChange =
  | { readonly _tag: "stop-counting"; readonly source: SourceId }
  | { readonly _tag: "start-counting"; readonly source: SourceId }
  | { readonly _tag: "stop-capturing"; readonly source: SourceId };

const sourceRowId = (id: string) =>
  id === "rss" ? EDITORIAL_RSS_SECTION_ID : `editorial-source-${id}`;

/** "Ayer", "Hoy" or "El 30 oct": the start of a sentence about a day. */
const dayLead = (day: string) => (day === "hoy" || day === "ayer" ? capitalize(day) : `El ${day}`);

/** "Wikipedia" for "Wikipedia (páginas más vistas)": the record keeps the full name. */
const shortName = (name: string) => name.replace(/\s*\(.*\)$/, "");

const originText = (origin: string) => origin.replace(/^https?:\/\//, "");

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-info-foreground underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** A link-styled action inside a sentence of the record. */
function InlineAction({ children, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="rounded-sm text-info-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function CopyCommand({ command }: { readonly command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <InlineAction
      onClick={() =>
        void navigator.clipboard.writeText(command).then(
          () => setCopied(true),
          () => toastManager.add({ type: "error", title: "No se pudo copiar el comando" }),
        )
      }
    >
      {copied ? "Copiado" : "Copiar comando"}
    </InlineAction>
  );
}

/** The recorded backtest, for the thesis annex: when, over which days, and what it found. */
function BacktestText({ backtest }: { readonly backtest: EditorialSourceBacktest }) {
  return (
    <p data-testid="source-backtest">
      Prueba del {formatDate(backtest.experimentAt)}, días del {formatDate(backtest.cutoffFrom)} al{" "}
      {formatDate(backtest.cutoffTo)}: {backtest.verdict === "not-worse" ? "no empeora" : "empeora"}{" "}
      los resultados. P@5 {formatMetric(backtest.p5Baseline)} sin la fuente y{" "}
      {formatMetric(backtest.p5Candidate)} con ella, sobre {backtest.completeCutoffs} días con
      seguimiento completo ({backtest.partialCutoffs} parciales aparte).
      {backtest.status === "provisional"
        ? backtest.allowProvisional
          ? " Provisional, registrada a sabiendas."
          : " Provisional: no la habilita."
        : ""}
    </p>
  );
}

/** Origin, conditions, intended use, access, retention and deletion of one source. */
function GovernanceList({
  governance,
  entry,
  rss,
}: {
  readonly governance: SourceGovernance;
  readonly entry: EditorialSourceEntry;
  readonly rss: boolean;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const deletion = deletionOf(governance);
  return (
    <div>
      <dl className="space-y-2 text-sm leading-normal">
        {rss ? (
          <Field label="Qué se guarda">
            Título, enlace, autor y un extracto de hasta 500 caracteres
          </Field>
        ) : (
          <Field label="De dónde">
            {originText(governance.origin)}{" "}
            <span className="text-muted-foreground">
              · {ACCESS_TEXT[governance.access]}, {COST_TEXT[governance.cost]}
            </span>
          </Field>
        )}
        <Field label="Condiciones">
          {governance.license.url && governance.license.url !== governance.termsUrl ? (
            <ExternalLink href={governance.license.url}>{governance.license.text}</ExternalLink>
          ) : (
            governance.license.text
          )}{" "}
          <span className="text-muted-foreground">
            {governance.termsReviewedAt
              ? `Revisados el ${formatDate(governance.termsReviewedAt)}`
              : "Términos sin revisar"}
          </span>
          {governance.termsUrl ? (
            <>
              <span className="text-muted-foreground"> · </span>
              <ExternalLink href={governance.termsUrl}>Leer términos</ExternalLink>
            </>
          ) : null}
        </Field>
        <Field label="Uso previsto">Análisis privado, sin republicar el texto</Field>
        {governance.robotsOverride ? (
          <Field label="Acceso">
            Su robots.txt lo prohíbe; los términos de la API lo permiten{" "}
            <span className="text-muted-foreground">· excepción anotada cada día · </span>
            <ExternalLink href={governance.robotsOverride.termsUrl}>
              Términos de la API
            </ExternalLink>
          </Field>
        ) : null}
        <Field label="Cuánto se guarda">{RETENTION_TEXT[governance.retention]}</Field>
        <Field label="Borrar">
          {deletion.text}{" "}
          {deletion.command === null ? null : <CopyCommand command={deletion.command} />}
        </Field>
        <Field label="Notas">
          {firstSentence(governance.notes)}{" "}
          <InlineAction aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>
            {noteOpen ? "Ocultar nota" : "Nota completa"}
          </InlineAction>
          {noteOpen ? (
            <div className="mt-1.5 space-y-1.5 text-muted-foreground">
              <p>{governance.notes}</p>
              {governance.robotsOverride ? (
                <p>
                  {governance.robotsOverride.reason} «{governance.robotsOverride.quote}»
                </p>
              ) : null}
              {deletion.command === null ? null : <p>{governance.deletion}</p>}
              {entry.backtest && !governance.engineBaseline ? (
                <BacktestText backtest={entry.backtest} />
              ) : null}
            </div>
          ) : null}
        </Field>
      </dl>
    </div>
  );
}

function DayStrip({
  entry,
  view,
  name,
}: {
  readonly entry: EditorialSourceEntry;
  readonly view: EditorialSourcesView;
  readonly name: string;
}) {
  const cells = dayCells(entry, view);
  if (cells.length === 0) return <span className="w-[5.25rem]" />;
  const label = `${name}, últimos 7 días: ${cells.map((cell) => cell.label).join("; ")}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={label}
            className="flex w-[5.25rem] shrink-0 gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        {cells.map((cell) => (
          <span key={cell.day} className={cn("h-3.5 flex-1 rounded-xs", DAY_CLASS[cell.state])} />
        ))}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <ul className="space-y-0.5 text-xs">
          {cells.map((cell) => (
            <li key={cell.day} className="flex items-center gap-2">
              <span aria-hidden className={cn("size-2 rounded-xs", DAY_CLASS[cell.state])} />
              {cell.label}
            </li>
          ))}
        </ul>
      </TooltipPopup>
    </Tooltip>
  );
}

function SourceRow({
  entry,
  governance,
  view,
  pending,
  onCapture,
  onAsk,
  feeds,
}: {
  readonly entry: EditorialSourceEntry;
  readonly governance: SourceGovernance;
  readonly view: EditorialSourcesView;
  readonly pending: boolean;
  readonly onCapture: (collect: boolean) => void;
  readonly onAsk: (change: PendingChange) => void;
  readonly feeds: RssFeedControls;
}) {
  const rss = governance.id === "rss";
  const rowId = sourceRowId(governance.id);
  const [open, setOpen] = useState(false);
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowId);
  // A search jump lands on the row: open its record before the scroll runs.
  const targetId = useSettingsSearchTargetId();
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (targetId === rowId && openedFor !== rowId) {
    setOpenedFor(rowId);
    if (!open) setOpen(true);
  }
  const status = sourceStatus(entry, governance, view);
  const capture = entry.lastCapture;
  const blockText = entry.rank ? null : rankBlockText(entry, governance);
  const failing = entry.collect && capture !== null && capture.status === "unavailable";
  return (
    <div id={rowId} ref={targetRef} tabIndex={-1} className="outline-none">
      <Collapsible open={open} onOpenChange={setOpen} data-testid={`source-${governance.id}`}>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <CollapsibleTrigger className="grid min-w-0 flex-1 grid-cols-[minmax(0,11rem)_minmax(0,1fr)] items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                  open && "rotate-90",
                )}
              />
              <span className="truncate">
                {rss ? "Blogs y newsletters" : shortName(governance.name)}
              </span>
            </span>
            <span className="min-w-0 truncate text-xs">
              {status.map((part, index) => (
                <span key={part.text} className={TONE_CLASS[part.tone]}>
                  {index > 0 ? <span className="text-muted-foreground"> · </span> : null}
                  {part.text}
                </span>
              ))}
            </span>
          </CollapsibleTrigger>
          <DayStrip entry={entry} view={view} name={governance.name} />
          <span className="flex w-10 shrink-0 justify-end">
            {entry.rank ? (
              <span className="flex size-8 items-center justify-center text-muted-foreground">
                <LockIcon aria-hidden className="size-3.5" />
                <span className="sr-only">
                  {governance.name} cuenta para tus tendencias; se cambia en su ficha
                </span>
              </span>
            ) : (
              <Switch
                checked={entry.collect}
                disabled={pending || entry.collectBlocked !== null}
                onCheckedChange={(checked) => {
                  if (checked) onCapture(true);
                  else onAsk({ _tag: "stop-capturing", source: governance.id });
                }}
                aria-label={`Capturar ${governance.name}`}
              />
            )}
          </span>
        </div>
        <CollapsiblePanel>
          <div className="space-y-3 border-t border-dashed border-border/60 px-4 pt-3 pb-4 sm:pl-9">
            {failing ? (
              <p className="rounded-lg bg-destructive/8 px-3 py-2 text-sm dark:bg-destructive/12">
                {dayLead(relativeDay(capture.day, view.asOf.slice(0, 10)))} no respondió. La próxima
                revisión lo vuelve a intentar;{" "}
                {entry.rank
                  ? "mientras tanto, tus tendencias salen de las demás fuentes."
                  : "como aún no cuenta, tus tendencias no cambian."}
              </p>
            ) : null}
            {rss ? (
              <>
                <DefaultFeeds
                  feeds={view.rssFeeds.filter((feed) => feed.origin === "default")}
                  onExclude={feeds.onExcludeDefault}
                />
                <Fold title="Condiciones y borrado">
                  <GovernanceList governance={governance} entry={entry} rss />
                </Fold>
                <UserFeeds
                  feeds={view.rssFeeds.filter((feed) => feed.origin === "user")}
                  controls={feeds}
                />
              </>
            ) : (
              <GovernanceList governance={governance} entry={entry} rss={false} />
            )}
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {entry.rank ? (
                <>
                  {governance.engineBaseline ? (
                    <span className="flex items-center gap-1">
                      <LockIcon aria-hidden className="size-3" />
                      Parte del método evaluado
                    </span>
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onAsk({ _tag: "stop-counting", source: governance.id })}
                  >
                    Dejar de contar o de capturar…
                  </Button>
                </>
              ) : (
                <>
                  <span className={blockText === null ? "text-success-foreground" : undefined}>
                    {blockText ?? "La prueba no empeoró los resultados"}
                  </span>
                  {entry.rankBlocked === "not-ready" ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={pending || blockText !== null}
                      onClick={() => onAsk({ _tag: "start-counting", source: governance.id })}
                    >
                      Contar para tendencias…
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function ConfirmDialog({
  change,
  view,
  onClose,
  onConfirm,
}: {
  readonly change: PendingChange | null;
  readonly view: EditorialSourcesView;
  readonly onClose: () => void;
  readonly onConfirm: (source: SourceId, patch: SourcePatch) => void;
}) {
  const [alsoCapture, setAlsoCapture] = useState<"keep" | "stop">("keep");
  const governance = change === null ? null : SOURCE_CATALOG[change.source];
  const entry =
    change === null ? null : view.sources.find((candidate) => candidate.source === change.source);
  const name = governance?.name ?? "";
  const evaluated = governance?.engineBaseline === true;
  const content = ((): {
    readonly title: string;
    readonly body: string;
    readonly action: string;
    readonly destructive: boolean;
  } | null => {
    if (change === null) return null;
    switch (change._tag) {
      case "stop-counting":
        return {
          title: `¿Dejar de contar ${name}?`,
          body: `${evaluated ? "Es parte del método evaluado. " : ""}Lo ya encontrado no cambia; las revisiones siguientes buscarán tendencias sin ${name}. Queda registrado con su hora y se puede volver atrás.`,
          action: alsoCapture === "stop" ? "Dejar de contar y de capturar" : "Dejar de contar",
          destructive: true,
        };
      case "start-counting":
        return {
          title: `¿Contar ${name} para tus tendencias?`,
          body: `${evaluated ? "" : "Tus tendencias dejarán de salir del método evaluado. "}Lo ya encontrado no cambia; desde la próxima revisión se busca también en ${name}. Queda registrado con su hora y se puede volver atrás.`,
          action: `Contar ${name}`,
          destructive: false,
        };
      case "stop-capturing":
        return {
          title: `¿Dejar de capturar ${name}?`,
          body: "Lo ya capturado se conserva; los días sin captura no se recuperan. Queda registrado con su hora y se puede volver a encender.",
          action: "Dejar de capturar",
          destructive: true,
        };
    }
  })();
  return (
    <AlertDialog
      open={change !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          setAlsoCapture("keep");
        }
      }}
    >
      <AlertDialogPopup>
        {content === null || change === null ? null : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{content.title}</AlertDialogTitle>
              <AlertDialogDescription>{content.body}</AlertDialogDescription>
            </AlertDialogHeader>
            {change._tag === "stop-counting" ? (
              <div className="px-6">
                <RadioGroup
                  aria-label="Qué hacer con la captura"
                  value={alsoCapture}
                  onValueChange={(value) => {
                    if (value === "keep" || value === "stop") setAlsoCapture(value);
                  }}
                >
                  {(
                    [
                      [
                        "keep",
                        "Dejar de contar, seguir capturando",
                        "Se sigue guardando para probarla",
                      ],
                      [
                        "stop",
                        "Dejar de contar y de capturar",
                        "Los días sin captura no se recuperan",
                      ],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 has-data-checked:border-primary/60 has-data-checked:bg-primary/6"
                    >
                      <Radio value={value} className="mt-0.5" />
                      <span>
                        <span className="block text-sm text-foreground">{label}</span>
                        <span className="block text-xs text-muted-foreground">{hint}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogClose render={<Button size="sm" variant="ghost" />}>
                Cancelar
              </AlertDialogClose>
              <Button
                size="sm"
                variant={content.destructive ? "destructive" : "default"}
                onClick={() => {
                  const patch: SourcePatch =
                    change._tag === "stop-counting"
                      ? alsoCapture === "stop"
                        ? { rank: false, collect: false }
                        : { rank: false }
                      : change._tag === "start-counting"
                        ? entry?.collect === false
                          ? { rank: true, collect: true }
                          : { rank: true }
                        : { collect: false };
                  onConfirm(change.source, patch);
                  onClose();
                  setAlsoCapture("keep");
                }}
              >
                {content.action}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function GroupHeader({ title, count }: { readonly title: string; readonly count: number }) {
  return (
    <>
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </span>
      <span className="text-xs text-muted-foreground"> · {count}</span>
    </>
  );
}

function ColumnLabels() {
  return (
    <span aria-hidden className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
      <span className="w-[5.25rem] text-center">7 días</span>
      <span className="w-10 text-right">Captura</span>
    </span>
  );
}

const sourceCard =
  "rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50";

export function SourcesSettingsView({
  view,
  pending,
  onChange,
  feeds,
}: {
  readonly view: EditorialSourcesView;
  readonly pending: ReadonlySet<string>;
  readonly onChange: (source: SourceId, patch: SourcePatch) => void;
  readonly feeds: RssFeedControls;
}) {
  const [asking, setAsking] = useState<PendingChange | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const entries = view.sources.flatMap((entry) =>
    isCatalogSourceId(entry.source) ? [{ entry, governance: SOURCE_CATALOG[entry.source] }] : [],
  );
  const counting = entries.filter(({ entry }) => entry.rank);
  const later = entries.filter(({ entry }) => !entry.rank);
  // A search jump to a source that does not count yet opens its group first.
  const targetId = useSettingsSearchTargetId();
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const targetInLater = later.some(({ governance }) => sourceRowId(governance.id) === targetId);
  if (targetInLater && targetId !== null && openedFor !== targetId) {
    setOpenedFor(targetId);
    if (!laterOpen) setLaterOpen(true);
  }
  const row = ({ entry, governance }: (typeof entries)[number]) => (
    <SourceRow
      key={governance.id}
      entry={entry}
      governance={governance}
      view={view}
      pending={pending.has(governance.id)}
      onCapture={(collect) => onChange(governance.id, { collect })}
      onAsk={setAsking}
      feeds={feeds}
    />
  );
  return (
    <section id={EDITORIAL_SOURCES_SECTION_ID} tabIndex={-1} className="space-y-5 outline-none">
      <SettingsPageHeader
        title="Fuentes"
        description={
          counting.length === 0
            ? "Ninguna fuente cuenta para tus tendencias: la revisión no tiene dónde buscar."
            : `Tus tendencias salen de ${namesList(counting.map(({ governance }) => governance.name))}.`
        }
      />
      {view.corpus.status === "ready" ? null : (
        <p
          className={cn(
            "text-sm",
            view.corpus.status === "unreadable"
              ? "text-destructive-foreground"
              : "text-muted-foreground",
          )}
        >
          {view.corpus.status === "missing"
            ? "Todavía no hay capturas en este equipo; la primera revisión las trae."
            : `No se pudo leer lo capturado: ${view.corpus.message ?? "error desconocido"}.`}
        </p>
      )}
      <div className="space-y-2">
        <div className="flex items-center px-1">
          <h3>
            <GroupHeader title="Cuentan para tus tendencias" count={counting.length} />
          </h3>
          <ColumnLabels />
        </div>
        {counting.length === 0 ? null : <div className={sourceCard}>{counting.map(row)}</div>}
      </div>
      <Collapsible open={laterOpen} onOpenChange={setLaterOpen}>
        <div className="flex items-center px-1">
          <h3>
            <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                  laterOpen && "rotate-90",
                )}
              />
              <GroupHeader title="Todavía no cuentan" count={later.length} />
            </CollapsibleTrigger>
          </h3>
          {laterOpen ? <ColumnLabels /> : null}
        </div>
        <CollapsiblePanel>
          <div className={cn(sourceCard, "mt-2")}>{later.map(row)}</div>
        </CollapsiblePanel>
      </Collapsible>
      <ConfirmDialog
        change={asking}
        view={view}
        onClose={() => setAsking(null)}
        onConfirm={onChange}
      />
    </section>
  );
}

function SourcesSettingsForEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { data, error } = useEnvironmentQuery(
    editorialSourcesEnvironment.list({ environmentId, input: {} }),
  );
  const quiet = { reportFailure: false } as const;
  const update = useAtomCommand(editorialSourcesEnvironment.update, quiet);
  const validateFeed = useAtomCommand(editorialSourcesEnvironment.validateFeed, quiet);
  const addFeed = useAtomCommand(editorialSourcesEnvironment.addFeed, quiet);
  const removeFeed = useAtomCommand(editorialSourcesEnvironment.removeFeed, quiet);
  const setDefaultFeedExcluded = useAtomCommand(
    editorialSourcesEnvironment.setDefaultFeedExcluded,
    quiet,
  );
  const outcome = <A,>(result: AtomCommandResult<A, unknown>): FeedOutcome<A> =>
    result._tag === "Success"
      ? { ok: true, value: result.value }
      : {
          ok: false,
          message: isAtomCommandInterrupted(result)
            ? "Se canceló."
            : failureText(squashAtomCommandFailure(result)),
        };
  const toastOnFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title,
        description: failureText(squashAtomCommandFailure(result)),
      });
    }
  };
  const feeds: RssFeedControls = {
    onExcludeDefault: (id, excluded) =>
      void setDefaultFeedExcluded({ environmentId, input: { id, excluded } }).then((result) =>
        toastOnFailure("No se guardó el feed", result),
      ),
    onAdd: async (input) => {
      const result = outcome(await addFeed({ environmentId, input }));
      return result.ok ? { ok: true, value: undefined } : result;
    },
    onRemove: (feedUrl) =>
      void removeFeed({ environmentId, input: { feedUrl } }).then((result) =>
        toastOnFailure("No se quitó el feed", result),
      ),
    onTest: async (feedUrl) => outcome(await validateFeed({ environmentId, input: { feedUrl } })),
  };
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const onChange = async (source: SourceId, patch: SourcePatch) => {
    setPending((current) => new Set(current).add(source));
    const result = await update({ environmentId, input: { source, ...patch } });
    setPending((current) => {
      const next = new Set(current);
      next.delete(source);
      return next;
    });
    toastOnFailure("No se guardó el ajuste de la fuente", result);
  };
  return (
    <SettingsPageContainer>
      {data === null ? (
        <SettingsPageHeader
          title="Fuentes"
          description={error ? `No se pudieron leer las fuentes: ${error}` : "Cargando…"}
        />
      ) : (
        <SourcesSettingsView
          view={data}
          pending={pending}
          onChange={(source, patch) => void onChange(source, patch)}
          feeds={feeds}
        />
      )}
    </SettingsPageContainer>
  );
}

/** Settings › Editorial › Fuentes, on the primary environment, which runs the captures. */
export function SourcesSettingsPage() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) return <NoEnvironment />;
  return <SourcesSettingsForEnvironment environmentId={environmentId} />;
}
