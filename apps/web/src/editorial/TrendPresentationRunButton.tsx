import { useAtomValue } from "@effect/atom-react";
import type { EditorialRunId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

import { SidebarHeaderIconButton } from "../components/sidebar/SidebarThreadHeader";
import { Spinner } from "../components/ui/spinner";
import { useAtomCommand } from "../state/use-atom-command";
import { runPresentationProgressText } from "./editorial.logic";
import { presentationEnvironment } from "./presentationState";

/**
 * "Redactar todas las de esta corrida": drafts every trend of the run on the server, two at
 * a time, skipping the ones already written. Progress stays in the header, as a count.
 */
export function TrendPresentationRunButton({
  environmentId,
  runId,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: EditorialRunId;
}) {
  const progress = AsyncResult.getOrElse(
    useAtomValue(presentationEnvironment.runProgress({ environmentId, input: { runId } })),
    () => null,
  );
  const ensureRun = useAtomCommand(presentationEnvironment.ensureRun);
  const [starting, setStarting] = useState(false);
  const running = starting || progress?.status === "running";
  const complete = progress !== null && progress.total > 0 && progress.ready === progress.total;
  const label = running
    ? `Redactando las tendencias de esta corrida${progress ? `: ${runPresentationProgressText(progress)}` : ""}`
    : complete
      ? `Todas las tendencias de esta corrida están redactadas (${progress.total})`
      : `Redactar todas las de esta corrida${progress && progress.ready + progress.failed > 0 ? ` (${runPresentationProgressText(progress)})` : ""}`;
  return (
    <>
      {running && progress ? (
        <span aria-hidden className="text-2xs text-sidebar-muted-foreground tabular-nums">
          {progress.ready}/{progress.total}
        </span>
      ) : null}
      <SidebarHeaderIconButton
        label={label}
        disabled={running}
        onClick={() => {
          setStarting(true);
          void ensureRun({ environmentId, input: { runId } }).then(() => setStarting(false));
        }}
      >
        {running ? <Spinner size="sm" /> : <SparklesIcon className="size-4" />}
      </SidebarHeaderIconButton>
    </>
  );
}
