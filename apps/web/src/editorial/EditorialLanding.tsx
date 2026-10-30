import { Navigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { resolveLandingTarget } from "./editorial.logic";
import { selectEnvironmentSpace, useSpaceStore } from "./spaceStore";

// The root decides once per app session; later visits to "/" (the brand link) keep upstream's
// behavior, so a space switch never bounces the user back.
let landingDecided = false;

/** Opens the root in the space the user left; otherwise renders upstream's landing. */
export function EditorialLanding({ children }: { readonly children: ReactNode }) {
  const { isReady } = useEnvironments();
  const environmentId = usePrimaryEnvironmentId();
  const spaceState = useSpaceStore((state) => selectEnvironmentSpace(state, environmentId));
  const decidable = isReady || environmentId !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records that this session already landed
  useEffect(() => {
    if (decidable) landingDecided = true;
  }, [decidable]);

  // Until the catalog knows the primary environment, upstream's landing must not start a draft.
  if (!decidable && !landingDecided) return null;
  const target = landingDecided || environmentId === null ? null : resolveLandingTarget(spaceState);
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
