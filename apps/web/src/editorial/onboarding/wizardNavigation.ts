/**
 * Navigation of the first-run wizard, apart from React: which step shows, which steps the
 * header lets the operator go back to, and the order of an acceptance (record, then advance).
 */

export interface WizardPosition {
  /** The step on screen. */
  readonly index: number;
  /** The furthest step reached; the header opens any step up to it. */
  readonly reached: number;
}

export const WIZARD_START: WizardPosition = { index: 0, reached: 0 };

export function wizardBack(position: WizardPosition): WizardPosition {
  return position.index === 0 ? position : { ...position, index: position.index - 1 };
}

export function wizardGoTo(position: WizardPosition, index: number): WizardPosition {
  return index < 0 || index > position.reached || index === position.index
    ? position
    : { ...position, index };
}

/** The position after the step on screen is accepted, or `finished` after the last one. */
export function wizardAdvance(
  position: WizardPosition,
  total: number,
): WizardPosition | "finished" {
  const next = position.index + 1;
  if (next >= total) return "finished";
  return { index: next, reached: Math.max(position.reached, next) };
}

export type AcceptOutcome<E> =
  | { readonly _tag: "moved"; readonly position: WizardPosition }
  | { readonly _tag: "finished" }
  | { readonly _tag: "failed"; readonly error: E };

/**
 * Stores the acceptance of the step on screen and only then moves on: a decision that was
 * not recorded never lets the operator past its step.
 */
export async function acceptStep<E>(input: {
  readonly position: WizardPosition;
  readonly total: number;
  readonly record: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: E }>;
}): Promise<AcceptOutcome<E>> {
  const recorded = await input.record();
  if (!recorded.ok) return { _tag: "failed", error: recorded.error };
  const next = wizardAdvance(input.position, input.total);
  return next === "finished" ? { _tag: "finished" } : { _tag: "moved", position: next };
}
