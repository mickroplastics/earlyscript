import type { EnvironmentId } from "@t3tools/contracts";
import { MoonIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useNightlyStatus } from "./editorialStatus";

function NightlyDot({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { state } = useNightlyStatus(environmentId);
  if (state._tag !== "running" && state._tag !== "failed") return null;
  const running = state._tag === "running";
  return (
    // The menu item is the positioned box: the dot sits at the row's end, after the label.
    <span
      data-testid="nightly-nav-dot"
      className={`pointer-events-none absolute top-1/2 right-3 size-1.5 -translate-y-1/2 rounded-full ${running ? "bg-info" : "bg-destructive"}`}
    >
      <span className="sr-only">{running ? "en curso" : "falló"}</span>
    </span>
  );
}

/** «Revisión nocturna» in the Settings sidebar: a moon, and a dot while it runs or after it failed. */
export function NightlyNavIcon({ className }: { readonly className?: string }) {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <>
      <MoonIcon className={className} />
      {environmentId === null ? null : <NightlyDot environmentId={environmentId} />}
    </>
  );
}
