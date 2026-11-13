import type { EditorialOnboardingAcceptance, EditorialOnboardingStatus } from "@t3tools/contracts";

import { ONBOARDING_STAGES } from "./steps";

/**
 * Where an unfinished first run stands, from the server's record of the wizard: the wizard
 * reopens there and the sidebar offers «Terminar de configurar» until it is finished.
 */
export interface SetupProgress {
  /** The wizard was never finished on this server. */
  readonly pending: boolean;
  /** The first step not yet accepted, in wizard order; the last one when all were. */
  readonly reached: number;
}

export function setupProgress(status: EditorialOnboardingStatus): SetupProgress {
  const accepted = new Set(
    status.steps.filter((step) => step.lastAcceptedAt !== null).map((step) => step.step),
  );
  const first = ONBOARDING_STAGES.findIndex((stage) => !accepted.has(stage.id));
  return {
    pending: status.completedAt === null,
    reached: first === -1 ? ONBOARDING_STAGES.length - 1 : first,
  };
}

/** The steps still missing, as the empty inbox names them. */
const MISSING_NAMES = ["tus datos", "el asistente de IA", "tu canal", "la revisión nocturna"];

/** «Faltan tu canal y la revisión nocturna.» from the first step not accepted. */
export function missingStepsText(reached: number): string {
  const names = MISSING_NAMES.slice(Math.max(0, reached));
  if (names.length <= 1) return `Falta ${names[0] ?? MISSING_NAMES.at(-1)}.`;
  return `Faltan ${names.slice(0, -1).join(", ")} y ${names.at(-1)}.`;
}

/** «Paso 3 de 4 · Tu canal» */
export function stepCaption(index: number): string {
  const stage = ONBOARDING_STAGES[index] ?? ONBOARDING_STAGES.at(-1)!;
  return `Paso ${index + 1} de ${ONBOARDING_STAGES.length} · ${stage.label}`;
}

/**
 * True when the operator finished the nightly step while the local model was still missing and
 * no review had started: the first review then starts by itself once the model is on disk.
 */
export function firstReviewWaitsForModel(
  acceptances: ReadonlyArray<EditorialOnboardingAcceptance>,
): boolean {
  const last = acceptances.findLast((acceptance) => acceptance.step === "motor");
  if (last === undefined) return false;
  return last.payload.modelReady === false && last.payload.firstRunStarted === false;
}

/**
 * Whether the app outside the wizard follows an unfinished setup («Terminar de configurar», the
 * first review on the model): when this installation recorded a step of the wizard, or is new
 * (no review, no job). One in use from before the wizard was recorded is left alone; Settings
 * still reopens the wizard.
 */
export function followsUnfinishedSetup(input: {
  readonly progress: SetupProgress | null;
  /** Steps of the wizard recorded on this server; null while unknown. */
  readonly recorded: number | null;
  readonly jobCount: number | null;
  readonly hasRun: boolean | null;
}): boolean {
  if (input.progress === null || !input.progress.pending || input.recorded === null) return false;
  return input.recorded > 0 || (input.jobCount === 0 && input.hasRun === false);
}
