import type { EditorialJob, EditorialNightlySettings, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import {
  CheckIcon,
  CircleIcon,
  MinusIcon,
  PlayIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import {
  draftingProblem,
  firstRunPhaseRows,
  firstRunView,
  minuteClockMs,
  phaseRowName,
  type FirstRunPhaseRow,
  type FirstRunView,
} from "./firstRun.logic";
import { editorialJobsEnvironment } from "./jobsState";
import { failureText, nextRunText } from "./settings/NightlyRunSettings";
import { EDITORIAL_NIGHTLY_SECTION_ID, EDITORIAL_SETTINGS_PATH } from "./settings/settingsEntry";
import { useEditorialJobActivity } from "./TrendJobIndicator";

type Density = "sidebar" | "page";

function PhaseIcon({ status }: { readonly status: FirstRunPhaseRow["status"] }) {
  switch (status) {
    case "pending":
      return <CircleIcon className="size-3 text-muted-foreground/40" />;
    case "running":
      return (
        <span className="flex text-info">
          <Spinner size="sm" />
        </span>
      );
    case "done":
      return <CheckIcon className="size-3.5 text-success" />;
    case "skipped":
      return <MinusIcon className="size-3.5 text-muted-foreground" />;
    case "failed":
      return <XIcon className="size-3.5 text-error" />;
  }
}

/** The five phases of a job as a fixed list: rows keep their height while the job advances. */
function FirstRunPhases({
  job,
  density = "page",
}: {
  readonly job: EditorialJob | null;
  readonly density?: Density;
}) {
  const now = useNowMinute();
  return (
    <ol
      aria-label="Fases de la corrida"
      className={cn("flex flex-col", density === "sidebar" ? "text-xs" : "text-sm")}
    >
      {firstRunPhaseRows(job, minuteClockMs(now)).map((row) => (
        <li
          key={row.phase}
          aria-label={phaseRowName(row)}
          data-phase={row.phase}
          data-status={row.status}
          className={cn(
            "flex min-w-0 items-center gap-2",
            density === "sidebar" ? "h-6" : "h-7",
            row.status === "pending" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
            {row.warning ? (
              <TriangleAlertIcon className="size-3.5 text-warning" />
            ) : (
              <PhaseIcon status={row.status} />
            )}
          </span>
          <span className="shrink-0">{row.label}</span>
          <span className="min-w-0 flex-1 truncate text-end text-xs text-muted-foreground tabular-nums">
            {(density === "sidebar" ? row.compactDetail : row.detail) ??
              (row.status === "skipped" ? "omitida" : "")}
          </span>
        </li>
      ))}
    </ol>
  );
}

const TITLE: Readonly<Record<FirstRunView["kind"], string>> = {
  idle: "Todavía no hay tendencias",
  running: "Corrida en curso",
  failed: "La corrida falló",
  empty: "La corrida terminó sin tendencias nuevas",
  done: "La corrida terminó",
};

const IDLE_TEXT =
  "Una corrida captura las fuentes activas, agrupa sus publicaciones en tendencias, las importa y las redacta. Cada corrida queda registrada.";

const RUNNING_TEXT =
  "La primera corrida procesa todo el corpus y tarda más que las siguientes. Las tendencias aparecen aquí cuando termina la importación.";

/** What the nightly run will do next, with a way to turn it on when it is off. */
export function NightlyNote({
  settings,
  density = "page",
}: {
  readonly settings: EditorialNightlySettings | null;
  readonly density?: Density;
}) {
  if (settings === null) return null;
  const className = cn(
    "text-muted-foreground",
    density === "sidebar" ? "text-2xs leading-4" : "text-xs",
  );
  if (settings.enabled) return <p className={className}>{nextRunText(settings)}</p>;
  return (
    <p className={className}>
      La corrida nocturna está desactivada. Puedes activarla en{" "}
      <Link
        to={EDITORIAL_SETTINGS_PATH}
        hash={EDITORIAL_NIGHTLY_SECTION_ID}
        className="whitespace-nowrap text-foreground underline underline-offset-2 hover:text-primary"
      >
        Ajustes › Editorial
      </Link>
      .
    </p>
  );
}

export interface FirstRunPanelProps {
  readonly view: FirstRunView;
  readonly starting: boolean;
  /** Why the last «Ejecutar» click did not start a job, in Spanish. */
  readonly error: string | null;
  readonly onRun: () => void;
  /** Label of the button that starts a job from the idle state. */
  readonly runLabel: string;
  /** When set, the run button is disabled and this says why (the model is missing). */
  readonly blockedReason?: string | null;
  readonly density?: Density;
  /** Shown under the actions: the nightly note, a link. */
  readonly footer?: ReactNode;
  /** Hide the title and explanation, for a host that has its own (the wizard step). */
  readonly bare?: boolean;
  /** What a finished job with trends says; null shows the inbox refetching them. */
  readonly doneNote?: string | null;
}

/** The first run of the engine as a card: offer, live phases, failure, an empty result. */
export function FirstRunPanel({
  view,
  starting,
  error,
  onRun,
  runLabel,
  blockedReason = null,
  density = "page",
  footer,
  bare = false,
  doneNote = null,
}: FirstRunPanelProps) {
  const job = view.kind === "idle" ? null : view.job;
  const messages = view.kind === "idle" || view.kind === "running" ? [] : view.messages;
  const canRun =
    view.kind === "idle" || view.kind === "failed" || (view.kind === "empty" && view.canRun);
  const sidebar = density === "sidebar";
  return (
    <div
      data-testid="first-run"
      data-kind={view.kind}
      className={cn("flex w-full min-w-0 flex-col", sidebar ? "gap-2.5" : "gap-3")}
    >
      {bare ? null : (
        <div className="flex flex-col gap-1">
          <p
            role={view.kind === "failed" ? "alert" : undefined}
            className={cn(
              "font-medium text-foreground",
              sidebar ? "text-xs" : "text-sm",
              view.kind === "failed" && "text-error-foreground",
            )}
          >
            {TITLE[view.kind]}
          </p>
          {view.kind === "idle" || view.kind === "running" ? (
            <p
              className={cn(
                "text-muted-foreground",
                sidebar ? "text-2xs leading-4" : "text-xs leading-relaxed",
              )}
            >
              {view.kind === "idle" ? IDLE_TEXT : RUNNING_TEXT}
            </p>
          ) : null}
        </div>
      )}
      {job !== null ? <FirstRunPhases job={job} density={density} /> : null}
      {view.kind === "done" ? (
        doneNote === null ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="flex">
              <Spinner size="xs" tone="muted" />
            </span>
            Cargando sus tendencias…
          </p>
        ) : (
          <p role="status" className="text-xs text-foreground">
            {doneNote}
          </p>
        )
      ) : null}
      {messages.length > 0 ? (
        <ul
          className={cn(
            "flex flex-col gap-1 rounded-md border px-2.5 py-2",
            sidebar ? "text-2xs leading-4" : "text-xs leading-relaxed",
            view.kind === "failed"
              ? "border-error/32 bg-error-surface text-error-foreground"
              : "border-border text-muted-foreground",
          )}
        >
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}
      {canRun ? (
        <div className="flex flex-col gap-1.5">
          <Button
            size={sidebar ? "sm" : "default"}
            variant={view.kind === "failed" ? "outline" : "default"}
            className={sidebar ? "w-full" : "self-start"}
            disabled={starting || blockedReason !== null}
            onClick={onRun}
          >
            {starting ? (
              <span aria-hidden className="flex">
                <Spinner size="sm" />
              </span>
            ) : view.kind === "failed" ? (
              <RotateCwIcon aria-hidden />
            ) : (
              <PlayIcon aria-hidden />
            )}
            {view.kind === "failed"
              ? "Reintentar"
              : view.kind === "empty"
                ? "Ejecutar una corrida"
                : runLabel}
          </Button>
          {blockedReason !== null ? (
            <p className="text-xs text-muted-foreground">{blockedReason}</p>
          ) : null}
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-xs text-error-foreground">
          {error}
        </p>
      ) : null}
      {footer}
    </div>
  );
}

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
  return { settings, active, latest, jobsKnown: list.data !== null, starting, error, start };
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

/** The empty Tendencias inbox: the first run from the sidebar, then its live phases. */
export function FirstRunCard({
  environmentId,
  emptyRun,
}: {
  readonly environmentId: EnvironmentId;
  readonly emptyRun: boolean;
}) {
  const run = useFirstRun(environmentId);
  const view = firstRunView({
    active: run.active,
    latest: run.latest,
    emptyRun,
    jobsKnown: run.jobsKnown,
  });
  return (
    <FirstRunPanel
      view={view}
      starting={run.starting}
      error={run.error}
      onRun={() => void run.start()}
      runLabel="Ejecutar la primera corrida"
      density="sidebar"
      footer={<NightlyNote settings={run.settings.data} density="sidebar" />}
    />
  );
}
