import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EDITORIAL_RESULTS_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/** The manual baseline: a closed record, read again only after an import. */
const baseline = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:results-baseline",
  tag: EDITORIAL_RESULTS_WS_METHODS.baseline,
  staleTimeMs: 60_000,
});

const refreshBaseline = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.refresh(baseline({ environmentId, input: {} })));

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
  baseline,
  /** Replaces the stored manual log with the CSV's; the section reads it again on success. */
  importBaseline: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:results-baseline-import",
    tag: EDITORIAL_RESULTS_WS_METHODS.baselineImport,
    onSuccess: refreshBaseline,
  }),
  /** Evidence package: written by the server into a folder, or returned for a zip download. */
  exportEvidence: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:results-export",
    tag: EDITORIAL_RESULTS_WS_METHODS.export,
  }),
  /** Figures drawn here, written by the server into the folder the desktop app picked. */
  saveFigures: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:results-save-figures",
    tag: EDITORIAL_RESULTS_WS_METHODS.saveFigures,
  }),
};
