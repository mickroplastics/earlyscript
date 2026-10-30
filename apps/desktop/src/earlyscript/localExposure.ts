// Earlyscript-only: the `remoteAccess` hook on how the desktop backend is exposed at startup.
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

import type * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

/**
 * Without `remoteAccess` the backend starts local-only and without Tailscale Serve, even when
 * settings saved by an earlier build ask for network access or Serve.
 */
export const localOnlySettings = (
  settings: DesktopAppSettings.DesktopSettings,
): DesktopAppSettings.DesktopSettings =>
  earlyscriptFlags.remoteAccess
    ? settings
    : { ...settings, serverExposureMode: "local-only", tailscaleServeEnabled: false };
