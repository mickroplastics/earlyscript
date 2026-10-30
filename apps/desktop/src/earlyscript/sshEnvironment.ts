// Earlyscript-only: the `remoteAccess` hook on desktop SSH environments. DesktopIpcHandlers imports
// the SSH IPC methods from here instead of ipc/methods/sshEnvironment.ts.
import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as Upstream from "../ipc/methods/sshEnvironment.ts";

export class SshEnvironmentsDisabledError extends Data.TaggedError("SshEnvironmentsDisabledError")<{
  readonly channel: string;
}> {
  override get message(): string {
    return "SSH environments are turned off in Earlyscript (remoteAccess flag).";
  }
}

/** Keeps the IPC channel registered so the renderer gets a clear error instead of a missing handler. */
export const disabledSshMethod = <E, R>(
  method: DesktopIpc.DesktopIpcMethod<E, R>,
): DesktopIpc.DesktopIpcMethod<SshEnvironmentsDisabledError, never> => ({
  channel: method.channel,
  handler: () => Effect.fail(new SshEnvironmentsDisabledError({ channel: method.channel })),
});

const gate = <E, R>(
  method: DesktopIpc.DesktopIpcMethod<E, R>,
): DesktopIpc.DesktopIpcMethod<E | SshEnvironmentsDisabledError, R> =>
  earlyscriptFlags.remoteAccess ? method : disabledSshMethod(method);

export const discoverSshHosts = gate(Upstream.discoverSshHosts);
export const resolveSshHost = gate(Upstream.resolveSshHost);
export const ensureSshEnvironment = gate(Upstream.ensureSshEnvironment);
export const disconnectSshEnvironment = gate(Upstream.disconnectSshEnvironment);
export const fetchSshEnvironmentDescriptor = gate(Upstream.fetchSshEnvironmentDescriptor);
export const bootstrapSshBearerSession = gate(Upstream.bootstrapSshBearerSession);
export const fetchSshSessionState = gate(Upstream.fetchSshSessionState);
export const resolveSshPasswordPrompt = gate(Upstream.resolveSshPasswordPrompt);
