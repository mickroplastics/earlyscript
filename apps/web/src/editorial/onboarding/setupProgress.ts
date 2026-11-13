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
