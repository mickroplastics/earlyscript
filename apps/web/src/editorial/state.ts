import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { EDITORIAL_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Editorial reads per environment. The server rereads a run only when its files change, so a
 * minute of staleness costs little and picks up a new nightly run while the app stays open.
 */
export const editorialEnvironment = {
  inbox: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:inbox",
    tag: EDITORIAL_WS_METHODS.getInbox,
    staleTimeMs: 60_000,
  }),
  dossier: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:dossier",
    tag: EDITORIAL_WS_METHODS.getDossier,
    staleTimeMs: 5 * 60_000,
  }),
};
