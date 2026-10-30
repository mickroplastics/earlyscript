import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Effect from "effect/Effect";
import { constant } from "effect/Function";
import * as Layer from "effect/Layer";

import * as CloudLink from "../cloud/CloudLink.ts";
import * as ConnectReachability from "../cloud/ConnectReachability.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as HeldHooksWaker from "../relay/HeldHooksWaker.ts";
import { t3ConnectEnabled } from "./t3Connect.ts";

// Same answer a build without a relay URL gives to a link request.
const notConfigured = constant(
  Effect.fail(new CloudLink.CloudLinkInternalError({ operation: "relay-url-unconfigured" })),
);

/**
 * Without `t3Connect` the link service reads no stored secret and calls no relay, whatever an
 * earlier T3 Connect link left on disk: no tunnel recovery or registration at startup, no
 * connector start, no desired-link reconcile and no release on shutdown.
 */
const layerCloudLinkDisabled = Layer.succeed(
  CloudLink.CloudLink,
  CloudLink.CloudLink.of({
    linkProof: notConfigured,
    applyRelayConfig: notConfigured,
    linkState: notConfigured,
    unlink: notConfigured,
    updatePreferences: notConfigured,
    answerHealthRequest: notConfigured,
    mintCredential: notConfigured,
    reconcileDesiredLinkIfStillDesired: constant(Effect.succeed(null)),
    registerManagedTunnelRecovery: constant(Effect.succeed({ status: "not_linked" as const })),
    recoverManagedTunnel: constant(Effect.succeed(false)),
    startManagedTunnelIfOriginConfirmed: constant(Effect.succeed(false)),
    releaseManagedTunnelOnShutdown: constant(Effect.succeed(false)),
  }),
);

/** No reachability loop: nothing probes the tunnel hostname or reruns `tailscale` every few minutes. */
const layerConnectReachabilityDisabled = Layer.succeed(
  ConnectReachability.ConnectReachability,
  ConnectReachability.ConnectReachability.of({
    check: Effect.die(new Error("T3 Connect is turned off in Earlyscript (t3Connect flag).")),
    latest: Effect.succeedNone,
  }),
);

/** The link and reachability services the server provides. */
export const cloudLinkLayer = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
):
  | Layer.Layer<A, E, R>
  | Layer.Layer<CloudLink.CloudLink | ConnectReachability.ConnectReachability> =>
  t3ConnectEnabled ? layer : Layer.merge(layerCloudLinkDisabled, layerConnectReachabilityDisabled);

/** Without `relay` no agent activity is published to the relay from stored link secrets. */
export const layerAgentAwarenessRelayDisabled = Layer.succeed(
  AgentAwarenessRelay.AgentAwarenessRelay,
  AgentAwarenessRelay.AgentAwarenessRelay.of({
    publishThread: constant(Effect.void),
    drain: Effect.void,
    requestCatchUp: constant(Effect.void),
    start: constant(Effect.void),
  }),
);

export const agentAwarenessRelayLayer = earlyscriptFlags.relay
  ? AgentAwarenessRelay.layer
  : layerAgentAwarenessRelayDisabled;

/** Without `relay` the server never asks the relay to deliver held webhooks. */
export const heldHooksWakerLayer = earlyscriptFlags.relay ? HeldHooksWaker.layer : Layer.empty;
