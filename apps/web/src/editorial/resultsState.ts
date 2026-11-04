import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EDITORIAL_RESULTS_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

/** Bumped when a thread changes cohort, so open Results reads (summary, any decisions page) refetch. */
const resultsRevision = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));

export const bumpResults = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.update(resultsRevision(environmentId), (value) => value + 1));

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
 * Results reads per environment. Reopening must reflect cohort changes immediately, so
 * a trial never stays in the human figures through the previous view's cache.
 */
export const editorialResultsEnvironment = {
  summary: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:results-summary",
    tag: EDITORIAL_RESULTS_WS_METHODS.summary,
    staleTimeMs: 0,
    refreshTrigger: (target) => resultsRevision(target.environmentId),
  }),
  decisions: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:results-decisions",
    tag: EDITORIAL_RESULTS_WS_METHODS.decisions,
    staleTimeMs: 0,
    refreshTrigger: (target) => resultsRevision(target.environmentId),
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
