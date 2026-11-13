import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";

import { SidebarGroup } from "../components/ui/sidebar";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { editorialJobsEnvironment } from "./jobsState";
import { useModelDownload } from "./onboarding/ModelDownloadCard";
import { editorialOnboardingEnvironment } from "./onboarding/onboardingState";
import {
  firstReviewWaitsForModel,
  followsUnfinishedSetup,
  setupProgress,
  stepCaption,
} from "./onboarding/setupProgress";
import { failureText } from "./settings/NightlyRunSettings";
import { useTrendInbox } from "./TrendInbox";

/**
 * Starts the first review once the local model is on disk: mounted only while the operator
 * asked for it and no review ran yet. A failed start is said here, with «Reintentar»; it is
 * not repeated by itself.
 */
export function FirstReviewAutoStart({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const model = useModelDownload(environmentId);
  const runNow = useAtomCommand(editorialJobsEnvironment.runNow, { reportFailure: false });
  // Set while a request is in flight and after the server confirmed the job.
  const claimed = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    if (claimed.current) return;
    claimed.current = true;
    setError(null);
    void runNow({ environmentId, input: {} }).then((result) => {
      if (result._tag === "Success") return;
      claimed.current = false;
      setError(failureText(result));
    });
  };
  const ready = model.ready;
  const tried = error !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the pushed model state turning ready is what starts the first review
  useEffect(() => {
    if (ready && !tried) start();
  }, [ready, tried, start]);
  if (error === null) return null;
  return (
    <SidebarGroup className="order-1 shrink-0">
      <div
        role="alert"
        className="flex flex-col gap-1.5 rounded-lg border border-error/32 bg-error-surface px-2.5 py-2 text-xs text-error-foreground"
      >
        <span>No se pudo empezar la primera revisión. {error}</span>
        <Button size="xs" variant="outline" className="self-start" onClick={start}>
          Reintentar
        </Button>
      </div>
    </SidebarGroup>
  );
}

/**
 * «Terminar de configurar» under the space tabs while the wizard was left with «Seguir más
 * tarde»: it reopens the wizard at the step reached and goes away once it is finished.
 */
export function FinishSetupEntry({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const target = { environmentId, input: {} };
  const status = useEnvironmentQuery(editorialOnboardingEnvironment.status(target));
  const decisions = useEnvironmentQuery(editorialOnboardingEnvironment.list(target));
  const jobs = useEnvironmentQuery(editorialJobsEnvironment.list(target));
  const progress = status.data === null ? null : setupProgress(status.data);
  // Behind the open wizard the entry would only repeat it.
  const wizardOpen = useLocation({ select: (location) => location.pathname === "/welcome" });
  const inbox = AsyncResult.getOrElse(useTrendInbox(environmentId, "new-first-growth"), () => null);
  const jobCount = jobs.data === null ? null : jobs.data.jobs.length;
  // An installation already in use (reviews or jobs from before the wizard was recorded) is
  // not taken back to the setup.
  const followsSetup = followsUnfinishedSetup({
    progress,
    recorded: decisions.data === null ? null : decisions.data.acceptances.length,
    jobCount,
    hasRun: inbox === null ? null : inbox.run !== null,
  });
  // Finished waiting for the model, or left with «Seguir más tarde» on the nightly step: the
  // operator consented and reached the review, which then starts once the model is there.
  const waitsForModel =
    progress !== null &&
    jobCount === 0 &&
    inbox?.run === null &&
    (progress.pending
      ? followsSetup && progress.reached === 3
      : firstReviewWaitsForModel(decisions.data?.acceptances ?? []));
  return (
    <>
      {/* The open wizard's nightly step starts it itself. */}
      {waitsForModel && !wizardOpen ? <FirstReviewAutoStart environmentId={environmentId} /> : null}
      {progress !== null && followsSetup && !wizardOpen ? (
        <SidebarGroup className="order-1 shrink-0">
          <Link
            to="/welcome"
            data-testid="finish-setup"
            className="flex flex-col gap-0.5 rounded-lg border border-primary/40 bg-primary/8 px-2.5 py-2 outline-none hover:bg-primary/12 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <span className="text-sm text-primary">Terminar de configurar</span>
            <span className="text-xs text-muted-foreground">{stepCaption(progress.reached)}</span>
          </Link>
        </SidebarGroup>
      ) : null}
    </>
  );
}
