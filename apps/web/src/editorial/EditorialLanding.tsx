import { Navigate, useRouter } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { resolveLandingTarget } from "./editorial.logic";
import { decideRootLanding, readRootLandingClaim, trackRootLanding } from "./rootLanding";
import { selectEnvironmentSpace, useSpaceStore } from "./spaceStore";

/**
 * Opens the root in the space the user left; otherwise renders upstream's landing. The root
 * decides once per app session (`rootLanding.ts`); later visits to "/" (the brand link) keep
 * upstream's behavior, so a space switch never bounces the user back.
 */
export function EditorialLanding({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const { isReady } = useEnvironments();
  const environmentId = usePrimaryEnvironmentId();
  const spaceState = useSpaceStore((state) => selectEnvironmentSpace(state, environmentId));
  const decidable = isReady || environmentId !== null;
  const claim = readRootLandingClaim();
  const target =
    claim === "upstream" || claim === "done" || environmentId === null
      ? null
      : resolveLandingTarget(spaceState);
  const claimsRoot = target !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records this session's landing decision in module state shared with __root
  useEffect(() => {
    trackRootLanding(router);
    if (decidable) decideRootLanding(claimsRoot);
  }, [claimsRoot, decidable, router]);

  // Until the catalog knows the primary environment, upstream's landing must not start a draft.
  if (!decidable && claim === "pending") return null;
  if (target === null || environmentId === null) return children;
  if (target.space === "results") {
    return <Navigate to="/editorial/$environmentId/results" params={{ environmentId }} replace />;
  }
  return target.trend ? (
    <Navigate
      to="/editorial/$environmentId/trends/$dossierId"
      params={{ environmentId, dossierId: target.trend.dossierId }}
      search={target.trend.runId ? { run: target.trend.runId } : {}}
      replace
    />
  ) : (
    <Navigate to="/editorial/$environmentId/trends" params={{ environmentId }} replace />
  );
}
