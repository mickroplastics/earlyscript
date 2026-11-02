import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EDITORIAL_PRESENTATION_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { bumpInbox } from "./state";

/** The dossier page's first evidence page, the query that carries `presentation`. */
export const DOSSIER_EVIDENCE_PAGE_SIZE = 6;
/** The assistant reads at most twelve evidence items, so citations resolve within them. */
export const CITATION_EVIDENCE_LIMIT = 12;
const RUN_PROGRESS_POLL_MS = 2_000;

const lastReadyByRun = new Map<string, number>();

/** The monthly drafting cap and this month's count (Settings › Editorial, wizard, run button). */
const budget = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:presentation-budget",
  tag: EDITORIAL_PRESENTATION_WS_METHODS.getBudget,
  staleTimeMs: 60_000,
});

const refreshBudget = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.refresh(budget({ environmentId, input: {} })));

const afterDraft = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.andThen(bumpInbox(target, registry), refreshBudget(target, registry));

/** Polled while a run drafts; stops once the server reports it idle. */
const runProgress = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:presentation-run-progress",
  tag: EDITORIAL_PRESENTATION_WS_METHODS.getRunProgress,
  staleTimeMs: RUN_PROGRESS_POLL_MS,
  refreshIntervalMs: RUN_PROGRESS_POLL_MS,
  isFinal: (progress) => progress.status === "idle",
  // New titles show up in the inbox as they are written, not only at the end.
  onAnswer: ({ environmentId }, progress, registry) =>
    Effect.suspend(() => {
      const key = `${environmentId}\u0000${progress.runId}`;
      const previous = lastReadyByRun.get(key);
      lastReadyByRun.set(key, progress.ready);
      return previous !== undefined && previous !== progress.ready
        ? afterDraft({ environmentId }, registry)
        : Effect.void;
    }),
});

/**
 * Assistant-written titles and summaries. Drafting runs on the operator's text generation
 * model (Settings) and is always a human action; nothing here drafts on its own.
 */
export const presentationEnvironment = {
  ensure: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:presentation-ensure",
    tag: EDITORIAL_PRESENTATION_WS_METHODS.ensure,
    onSuccess: afterDraft,
  }),
  regenerate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:presentation-regenerate",
    tag: EDITORIAL_PRESENTATION_WS_METHODS.regenerate,
    onSuccess: afterDraft,
  }),
  /** Starts drafting the whole run on the server; progress then polls until it is idle. */
  ensureRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:presentation-ensure-run",
    tag: EDITORIAL_PRESENTATION_WS_METHODS.ensureRun,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => registry.refresh(runProgress({ environmentId, input }))),
  }),
  runProgress,
  budget,
  updateBudget: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:presentation-update-budget",
    tag: EDITORIAL_PRESENTATION_WS_METHODS.updateBudget,
    onSuccess: refreshBudget,
  }),
};
