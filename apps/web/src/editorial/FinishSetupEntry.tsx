import type { EnvironmentId } from "@t3tools/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { SidebarGroup } from "../components/ui/sidebar";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { editorialJobsEnvironment } from "./jobsState";
import { useModelDownload } from "./onboarding/ModelDownloadCard";
import { editorialOnboardingEnvironment } from "./onboarding/onboardingState";
import { firstReviewWaitsForModel, setupProgress, stepCaption } from "./onboarding/setupProgress";

/**
 * Starts the first review once the local model is on disk: mounted only while the operator
 * finished the wizard before the download ended and no review ran yet.
 */
function FirstReviewAutoStart({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const model = useModelDownload(environmentId);
  const runNow = useAtomCommand(editorialJobsEnvironment.runNow, { reportFailure: false });
  const started = useRef(false);
  const ready = model.ready;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the pushed model state turning ready is what starts the first review, once per session
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    void runNow({ environmentId, input: {} });
  }, [environmentId, ready, runNow]);
  return null;
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
  const waitsForModel =
    progress !== null &&
    !progress.pending &&
    jobs.data !== null &&
    jobs.data.jobs.length === 0 &&
    firstReviewWaitsForModel(decisions.data?.acceptances ?? []);
  return (
    <>
      {waitsForModel ? <FirstReviewAutoStart environmentId={environmentId} /> : null}
      {progress !== null && progress.pending && !wizardOpen ? (
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
