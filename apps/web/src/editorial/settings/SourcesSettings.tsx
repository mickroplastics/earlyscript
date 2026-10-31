import { SourceId } from "@earlyscript/editorial-contracts/source";
import {
  DELETION_NONE_DOCUMENTED,
  SOURCE_CATALOG,
  type SourceAccess,
  type SourceCost,
  type SourceCoveragePolicy,
  type SourceGovernance,
  type SourceRetention,
  type SourceReviewStatus,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EditorialSourceCaptureStatus,
  EditorialSourceEntry,
  EditorialSourceGap,
  EditorialSourcesCorpus,
  EditorialRssFeed,
  EditorialSourcesView,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { Badge } from "../../components/ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../components/ui/collapsible";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { RssFeedsSettings, type FeedOutcome, type RssFeedControls } from "./RssFeedsSettings";
import { EDITORIAL_SOURCES_SECTION_ID } from "./settingsEntry";
import { editorialSourcesEnvironment } from "./sourcesState";

const STATUS_LABEL: Readonly<Record<SourceReviewStatus, string>> = {
  ready: "Revisada",
  "pending-review": "Revisión pendiente",
  blocked: "Bloqueada",
};
const STATUS_BADGE: Readonly<Record<SourceReviewStatus, "success" | "warning" | "error">> = {
  ready: "success",
  "pending-review": "warning",
  blocked: "error",
};
const CAPTURE_LABEL: Readonly<Record<EditorialSourceCaptureStatus, string>> = {
  complete: "completa",
  partial: "parcial",
  unavailable: "no disponible",
  rate_limited: "limitada por cuota",
};
const GAP_LABEL: Readonly<Record<EditorialSourceGap["reason"], string>> = {
  not_collected: "sin capturar",
  fetch_failed: "falló",
  rate_limited: "cuota",
  partial: "parcial",
};
const ACCESS_LABEL: Readonly<Record<SourceAccess, string>> = {
  public: "Pública, sin clave",
  token: "Con token",
  approval: "Requiere aprobación",
};
const RETENTION_LABEL: Readonly<Record<SourceRetention, string>> = {
  "frozen-corpus": "Corpus congelado, sin plazo de conservación fijado",
  "30-days": "Máximo 30 días",
  ephemeral: "Efímera, fuera del corpus congelado",
};
const COST_LABEL: Readonly<Record<SourceCost, string>> = {
  none: "Sin costo",
  metered: "Pago por uso",
  subscription: "Suscripción",
};
const COVERAGE_LABEL: Readonly<Record<SourceCoveragePolicy, string>> = {
  census: "Censo: un día completo trae todos los ítems",
  sample: "Muestra declarada: un día parcial es su colección completa",
};
const LANGUAGE_LABEL: Readonly<Record<string, string>> = { en: "Inglés" };

const isSourceId = Schema.is(SourceId);

const dayFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});
const shortDayFormat = new Intl.DateTimeFormat("es", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});
const formatDay = (day: string) => dayFormat.format(new Date(`${day}T00:00:00Z`));
const formatShortDay = (day: string) => shortDayFormat.format(new Date(`${day}T00:00:00Z`));
const formatCount = (count: number) => count.toLocaleString("es");

export type SourcePatch = { readonly collect?: boolean; readonly rank?: boolean };

function engineNote(entry: EditorialSourceEntry, governance: SourceGovernance): string {
  if (entry.rankBlocked === "no-backtest") {
    return "Pendiente de backtest: entra al motor solo tras un backtest que no empeore P@5.";
  }
  if (entry.rankBlocked === "not-ready") {
    return governance.status === "blocked"
      ? "Bloqueada por sus condiciones de uso: no entra al motor."
      : "Pendiente de leer sus términos: no se captura ni entra al motor.";
  }
  if (governance.engineBaseline) return "Línea base del motor.";
  return `Backtest registrado: ${entry.backtestRunId}.`;
}

function captureText(entry: EditorialSourceEntry): string {
  const capture = entry.lastCapture;
  if (capture === null) return "Sin capturas.";
  return `Última captura: ${formatDay(capture.day)}, ${CAPTURE_LABEL[capture.status]}, ${formatCount(capture.items)} ítems.`;
}

function gapsText(entry: EditorialSourceEntry): string | null {
  if (entry.lastCapture === null) return null;
  if (entry.recentGaps.length === 0) return "Sin huecos en la última semana del corpus.";
  const gaps = entry.recentGaps.map(
    (gap) => `${formatShortDay(gap.day)} (${GAP_LABEL[gap.reason]})`,
  );
  return `Huecos en la última semana: ${gaps.join(", ")}.`;
}

function corpusText(corpus: EditorialSourcesCorpus): string {
  switch (corpus.status) {
    case "missing":
      return `Sin capturas: no hay corpus en ${corpus.directory}.`;
    case "unreadable":
      return `No se pudo leer el corpus en ${corpus.directory}: ${corpus.message ?? "error desconocido"}.`;
    case "ready":
      return `Corpus en ${corpus.directory}, días ${corpus.fromDay} a ${corpus.toDay} (exclusivo).`;
  }
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  );
}

function GovernanceField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-0.5 @min-[32rem]/settings-row:grid-cols-[10rem_minmax(0,1fr)] @min-[32rem]/settings-row:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

/** The governance record of one source, as it goes into the thesis annex. */
function SourceGovernanceCard({ governance }: { readonly governance: SourceGovernance }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex min-h-8 items-center gap-1.5 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
        Ficha de la fuente
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <dl className="space-y-2 pt-1 pb-3 text-xs leading-normal">
          <GovernanceField label="Origen">{governance.origin}</GovernanceField>
          <GovernanceField label="Licencia">
            {governance.license.url ? (
              <ExternalLink href={governance.license.url}>{governance.license.text}</ExternalLink>
            ) : (
              governance.license.text
            )}
          </GovernanceField>
          <GovernanceField label="Términos revisados">
            {governance.termsReviewedAt ? formatDay(governance.termsReviewedAt) : "Sin revisar"}
            {governance.termsUrl ? (
              <>
                {" · "}
                <ExternalLink href={governance.termsUrl}>Leer términos</ExternalLink>
              </>
            ) : null}
          </GovernanceField>
          <GovernanceField label="Acceso">{ACCESS_LABEL[governance.access]}</GovernanceField>
          <GovernanceField label="Retención">
            {RETENTION_LABEL[governance.retention]}
          </GovernanceField>
          <GovernanceField label="Borrado">
            {governance.deletion === DELETION_NONE_DOCUMENTED
              ? "Sin método documentado"
              : governance.deletion}
          </GovernanceField>
          <GovernanceField label="Idioma">
            {LANGUAGE_LABEL[governance.language] ?? governance.language}
          </GovernanceField>
          <GovernanceField label="Costo">{COST_LABEL[governance.cost]}</GovernanceField>
          <GovernanceField label="Cobertura">{COVERAGE_LABEL[governance.coverage]}</GovernanceField>
          <GovernanceField label="Notas">{governance.notes}</GovernanceField>
        </dl>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function SourceRow({
  entry,
  governance,
  pending,
  onChange,
  rss,
}: {
  readonly entry: EditorialSourceEntry;
  readonly governance: SourceGovernance;
  readonly pending: boolean;
  readonly onChange: (patch: SourcePatch) => void;
  readonly rss: {
    readonly feeds: ReadonlyArray<EditorialRssFeed>;
    readonly controls: RssFeedControls;
  } | null;
}) {
  const engineNoteId = useId();
  const gaps = gapsText(entry);
  return (
    <SettingsRow
      id={`editorial-source-${governance.id}`}
      title={
        <span className="flex items-center gap-2">
          {governance.name}
          <Badge size="sm" variant={STATUS_BADGE[governance.status]}>
            {STATUS_LABEL[governance.status]}
          </Badge>
        </span>
      }
      description={captureText(entry)}
      status={
        <span className="block space-y-0.5">
          {gaps ? <span className="block">{gaps}</span> : null}
          <span id={engineNoteId} className="block">
            {engineNote(entry, governance)}
          </span>
          {entry.collectBlocked === "blocked" ? (
            <span className="block">Captura bloqueada mientras la fuente esté bloqueada.</span>
          ) : null}
        </span>
      }
      control={
        <div className="flex flex-col items-end gap-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <span aria-hidden>Capturar</span>
            <Switch
              checked={entry.collect}
              disabled={pending || entry.collectBlocked !== null}
              {...(entry.collectBlocked === null ? {} : { "aria-describedby": engineNoteId })}
              onCheckedChange={(checked) => onChange({ collect: Boolean(checked) })}
              aria-label={`Capturar ${governance.name}`}
            />
          </div>
          <div className="flex items-center gap-2">
            <span aria-hidden>Usar en el motor</span>
            <Switch
              checked={entry.rank}
              disabled={pending || entry.rankBlocked !== null}
              onCheckedChange={(checked) => onChange({ rank: Boolean(checked) })}
              aria-label={`Usar ${governance.name} en el motor`}
              aria-describedby={engineNoteId}
            />
          </div>
        </div>
      }
    >
      {rss ? <RssFeedsSettings feeds={rss.feeds} controls={rss.controls} /> : null}
      <SourceGovernanceCard governance={governance} />
    </SettingsRow>
  );
}

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
  return (
    <SettingsSection id={EDITORIAL_SOURCES_SECTION_ID} title="Fuentes">
      <SettingsRow
        title="Corpus"
        description={corpusText(view.corpus)}
        status="Las fuentes nuevas se capturan y muestran cobertura; solo pesan en el motor tras un backtest."
      />
      {view.sources.map((entry) => {
        if (!isSourceId(entry.source)) return null;
        const source = entry.source;
        return (
          <SourceRow
            key={source}
            entry={entry}
            governance={SOURCE_CATALOG[source]}
            pending={pending.has(source)}
            onChange={(patch) => onChange(source, patch)}
            rss={source === "rss" ? { feeds: view.rssFeeds, controls: feeds } : null}
          />
        );
      })}
    </SettingsSection>
  );
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  "not-a-feed": "No es un feed RSS ni Atom.",
  "robots-disallowed": "El robots.txt del sitio prohíbe esa ruta a Earlyscript.",
  "robots-unavailable": "El robots.txt del sitio no responde; no se puede comprobar el permiso.",
  unreachable: "El feed no responde.",
  "too-large": "El feed supera el límite de 4 MiB.",
  "invalid-url": "La URL debe empezar con http:// o https://.",
  "duplicate-feed": "Ese feed ya está en la lista.",
  "unknown-feed": "Ese feed ya no está en la lista.",
  "rank-blocked": "La fuente todavía no puede entrar al motor.",
  "collect-blocked": "La fuente no se puede capturar: sus términos están sin leer o la bloquean.",
  "unknown-source": "Este servidor no conoce la fuente.",
  unavailable: "Los servicios editoriales no están montados en este servidor.",
  storage: "La base editorial no respondió.",
};

function failureText(error: unknown): string {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const text = ERROR_TEXT[String(error.reason)];
    if (text) return text;
  }
  return error instanceof Error ? error.message : "Error desconocido.";
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
  if (data === null) {
    return (
      <SettingsSection id={EDITORIAL_SOURCES_SECTION_ID} title="Fuentes">
        <SettingsRow
          title={error ? "No se pudieron leer las fuentes" : "Cargando fuentes"}
          description={error ?? undefined}
        />
      </SettingsSection>
    );
  }
  return (
    <SourcesSettingsView
      view={data}
      pending={pending}
      onChange={(source, patch) => void onChange(source, patch)}
      feeds={feeds}
    />
  );
}

/** Settings › Editorial › Fuentes, on the primary environment, which runs the captures. */
export function SourcesSettings() {
  const environmentId = usePrimaryEnvironmentId();
  if (environmentId === null) {
    return (
      <SettingsSection id={EDITORIAL_SOURCES_SECTION_ID} title="Fuentes">
        <SettingsRow
          title="Sin entorno"
          description="Conecta el entorno principal para ver y cambiar sus fuentes."
        />
      </SettingsSection>
    );
  }
  return <SourcesSettingsForEnvironment environmentId={environmentId} />;
}
