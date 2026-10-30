import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

/** T3 Connect rides on the relay, so it needs both flags. */
export const t3ConnectEnabled: boolean = earlyscriptFlags.t3Connect && earlyscriptFlags.relay;

/**
 * Without `t3Connect` the server behaves as a build without T3 Connect public config: no `t3 connect`
 * CLI commands and no desired-link reconcile at startup.
 */
export const cloudPublicConfigAvailable = (configured: boolean): boolean =>
  t3ConnectEnabled && configured;
