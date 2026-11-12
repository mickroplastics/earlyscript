import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EditorialResultsDecisionPage,
  EditorialResultsSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { Fragment, useState, type ReactNode } from "react";

import { useQuietThreadShells } from "../../state/entities";
import { EditorialEmptyPage, EditorialPage } from "../EditorialPage";
import { editorialResultsEnvironment } from "../resultsState";
import {
  DECISIONS_PAGE_SIZE,
  DecisionsTab,
  NoDecisions,
  type DecisionFilter,
  type ResultsDecisionsControls,
  type ResultsDecisionsState,
} from "./DecisionsTab";
import { EvidenceExportButton } from "./EvidenceExportButton";
import { FiguresProvider } from "./FigureFrame";
import { FiguresExportButton } from "./FiguresExportButton";
import { InboxVideoTab } from "./InboxVideoTab";
import { ManualBaselineSection } from "./ManualBaselineSection";
import { QualityTab } from "./QualityTab";
import { ResultsCaveat } from "./ResultsCaveat";
import { RESULTS_FIGURE_ORDER, resultsThreadCount } from "./resultsFigures.logic";
import { ResultsHero, type ProcessPointsState } from "./ResultsHero";
import { decisionsFailureText, formatInteger, hasDecisions } from "./results.logic";
import {
  completeProcessPoints,
  headerLineText,
  localTimeZone,
  trialsWithoutDecision,
  visibleTabs,
} from "./resultsOverview.logic";
import { ResultsTabs, useResultsTab } from "./ResultsTabs";
import { TimeTab } from "./TimeTab";

export type { ResultsDecisionsControls, ResultsDecisionsState } from "./DecisionsTab";

const SPACE_LABEL = "Resultados";
/** The contract's page limit: the overview reads every decision up to it, in one page. */
const OVERVIEW_LIMIT = 100;

/** A read of the decisions behind the cards and the scripts tab, apart from the table's page. */
export interface ResultsOverviewControls {
  readonly state: ResultsDecisionsState;
  readonly onRetry: () => void;
}

/** The header line breaks only between its parts, never inside one. */
function HeaderLine({ text }: { readonly text: string }) {
  return text.split(" · ").map((part, index) => (
    <Fragment key={part}>
      {index > 0 ? "\u00a0· " : null}
      <span className="whitespace-nowrap">{part}</span>
    </Fragment>
  ));
}

/** The Results space with its data; the page fetches, this renders. */
export function ResultsView({
  summary,
  decisions,
  overview,
  threadTitles,
  exportAction,
  baseline,
}: {
  readonly summary: EditorialResultsSummary;
  readonly decisions: ResultsDecisionsControls;
  readonly overview: ResultsOverviewControls;
  readonly threadTitles: ReadonlyMap<string, string>;
  /** «Exportar evidencia» and «Guardar todas las figuras»; the page mounts them. */
  readonly exportAction?: ReactNode;
  /** «Línea base manual»; the page mounts it, the view only places it. */
  readonly baseline?: ReactNode;
}) {
  const tabs = visibleTabs(summary);
  const [tab, setTab] = useResultsTab(tabs);
  const decided = hasDecisions(summary);
  const page = overview.state._tag === "ready" ? overview.state.page : null;
  const total = summary.comparisons.find((comparison) => comparison.key === "total");
  const points: ProcessPointsState =
    page === null
      ? { _tag: "loading" }
      : { _tag: "ready", points: total ? completeProcessPoints(page, total) : null };
  const complete = page !== null && page.offset === 0 && page.total <= page.decisions.length;

  return (
    <div className="@container flex min-w-0 flex-col gap-6">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-96 flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">Resultados</h1>
          <p className="text-sm text-muted-foreground tabular-nums">
            {decided ? (
              <HeaderLine text={headerLineText(summary, localTimeZone())} />
            ) : (
              "Ninguna decisión registrada todavía."
            )}
          </p>
        </div>
        {exportAction}
      </header>
      {decided ? (
        <div className="flex min-w-0 flex-col gap-3">
          <ResultsHero summary={summary} points={points} />
          <ResultsCaveat summary={summary} />
        </div>
      ) : (
        <>
          <ResultsCaveat summary={summary} />
          <NoDecisions />
        </>
      )}
      <ResultsTabs
        tabs={tabs}
        value={tab}
        onValueChange={setTab}
        counts={{ decisiones: formatInteger(summary.decisionCount) }}
        panels={{
          etapas: <TimeTab summary={summary} />,
          utilidad: (
            <QualityTab
              summary={summary}
              scripts={overview.state}
              onRetry={overview.onRetry}
              threadTitles={threadTitles}
            />
          ),
          "linea-base": baseline,
          bandeja: <InboxVideoTab summary={summary} withVideo={decided} />,
          decisiones: (
            <DecisionsTab
              summary={summary}
              decisions={decisions}
              threadTitles={threadTitles}
              undecidedTrials={
                complete && page
                  ? trialsWithoutDecision(summary.trials ?? [], page.decisions)
                  : null
              }
            />
          ),
        }}
      />
    </div>
  );
}

function useThreadTitles(): ReadonlyMap<string, string> {
  const shells = useQuietThreadShells();
  return new Map(shells.map((shell) => [shell.id, shell.title]));
}

/** An atom's decisions read as the views see it. */
function decisionsState(
  result: AsyncResult.AsyncResult<EditorialResultsDecisionPage, unknown>,
): ResultsDecisionsState {
  const page = AsyncResult.getOrElse(result, () => null);
  if (page !== null) return { _tag: "ready", page };
  if (result._tag === "Failure" && !result.waiting) {
    return {
      _tag: "failure",
      message: decisionsFailureText(Option.getOrUndefined(Cause.findErrorOption(result.cause))),
    };
  }
  return { _tag: "loading" };
}

export function ResultsPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [filter, setFilter] = useState<DecisionFilter>("all");
  const [showTrials, setShowTrials] = useState(false);
  const [offset, setOffset] = useState(0);
  const threadTitles = useThreadTitles();
  const summaryResult = useAtomValue(
    editorialResultsEnvironment.summary({ environmentId, input: {} }),
  );
  const decisionsAtom = editorialResultsEnvironment.decisions({
    environmentId,
    input: {
      limit: DECISIONS_PAGE_SIZE,
      ...(offset === 0 ? {} : { offset }),
      ...(filter === "all" ? {} : { mode: filter }),
      ...(showTrials ? {} : { cohort: "human" }),
    },
  });
  const overviewAtom = editorialResultsEnvironment.decisions({
    environmentId,
    input: { limit: OVERVIEW_LIMIT },
  });
  const decisionsResult = useAtomValue(decisionsAtom);
  const overviewResult = useAtomValue(overviewAtom);
  const retryDecisions = useAtomRefresh(decisionsAtom);
  const retryOverview = useAtomRefresh(overviewAtom);
  const summary = AsyncResult.getOrElse(summaryResult, () => null);
  if (summary === null) {
    return summaryResult._tag === "Failure" ? (
      <EditorialEmptyPage
        space={SPACE_LABEL}
        title="No se pudieron leer los resultados"
        description="La base editorial de este entorno no respondió. Vuelve a abrir el espacio en un momento."
      />
    ) : (
      <EditorialPage space={SPACE_LABEL}>{null}</EditorialPage>
    );
  }
  return (
    <EditorialPage space={SPACE_LABEL}>
      <FiguresProvider
        environmentId={environmentId}
        threads={resultsThreadCount(summary)}
        order={RESULTS_FIGURE_ORDER}
      >
        <ResultsView
          summary={summary}
          threadTitles={threadTitles}
          exportAction={
            <div className="flex flex-wrap gap-2">
              <EvidenceExportButton environmentId={environmentId} />
              <FiguresExportButton />
            </div>
          }
          baseline={<ManualBaselineSection environmentId={environmentId} summary={summary} />}
          overview={{ state: decisionsState(overviewResult), onRetry: retryOverview }}
          decisions={{
            state: decisionsState(decisionsResult),
            onRetry: retryDecisions,
            filter,
            onFilter: (next) => {
              setFilter(next);
              setOffset(0);
            },
            showTrials,
            onShowTrials: (next) => {
              setShowTrials(next);
              setOffset(0);
            },
            onPage: setOffset,
          }}
        />
      </FiguresProvider>
    </EditorialPage>
  );
}
