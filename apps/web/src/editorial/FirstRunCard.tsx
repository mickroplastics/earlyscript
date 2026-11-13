import type { EditorialInbox, EditorialJob, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Empty } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { Spinner } from "../components/ui/spinner";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useNowMinute } from "../hooks/useNowMinute";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { ReviewPhaseList, usePhaseNotes, type PhaseNotes } from "./FirstReviewPhases";
import {
  draftingProblem,
  firstRunView,
  minuteClockMs,
  nextReviewText,
  reviewFailure,
  type FirstRunView,
} from "./firstRun.logic";
import { editorialJobsEnvironment } from "./jobsState";
import { editorialOnboardingEnvironment } from "./onboarding/onboardingState";
import { ModelRowView, useModelDownload } from "./onboarding/ModelDownloadCard";
import {
  firstReviewWaitsForModel,
  missingStepsText,
  setupProgress,
  type SetupProgress,
} from "./onboarding/setupProgress";
import { failureText } from "./settings/NightlyRunSettings";
import { useEditorialJobActivity } from "./TrendJobIndicator";

const SPACE_LABEL = "Tendencias";

/**
 * The job the first-run surfaces follow: the one in flight, else the one `runNow` answered
 * until the job list has it, else the newest of the list. `runNow` is idempotent: a job
 * that runs or finished is answered as it is, a failed one starts again where it stopped.
 */
export function useFirstRun(environmentId: EnvironmentId) {
  const target = { environmentId, input: {} };
  const settings = useEnvironmentQuery(editorialJobsEnvironment.settings(target));
  const list = useEnvironmentQuery(editorialJobsEnvironment.list(target));
  const active = useEditorialJobActivity(environmentId);
  const runNow = useAtomCommand(editorialJobsEnvironment.runNow, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  const [answered, setAnswered] = useState<EditorialJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobs = list.data?.jobs ?? [];
  const latest =
    answered !== null && !jobs.some((job) => job.jobId === answered.jobId)
      ? answered
      : (jobs[0] ?? null);
  const start = async (): Promise<boolean> => {
    setStarting(true);
    setError(null);
    const result = await runNow({ environmentId, input: {} });
    setStarting(false);
    if (result._tag === "Failure") {
      setError(failureText(result));
      return false;
    }
    setAnswered(result.value);
    return true;
  };
  return {
    settings,
    active,
    latest,
    jobsKnown: list.data !== null,
    /** Jobs this server ran, the one `runNow` just answered included. */
    jobCount: jobs.length + (latest !== null && latest === answered ? 1 : 0),
    starting,
    error,
    start,
  };
}

/** The wizard's record on this server, for the empty inbox: unfinished, and where. */
function useSetupProgress(environmentId: EnvironmentId) {
  const status = useEnvironmentQuery(
    editorialOnboardingEnvironment.status({ environmentId, input: {} }),
  );
  return status.data === null ? null : setupProgress(status.data);
}

/**
 * Over the inbox list: the newest job imported this run but could not draft some of its
 * trends. Gone once every trend of the run has its drafted title, or while a job runs.
 */
export function DraftingNotice({
  environmentId,
  runId,
  undrafted,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
  /** Trends of the run still without a drafted presentation. */
  readonly undrafted: number;
}) {
  const list = useEnvironmentQuery(editorialJobsEnvironment.list({ environmentId, input: {} }));
  // Read only: the inbox's own `useEditorialJobActivity` refetches when the job ends.
  const active =
    AsyncResult.getOrElse(
      useAtomValue(editorialJobsEnvironment.activity({ environmentId, input: {} })),
      () => null,
    )?.active ?? null;
  const latest = list.data?.jobs[0] ?? null;
  if (active !== null || latest === null || latest.artifacts.runId !== runId || undrafted === 0) {
    return null;
  }
  const problem = draftingProblem(latest);
  if (problem === null) return null;
  return (
    <div
      role="status"
      data-testid="drafting-notice"
      className="mx-2 mb-2 flex flex-col gap-0.5 rounded-md border border-warning/32 bg-warning-surface px-2.5 py-2 text-2xs leading-4 text-warning-foreground"
    >
      <span>{problem.short}</span>
      <Link
        to={problem.link.to}
        {...(problem.link.hash === undefined ? {} : { hash: problem.link.hash })}
        className="self-start font-medium underline underline-offset-2"
      >
        {problem.link.label}
      </Link>
    </div>
  );
}

/**
 * The inbox header while it has no run: «Primera revisión» once one started, with a red dot
 * when it stopped; the message itself is on the page.
 */
export function FirstRunInboxLabel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const run = useFirstRun(environmentId);
  const view = firstRunView({
    active: run.active,
    latest: run.latest,
    emptyRun: false,
    jobsKnown: run.jobsKnown,
  });
  if (view.kind === "idle") return <>{SPACE_LABEL}</>;
  return (
    <span className="inline-flex items-center gap-1.5 uppercase tracking-wider">
      Primera revisión
      {view.kind === "failed" ? (
        <span role="img" aria-label="no terminó" className="size-1.5 rounded-full bg-error" />
      ) : null}
    </span>
  );
}

/** The empty inbox in the sidebar: one line while the review runs, the rest on the page. */
export function FirstRunCard({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
  readonly emptyRun?: boolean;
}) {
  const active = useEditorialJobActivity(environmentId);
  if (active === null) return null;
  return (
    <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
      Buscando tendencias…
    </p>
  );
}

/** The main area of Tendencias with its title bar, the content centred. */
function TrendsPageShell({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset
      {...workspaceAreaProps("editorial", 1, SPACE_LABEL)}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-muted-foreground/60">{SPACE_LABEL}</span>
        </WorkspacePageHeader>
        <Empty className="flex-1 overflow-y-auto">
          <div className="w-full max-w-xl px-6 py-10">{children}</div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

function CenteredMessage({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string | null;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 text-center" data-testid="trends-empty">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      {description === null ? null : (
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

function TechnicalDetail({ lines }: { readonly lines: ReadonlyArray<string> }) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        Detalle técnico
      </button>
      {open ? (
        <ul className="order-last basis-full font-mono text-2xs leading-relaxed break-words text-muted-foreground">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The review as a card: the five phases, live, with what failed and how to retry. */
function ReviewCard({
  view,
  first,
  starting,
  error,
  nightly,
  notes,
  onRun,
}: {
  readonly view: Exclude<FirstRunView, { kind: "idle" }>;
  readonly first: boolean;
  readonly starting: boolean;
  readonly error: string | null;
  readonly nightly: string | null;
  readonly notes: PhaseNotes;
  readonly onRun: () => void;
}) {
  const failure = view.kind === "failed" ? reviewFailure(view.job) : null;
  const title =
    view.kind === "running"
      ? first
        ? "Buscando tus primeras tendencias"
        : "Buscando tendencias"
      : view.kind === "failed"
        ? first
          ? "La primera revisión no terminó"
          : "La revisión no terminó"
        : view.kind === "empty"
          ? "La revisión terminó sin tendencias nuevas"
          : "La revisión terminó";
  const description =
    view.kind === "running"
      ? "Aparecerán aquí al terminar. Puedes seguir usando la app."
      : failure !== null
        ? [failure.headline, failure.kept === null ? null : "Lo leído quedó guardado."]
            .filter(Boolean)
            .join(" ")
        : view.kind === "empty"
          ? view.messages.join(" ")
          : "Cargando sus tendencias…";
  const canRun = view.kind === "failed" || (view.kind === "empty" && view.canRun);
  return (
    <section
      data-testid="first-run"
      data-kind={view.kind}
      aria-labelledby="first-review-title"
      className="rounded-xl border bg-card px-6 py-5 text-left"
    >
      <h1 id="first-review-title" className="text-base font-semibold text-foreground">
        {title}
      </h1>
      <p
        role={view.kind === "failed" ? "alert" : "status"}
        className="mt-1.5 text-sm leading-relaxed text-muted-foreground"
      >
        {description}
      </p>
      <div className="mt-3">
        <ReviewPhaseList job={view.job} notes={notes} />
      </div>
      {canRun || error !== null ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          {canRun ? (
            <Button disabled={starting} onClick={onRun}>
              {starting ? <Spinner size="sm" /> : <RotateCwIcon aria-hidden />}
              {view.kind === "failed" ? "Reintentar" : "Buscar de nuevo"}
            </Button>
          ) : null}
          {failure !== null ? <TechnicalDetail lines={failure.technical} /> : null}
          {view.kind === "failed" && nightly !== null ? (
            <span className="ms-auto text-xs text-muted-foreground">
              Si no, se reintenta {nightly}.
            </span>
          ) : null}
          {error !== null ? (
            <p role="alert" className="basis-full text-xs text-error-foreground">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export interface FirstRunPageViewProps {
  /** Null until the wizard's record is read. */
  readonly setup: SetupProgress | null;
  readonly view: FirstRunView;
  /** No review ran before this one. */
  readonly first: boolean;
  /** «esta noche a las 03:00»; null while the nightly review is off. */
  readonly nightly: string | null;
  readonly starting: boolean;
  readonly error: string | null;
  readonly jobsKnown: boolean;
  readonly modelReady: boolean;
  /** The first review starts by itself once the model is on disk (FinishSetupEntry). */
  readonly waitsForModel: boolean;
  /** The model's row, shown while it is missing. */
  readonly model: ReactNode;
  readonly notes: PhaseNotes;
  readonly onRun: () => void;
  readonly onContinueSetup: () => void;
}

/**
 * Tendencias before the inbox has trends: what is missing from the setup, the first review
 * as it runs or where it stopped, or the way to start one.
 */
export function FirstRunPageView({
  setup,
  view,
  first,
  nightly,
  starting,
  error,
  jobsKnown,
  modelReady,
  waitsForModel,
  model,
  notes,
  onRun,
  onContinueSetup,
}: FirstRunPageViewProps) {
  if (setup !== null && setup.pending && view.kind === "idle") {
    return (
      <CenteredMessage
        title="Aquí llegarán tus tendencias"
        description={missingStepsText(setup.reached)}
      >
        <Button className="mt-3" onClick={onContinueSetup}>
          Continuar
        </Button>
      </CenteredMessage>
    );
  }
  if (view.kind !== "idle") {
    return (
      <ReviewCard
        view={view}
        first={first}
        starting={starting}
        error={error}
        nightly={nightly}
        notes={notes}
        onRun={onRun}
      />
    );
  }
  const description = !modelReady
    ? waitsForModel
      ? "La primera revisión empieza sola al terminar de descargar el modelo local."
      : "Para buscarlas falta el modelo local."
    : nightly === null
      ? "Busca las primeras ahora. La revisión nocturna está apagada; se enciende en Ajustes."
      : `Busca las primeras ahora o espera a la revisión de ${nightly}.`;
  return (
    <CenteredMessage title="Aquí llegarán tus tendencias" description={description}>
      {modelReady ? (
        <Button className="mt-3" disabled={!jobsKnown || starting} onClick={onRun}>
          {starting ? <Spinner size="sm" /> : null}
          Buscar ahora
        </Button>
      ) : (
        <div className="mt-4 w-full text-left">{model}</div>
      )}
      {error !== null ? (
        <p role="alert" className="text-xs text-error-foreground">
          {error}
        </p>
      ) : null}
    </CenteredMessage>
  );
}

/** `FirstRunPageView` over this environment's wizard record, jobs and model. */
export function FirstRunPage({
  environmentId,
  emptyRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly emptyRun: boolean;
}) {
  const navigate = useNavigate();
  const setup = useSetupProgress(environmentId);
  const run = useFirstRun(environmentId);
  const model = useModelDownload(environmentId);
  const decisions = useEnvironmentQuery(
    editorialOnboardingEnvironment.list({ environmentId, input: {} }),
  );
  const nowMs = minuteClockMs(useNowMinute());
  const view = firstRunView({
    active: run.active,
    latest: run.latest,
    emptyRun,
    jobsKnown: run.jobsKnown,
  });
  const notes = usePhaseNotes(environmentId, view.kind === "idle" ? null : view.job);
  return (
    <TrendsPageShell>
      <FirstRunPageView
        setup={setup}
        view={view}
        first={run.jobCount <= 1}
        nightly={run.settings.data === null ? null : nextReviewText(run.settings.data, nowMs)}
        starting={run.starting}
        error={run.error}
        jobsKnown={run.jobsKnown}
        modelReady={model.ready}
        waitsForModel={firstReviewWaitsForModel(decisions.data?.acceptances ?? [])}
        model={
          <ModelRowView
            state={model.state}
            starting={model.starting}
            requestError={model.requestError}
            onDownload={model.onDownload}
          />
        }
        notes={notes}
        onRun={() => void run.start()}
        onContinueSetup={() => void navigate({ to: "/welcome" })}
      />
    </TrendsPageShell>
  );
}

/**
 * Over the brief cards the first time the inbox has trends: how many, what to do with them
 * and when the next review comes. Gone with the second review.
 */
export function FirstTrendsIntro({
  environmentId,
  inbox,
}: {
  readonly environmentId: EnvironmentId;
  readonly inbox: EditorialInbox;
}) {
  const target = { environmentId, input: {} };
  const list = useEnvironmentQuery(editorialJobsEnvironment.list(target));
  const settings = useEnvironmentQuery(editorialJobsEnvironment.settings(target));
  const nowMs = minuteClockMs(useNowMinute());
  const finished = (list.data?.jobs ?? []).filter((job) => job.artifacts.runId !== null);
  const runId = inbox.run?.runId ?? null;
  if (runId === null || finished.length !== 1 || finished[0]!.artifacts.runId !== runId) {
    return null;
  }
  const count = inbox.trends.filter(
    (trend) => trend.inbox?.dismissed == null && trend.inbox?.snoozed == null,
  ).length;
  const next = settings.data === null ? null : nextReviewText(settings.data, nowMs);
  return (
    <div
      data-testid="first-trends-intro"
      className="mb-8 flex flex-col items-center gap-2 py-6 text-center"
    >
      <ArrowLeftIcon aria-hidden className="size-5 text-primary" />
      <h2 className="text-lg font-semibold text-foreground">
        Tus primeras {count} {count === 1 ? "tendencia" : "tendencias"}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Abre una para ver por qué está aquí.
        {next === null ? null : ` Próxima revisión: ${next}.`}
      </p>
    </div>
  );
}
