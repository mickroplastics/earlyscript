import { SOURCE_CATALOG, isCatalogSourceId } from "@earlyscript/editorial-contracts/sourceCatalog";
import type { EditorialJob, EditorialJobPhaseName, EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, MinusIcon, TriangleAlertIcon } from "lucide-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import {
  firstRunPhaseRows,
  minuteClockMs,
  phaseRowName,
  type FirstRunPhaseRow,
} from "./firstRun.logic";
import { NIGHTLY_DRAFTS } from "./onboarding/onboardingExamples";
import { SOURCE_DIGEST } from "./onboarding/consentSummary";
import { readyDraftingProviders } from "./onboarding/providersStep.logic";
import { editorialSourcesEnvironment } from "./settings/sourcesState";

/** The line under a phase: which sources it reads, where it groups, who drafts. */
export type PhaseNotes = Partial<Record<EditorialJobPhaseName, string>>;

const sourceName = (id: string) =>
  isCatalogSourceId(id) ? (SOURCE_DIGEST[id]?.name ?? SOURCE_CATALOG[id].name) : id;

/**
 * The notes of the five phases on this environment: the sources the job reads (or, before
 * any job, the sources switched on) and the model that drafts the titles.
 */
export function usePhaseNotes(environmentId: EnvironmentId, job: EditorialJob | null): PhaseNotes {
  const sources = useEnvironmentQuery(
    job === null ? editorialSourcesEnvironment.list({ environmentId, input: {} }) : null,
  );
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const read =
    job !== null
      ? job.artifacts.sources.collect
      : (sources.data?.sources.filter((entry) => entry.collect).map((entry) => entry.source) ?? []);
  const selection = config?.settings.textGenerationModelSelection ?? null;
  const provider =
    selection === null
      ? undefined
      : readyDraftingProviders(providers ?? null).find(
          (candidate) => candidate.instanceId === selection.instanceId,
        );
  const model = provider?.models.find((candidate) => candidate.slug === selection?.model);
  return {
    ...(read.length > 0 ? { collect: read.map(sourceName).join(", ") } : {}),
    run: "Agrupa en tu equipo, sin enviar nada",
    ...(providers === undefined || providers === null
      ? {}
      : {
          presentations:
            model === undefined
              ? "Sin asistente de IA: llegan sin título"
              : `Con ${model.name}, hasta ${NIGHTLY_DRAFTS}`,
        }),
  };
}

function PhaseMark({ row }: { readonly row: FirstRunPhaseRow }) {
  const base = "flex size-[1.125rem] shrink-0 items-center justify-center rounded-full";
  if (row.warning) {
    return (
      <span className={cn(base, "text-warning")}>
        <TriangleAlertIcon className="size-3.5" />
      </span>
    );
  }
  switch (row.status) {
    case "pending":
      return <span className={cn(base, "border border-foreground/20")} />;
    case "running":
      return (
        <span className={cn(base, "border-2 border-primary ring-2 ring-primary/25")}>
          <span className="size-1.5 rounded-full bg-primary" />
        </span>
      );
    case "done":
      return (
        <span className={cn(base, "bg-success text-background")}>
          <CheckIcon className="size-3" strokeWidth={3} />
        </span>
      );
    case "skipped":
      return (
        <span className={cn(base, "border border-foreground/20 text-muted-foreground")}>
          <MinusIcon className="size-3" />
        </span>
      );
    case "failed":
      return <span className={cn(base, "bg-error text-3xs font-bold text-background")}>!</span>;
  }
}

/**
 * The five phases of a review as one list: before the first review it explains what happens
 * each night; with a job it is the live progress, rows keeping their height as it advances.
 */
export function ReviewPhaseList({
  job,
  notes,
}: {
  readonly job: EditorialJob | null;
  readonly notes: PhaseNotes;
}) {
  const now = useNowMinute();
  return (
    <ol aria-label="Fases de la revisión" className="flex flex-col">
      {firstRunPhaseRows(job, minuteClockMs(now)).map((row) => {
        const note = notes[row.phase];
        const active = row.status !== "pending" && row.status !== "skipped";
        return (
          <li
            key={row.phase}
            aria-label={phaseRowName(row)}
            data-phase={row.phase}
            data-status={row.status}
            className="flex min-w-0 items-start gap-3 border-t border-dashed py-3 first:border-t-0"
          >
            <span aria-hidden className="pt-px">
              <PhaseMark row={row} />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block text-sm",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {row.label}
              </span>
              {note === undefined ? null : (
                <span className="mt-0.5 block text-xs text-muted-foreground">{note}</span>
              )}
            </span>
            {row.compactDetail === null ? null : (
              <span className="shrink-0 pt-0.5 text-end text-xs text-muted-foreground tabular-nums">
                {row.compactDetail}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
