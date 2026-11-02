import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_ONBOARDING_WS_METHODS,
  type EditorialOnboardingStep,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { ONBOARDING_STAGES, type OnboardingStepId } from "./steps";

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:onboarding",
  tag: EDITORIAL_ONBOARDING_WS_METHODS.list,
  staleTimeMs: 60_000,
});

const status = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:onboarding-status",
  tag: EDITORIAL_ONBOARDING_WS_METHODS.status,
  staleTimeMs: 60_000,
});

const refresh = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    registry.refresh(list({ environmentId, input: {} }));
    registry.refresh(status({ environmentId, input: {} }));
  });

/** The wizard's dated decisions per environment. A write refreshes the list and the status. */
export const editorialOnboardingEnvironment = {
  list,
  status,
  record: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:onboarding-record",
    tag: EDITORIAL_ONBOARDING_WS_METHODS.record,
    onSuccess: refresh,
  }),
  complete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:onboarding-complete",
    tag: EDITORIAL_ONBOARDING_WS_METHODS.complete,
    onSuccess: refresh,
  }),
};

/** The wizard's step ids are the contract's; this fails to compile if they drift apart. */
export const contractStep = (id: OnboardingStepId): EditorialOnboardingStep => id;

const STAGE_LABEL = new Map(ONBOARDING_STAGES.map((stage) => [stage.id, stage.label] as const));

export const stepLabel = (step: EditorialOnboardingStep): string => STAGE_LABEL.get(step) ?? step;

const ERROR_TEXT: Readonly<Record<string, string>> = {
  unavailable: "Los servicios editoriales no están montados en este servidor.",
  storage: "La base editorial no respondió.",
  "invalid-payload": "La decisión es demasiado grande para guardarse.",
};

/** Spanish for an onboarding error, by its `reason`. */
export function onboardingErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const text = ERROR_TEXT[String(error.reason)];
    if (text) return text;
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "EnvironmentAuthorizationError") {
      return "Esta sesión no tiene permiso para guardar decisiones.";
    }
  }
  return "Error desconocido.";
}
