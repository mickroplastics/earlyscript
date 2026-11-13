import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { toastManager } from "../../components/ui/toast";
import { completeOnboarding } from "../../onboarding/firstRun";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSpaceStore } from "../spaceStore";
import { EarlyscriptWizardView, type WizardEntry } from "./EarlyscriptWizardView";
import { leaveWizard } from "./wizardExit";
import {
  contractStep,
  editorialOnboardingEnvironment,
  onboardingErrorText,
} from "./onboardingState";
import { setupProgress } from "./setupProgress";

function failureText(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag === "Success") return "";
  if (isAtomCommandInterrupted(result)) return "Se canceló.";
  return onboardingErrorText(squashAtomCommandFailure(result));
}

/**
 * The first-run wizard of the `/welcome` route; each accepted step is a dated decision on the
 * server. «Seguir más tarde» marks only the client, so the app opens while the server still
 * reads the wizard as unfinished: the sidebar offers to finish it at the first step not accepted.
 */
export function EarlyscriptWizard({
  localAvailable,
  onDone,
}: {
  readonly localAvailable: boolean;
  /** Accepted for the route's signature; Earlyscript has no Connect step to resume. */
  readonly resumeEnvironmentId?: EnvironmentId | undefined;
  readonly onDone: (projectRef?: ScopedProjectRef) => void | Promise<void>;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = localAvailable ? primaryEnvironmentId : null;
  const status = useEnvironmentQuery(
    environmentId === null
      ? null
      : editorialOnboardingEnvironment.status({ environmentId, input: {} }),
  );
  const quiet = { reportFailure: false } as const;
  const record = useAtomCommand(editorialOnboardingEnvironment.record, quiet);
  const complete = useAtomCommand(editorialOnboardingEnvironment.complete, quiet);

  const navigate = useNavigate();
  const setSpace = useSpaceStore((state) => state.setSpace);

  // The client mark keeps the first-run gate from sending the operator back to /welcome.
  const leave = async () => {
    const left = await leaveWizard({
      environmentId,
      completeOnboarding,
      setSpace,
      openTrends: (id) =>
        navigate({
          to: "/editorial/$environmentId/trends",
          params: { environmentId: id },
          replace: true,
        }),
      fallback: () => onDone(),
    });
    if (!left) {
      toastManager.add({
        type: "error",
        title: "No se pudo cerrar el asistente",
        description: "No se guardaron los ajustes de esta ventana. Vuelve a intentarlo.",
      });
    }
    return left;
  };

  // The entry is decided once the status is read; an unreadable status opens the welcome.
  if (environmentId !== null && status.data === null && status.error === null) return null;
  const progress = status.data === null ? null : setupProgress(status.data);
  const entry: WizardEntry =
    progress !== null && progress.pending && progress.reached > 0
      ? { _tag: "resume", position: { index: progress.reached, reached: progress.reached } }
      : { _tag: "welcome" };

  return (
    <EarlyscriptWizardView
      environmentId={environmentId}
      entry={entry}
      finishedBefore={progress !== null && !progress.pending}
      onRecord={async (step, acceptance) => {
        if (environmentId === null) return { ok: false, error: "No hay servidor local." };
        const result = await record({
          environmentId,
          input: { step: contractStep(step), payload: acceptance },
        });
        return result._tag === "Success" ? { ok: true } : { ok: false, error: failureText(result) };
      }}
      onFinish={async () => {
        if (environmentId === null) return false;
        const result = await complete({ environmentId, input: {} });
        if (result._tag !== "Success") {
          toastManager.add({
            type: "error",
            title: "No se pudo terminar el asistente",
            description: failureText(result),
          });
          return false;
        }
        return leave();
      }}
      onLeave={() => void leave()}
    />
  );
}
