import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Earlyscript's first-run wizard: four steps the operator completes once. Each step lives
 * in its own file (see README.md) and talks to its own RPC group; the wizard shell owns
 * navigation and records every acceptance as a dated decision.
 */
export type OnboardingStepId = "datos" | "proveedores" | "estudio" | "motor";

export interface OnboardingStage {
  readonly id: OnboardingStepId;
  /** Short label in the stage header. */
  readonly label: string;
}

/** In order. */
export const ONBOARDING_STAGES: ReadonlyArray<OnboardingStage> = [
  { id: "datos", label: "Datos y permisos" },
  { id: "proveedores", label: "Proveedores" },
  { id: "estudio", label: "Estudio" },
  { id: "motor", label: "Motor y nocturna" },
];

/** What the shell hands to every step. */
export interface OnboardingStepProps {
  readonly environmentId: EnvironmentId;
  /**
   * The step calls this once its own data is saved. `acceptance` is what the operator
   * accepted, stored by the shell as a dated decision (JSON-serialisable, keep it small:
   * ids, booleans, a hash; never raw texts). The shell then advances.
   */
  readonly onContinue: (acceptance: Readonly<Record<string, unknown>>) => void;
  /** Null on the first step. */
  readonly onBack: (() => void) | null;
}
