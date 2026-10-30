import type { EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { editorialClaimsRoot, type RootLandingClaim } from "./editorial.logic";
import { selectEnvironmentSpace, useSpaceStore } from "./spaceStore";

// One decision per app session, shared by `EditorialLanding` and the bootstrap guard of
// `__root.tsx`. Module state, not React state: StrictMode remounts must not reopen it.
let claim: RootLandingClaim = "pending";
let trackedRouter: AnyRouter | null = null;

export function readRootLandingClaim(): RootLandingClaim {
  return claim;
}

/** Records the landing's decision; only the first one counts. */
export function decideRootLanding(editorial: boolean) {
  if (claim === "pending") claim = editorial ? "editorial" : "upstream";
}

/** Closes the claim once the router leaves "/", so later visits to "/" stay upstream's. */
export function trackRootLanding(router: AnyRouter) {
  if (trackedRouter === router) return;
  trackedRouter = router;
  router.subscribe("onResolved", ({ toLocation }) => {
    if (claim === "editorial" && toLocation.pathname !== "/") claim = "done";
  });
}

/**
 * Guard for the welcome navigation of `__root.tsx`: true while the editorial landing owns "/"
 * for this environment, so the bootstrap thread does not overwrite the stored space.
 */
export function editorialClaimsBootstrapLanding(
  environmentId: EnvironmentId,
  pathname: string,
): boolean {
  return editorialClaimsRoot({
    pathname,
    claim,
    state: selectEnvironmentSpace(useSpaceStore.getState(), environmentId),
  });
}
