import type { EnvironmentId } from "@t3tools/contracts";

import type { EditorialSpace } from "../spaceStore";

/**
 * Where the wizard leaves the operator: the Trends space of the local environment, also
 * remembered as its space so the next launch lands there. The root landing of this session
 * was already decided before the wizard opened, so "/" would show upstream's empty Threads.
 * Without a local environment there is no Trends space; the route's own exit is used.
 */
export async function leaveWizard(input: {
  readonly environmentId: EnvironmentId | null;
  /** Marks onboarding complete in the client settings; the first-run gate reads it. */
  readonly completeOnboarding: () => Promise<void>;
  readonly setSpace: (environmentId: EnvironmentId, space: EditorialSpace) => void;
  readonly openTrends: (environmentId: EnvironmentId) => Promise<void>;
  readonly fallback: () => void | Promise<void>;
}): Promise<boolean> {
  try {
    await input.completeOnboarding();
  } catch {
    return false;
  }
  if (input.environmentId === null) {
    await input.fallback();
    return true;
  }
  input.setSpace(input.environmentId, "trends");
  await input.openTrends(input.environmentId);
  return true;
}
