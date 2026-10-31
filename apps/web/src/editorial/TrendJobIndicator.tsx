import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EditorialJob, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";

import { Spinner } from "../components/ui/spinner";
import { editorialJobsEnvironment, jobProgressText, refreshJobsList } from "./jobsState";
import { refreshEditorialInbox } from "./state";

/**
 * The nightly job in flight, pushed by the server. When a job ends the job list and the
 * inbox refetch, and titles drafted during the job show as they are written.
 */
export function useEditorialJobActivity(environmentId: EnvironmentId): EditorialJob | null {
  const registry = useContext(RegistryContext);
  const activity = AsyncResult.getOrElse(
    useAtomValue(editorialJobsEnvironment.activity({ environmentId, input: {} })),
    () => null,
  );
  const active = activity?.active ?? null;
  const activeId = active?.jobId ?? null;
  const drafted = active?.artifacts.presentations?.ready ?? 0;
  const previousId = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server pushes job changes; reads fetched before them refetch here.
  useEffect(() => {
    const previous = previousId.current;
    previousId.current = activeId;
    if (previous === activeId) return;
    Effect.runSync(refreshJobsList({ environmentId }, registry));
    if (previous !== null) refreshEditorialInbox(registry, environmentId);
  }, [activeId, environmentId, registry]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- titles the job drafts on the server reach the inbox read only by refetching it.
  useEffect(() => {
    if (drafted > 0) refreshEditorialInbox(registry, environmentId);
  }, [drafted, environmentId, registry]);
  return active;
}

/** "Corriendo: motor 2/5 · 3.072 de 11.913 textos…" in the Tendencias header while a job runs. */
export function TrendJobIndicator({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const active = useEditorialJobActivity(environmentId);
  if (active === null) return null;
  const text = `Corriendo: ${jobProgressText(active)}…`;
  return (
    <span
      role="status"
      className="flex min-w-0 max-w-[60%] shrink items-center gap-1 text-2xs text-sidebar-muted-foreground tabular-nums"
    >
      <span aria-hidden>
        <Spinner size="sm" />
      </span>
      <span className="truncate">{text}</span>
    </span>
  );
}
