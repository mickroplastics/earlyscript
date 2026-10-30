// Earlyscript-only: the `remoteAccess` flag. The Connections and Access settings routes import their
// page from here instead of its own module (one-line hooks in docs/upstream-divergence.md).
import { Navigate } from "@tanstack/react-router";
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import type { ComponentProps } from "react";

import { ConnectionsSettings as UpstreamConnectionsSettings } from "../components/settings/ConnectionsSettings";

export function ConnectionsSettingsDisabled(
  _props: ComponentProps<typeof UpstreamConnectionsSettings>,
) {
  return <Navigate to="/settings/general" replace />;
}

/** Without `remoteAccess` Settings > Connections and Settings > Access send the user to General. */
export const ConnectionsSettings = earlyscriptFlags.remoteAccess
  ? UpstreamConnectionsSettings
  : ConnectionsSettingsDisabled;
