import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";

/**
 * Without `remoteAccess` linked environments stay off whatever the saved settings say: the link
 * service refuses to link or forward, `/mcp` rejects linked clients and hides the
 * `t3_environment_link*` tools, and MCP OAuth refuses peer-link registrations.
 */
export const linkedEnvironmentsEnabled = (settings: {
  readonly linkedEnvironmentsEnabled: boolean;
}): boolean => earlyscriptFlags.remoteAccess && settings.linkedEnvironmentsEnabled;

/** Without `remoteAccess` Tailscale Serve is never configured, whatever the flag, variable or desktop bootstrap says. */
export const tailscaleServe = (enabled: boolean): boolean =>
  earlyscriptFlags.remoteAccess && enabled;

/**
 * Without `remoteAccess` a background service listens on 127.0.0.1, like a plain web server, instead of
 * listening on private networks on its own. An explicit `--host` or `T3CODE_HOST` still applies.
 */
export const serviceListensOnPrivateNetworks: boolean = earlyscriptFlags.remoteAccess;
