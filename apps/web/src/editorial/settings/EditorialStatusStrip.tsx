import { useAtomValue } from "@effect/atom-react";
import { SOURCE_CATALOG, isCatalogSourceId } from "@earlyscript/editorial-contracts/sourceCatalog";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { editorialEngineEnvironment } from "../engineState";
import { budgetResetText, readyDraftingProviders } from "../onboarding/providersStep.logic";
import { presentationEnvironment } from "../presentationState";
import {
  draftCell,
  modelCell,
  nightlyCell,
  sourcesCell,
  stripAlert,
  type Cell,
  type DraftCell,
  type StripAlert,
  type Tone,
} from "./editorialStatus.logic";
import { useNightlyStatus, useRunNow } from "./editorialStatus";
import {
  EDITORIAL_DRAFTING_PATH,
  EDITORIAL_METHOD_SECTION_ID,
  EDITORIAL_NIGHTLY_PATH,
  EDITORIAL_SOURCES_PATH,
  EDITORIAL_STATUS_SECTION_ID,
} from "./settingsEntry";
import { editorialSourcesEnvironment } from "./sourcesState";

export const TONE_DOT: Readonly<Record<Tone, string>> = {
  ok: "bg-success",
  running: "bg-info",
  warning: "bg-warning",
  error: "bg-destructive",
  idle: "bg-muted-foreground/50",
};

const TONE_TEXT: Readonly<Record<Tone, string>> = {
  ok: "text-foreground",
  running: "text-info-foreground",
  warning: "text-warning-foreground",
  error: "text-destructive-foreground",
  idle: "text-muted-foreground",
};

const sourceName = (source: string) =>
  isCatalogSourceId(source) ? SOURCE_CATALOG[source].name : source;

type CellTarget =
  | typeof EDITORIAL_NIGHTLY_PATH
  | typeof EDITORIAL_SOURCES_PATH
  | typeof EDITORIAL_DRAFTING_PATH;

function StripCell({
  label,
  cell,
  to,
  hash,
  children,
}: {
  readonly label: string;
  readonly cell: Cell;
  readonly to: CellTarget;
  readonly hash?: string;
  readonly children?: ReactNode;
}) {
  return (
    <Link
      to={to}
      {...(hash === undefined ? {} : { hash })}
      className="group/cell flex min-w-0 flex-col gap-1 px-4 py-3 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[cell.tone])} />
        {label}
      </span>
      <span className={cn("truncate text-sm", TONE_TEXT[cell.tone])}>{cell.text}</span>
      {children}
    </Link>
  );
}

interface EditorialStatusStripViewProps {
  readonly nightly: Cell;
  readonly sources: Cell;
  readonly model: Cell;
  readonly draft: DraftCell;
  readonly alert: StripAlert | null;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}

function EditorialStatusStripView({
  nightly,
  sources,
  model,
  draft,
  alert,
  retrying,
  onRetry,
}: EditorialStatusStripViewProps) {
  return (
    <section
      id={EDITORIAL_STATUS_SECTION_ID}
      aria-label="Estado de Editorial"
      className="overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5"
    >
      <div className="grid grid-cols-2 divide-border/50 max-sm:[&>*:nth-child(n+3)]:border-t sm:grid-cols-[1.3fr_1.3fr_1fr_1.3fr] sm:divide-x">
        <StripCell label="Revisión nocturna" cell={nightly} to={EDITORIAL_NIGHTLY_PATH} />
        <StripCell label="Fuentes" cell={sources} to={EDITORIAL_SOURCES_PATH} />
        <StripCell
          label="Modelo local"
          cell={model}
          to={EDITORIAL_NIGHTLY_PATH}
          hash={EDITORIAL_METHOD_SECTION_ID}
        />
        <StripCell label="Redacción" cell={draft} to={EDITORIAL_DRAFTING_PATH}>
          {draft.used === null ? null : (
            <span aria-hidden className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn("block h-full rounded-full", TONE_DOT[draft.tone])}
                style={{ width: `${Math.round(draft.used * 100)}%` }}
              />
            </span>
          )}
        </StripCell>
      </div>
      {alert === null ? null : (
        <div
          role="status"
          className={cn(
            "flex items-center gap-3 border-t border-border/50 px-4 py-2.5 text-sm",
            alert._tag === "retry" || alert._tag === "sources"
              ? "bg-destructive/8 dark:bg-destructive/12"
              : "bg-warning/8 dark:bg-warning/12",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              alert._tag === "retry" || alert._tag === "sources" ? "bg-destructive" : "bg-warning",
            )}
          />
          <span className="min-w-0 flex-1">{alert.text}</span>
          <StripAction alert={alert} retrying={retrying} onRetry={onRetry} />
        </div>
      )}
    </section>
  );
}

function StripAction({
  alert,
  retrying,
  onRetry,
}: {
  readonly alert: StripAlert;
  readonly retrying: boolean;
  readonly onRetry: () => void;
}) {
  switch (alert._tag) {
    case "retry":
      return (
        <Button size="xs" disabled={retrying} onClick={onRetry}>
          {retrying ? <Spinner size="sm" /> : null}
          Reintentar
        </Button>
      );
    case "sources":
      return (
        <Button size="xs" variant="outline" render={<Link to={EDITORIAL_SOURCES_PATH} />}>
          Ver fuentes
        </Button>
      );
    case "model":
      return (
        <Button
          size="xs"
          variant="outline"
          render={<Link to={EDITORIAL_NIGHTLY_PATH} hash={EDITORIAL_METHOD_SECTION_ID} />}
        >
          Descargar
        </Button>
      );
    case "budget":
      return (
        <Button size="xs" variant="outline" render={<Link to={EDITORIAL_DRAFTING_PATH} />}>
          Subir el tope
        </Button>
      );
  }
}

/** The top of «Mi canal»: is everything working, and if not, the one thing to do about it. */
export function EditorialStatusStrip({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const target = { environmentId, input: {} };
  const runNow = useRunNow(environmentId);
  const status = useNightlyStatus(environmentId);
  const sources = useEnvironmentQuery(editorialSourcesEnvironment.list(target));
  const budget = useEnvironmentQuery(presentationEnvironment.budget(target));
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const modelResult = useAtomValue(editorialEngineEnvironment.model(target));
  const modelState = AsyncResult.getOrElse(modelResult, () => null);
  const timeZone = status.settings.data?.timezone;
  const model = modelCell(modelState, modelState === null && AsyncResult.isFailure(modelResult));
  const draft = draftCell(
    budget.data,
    providers === undefined || readyDraftingProviders(providers).length > 0,
  );
  return (
    <EditorialStatusStripView
      nightly={nightlyCell(status.state, timeZone, status.now)}
      sources={sourcesCell(sources.data, sourceName)}
      model={model}
      draft={draft}
      alert={stripAlert({
        nightly: status.state,
        sources: sources.data,
        model,
        draft,
        budgetReset: budget.data === null ? "mes que viene" : budgetResetText(budget.data.month),
        timeZone,
        now: status.now,
      })}
      retrying={runNow.starting}
      onRetry={runNow.run}
    />
  );
}
