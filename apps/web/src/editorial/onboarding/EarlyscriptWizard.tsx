import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { toastManager } from "../../components/ui/toast";
import { useClientSettings } from "../../hooks/useSettings";
import { completeOnboarding } from "../../onboarding/firstRun";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSpaceStore } from "../spaceStore";
import { EarlyscriptWizardView } from "./EarlyscriptWizardView";
import { leaveWizard } from "./wizardExit";
import {
  contractStep,
  editorialOnboardingEnvironment,
  onboardingErrorText,
} from "./onboardingState";

function failureText(result: AtomCommandResult<unknown, unknown>): string {
  if (result._tag === "Success") return "";
  if (isAtomCommandInterrupted(result)) return "Se canceló.";
  return onboardingErrorText(squashAtomCommandFailure(result));
}

/**
 * Earlyscript's first-run wizard, mounted by the `/welcome` route in place of T3 Code's.
 * Every accepted step is recorded on the server as a dated decision; finishing records the
 * completion there and marks onboarding complete in the client settings, as upstream does.
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
  const completedAt = useClientSettings((settings) => settings.onboardingCompletedAt);
  // Decided once: finishing the first run must not turn the close button on mid-wizard.
  const [dismissible] = useState(() => completedAt !== null);
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

  return (
    <EarlyscriptWizardView
      environmentId={environmentId}
      dismissible={dismissible}
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
