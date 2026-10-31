import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EDITORIAL_RESULTS_WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Results reads per environment. Decisions arrive a few times a day at most, so a minute of
 * staleness is invisible and reopening the space picks up the thread just closed.
 */
export const editorialResultsEnvironment = {
  summary: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:results-summary",
    tag: EDITORIAL_RESULTS_WS_METHODS.summary,
    staleTimeMs: 60_000,
  }),
  decisions: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:results-decisions",
    tag: EDITORIAL_RESULTS_WS_METHODS.decisions,
    staleTimeMs: 60_000,
  }),
  /** Evidence package: written by the server into a folder, or returned for a zip download. */
  exportEvidence: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:results-export",
    tag: EDITORIAL_RESULTS_WS_METHODS.export,
  }),
};
