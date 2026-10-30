// Earlyscript-only: the `remoteAccess` hook on the desktop exposure setters. DesktopIpcHandlers
// imports them from here instead of ipc/methods/serverExposure.ts.
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as Upstream from "../ipc/methods/serverExposure.ts";

export class ServerExposureDisabledError extends Data.TaggedError("ServerExposureDisabledError")<{
  readonly channel: string;
}> {
  override get message(): string {
    return "Network access and Tailscale Serve are turned off in Earlyscript (remoteAccess flag).";
  }
}

const disabledExposureMethod = <E, R>(
  method: DesktopIpc.DesktopIpcMethod<E, R>,
): DesktopIpc.DesktopIpcMethod<ServerExposureDisabledError, never> => ({
  channel: method.channel,
  handler: () => Effect.fail(new ServerExposureDisabledError({ channel: method.channel })),
});

const gate = <E, R>(
  method: DesktopIpc.DesktopIpcMethod<E, R>,
): DesktopIpc.DesktopIpcMethod<E | ServerExposureDisabledError, R> =>
  earlyscriptFlags.remoteAccess ? method : disabledExposureMethod(method);

export const setServerExposureMode = gate(Upstream.setServerExposureMode);
export const setTailscaleServeEnabled = gate(Upstream.setTailscaleServeEnabled);
