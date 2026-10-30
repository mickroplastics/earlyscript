// @effect-diagnostics nodeBuiltinImport:off - plain library without an Effect runtime.
import * as NodeOS from "node:os";

export interface Host {
  readonly platform: string;
  readonly arch: string;
}

// The engine runs outside the Effect graph; a server caller can pass HostProcess values instead.
export const HOST: Host = {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone engine, no Effect runtime.
  platform: NodeOS.platform(),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone engine, no Effect runtime.
  arch: NodeOS.arch(),
};
