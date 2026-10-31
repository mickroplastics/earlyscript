import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_PRESENTATION_WS_METHODS,
  type EditorialDossierId,
  type EditorialInboxSort,
  type EditorialRunId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { editorialEnvironment } from "./state";

const INBOX_SORTS: ReadonlyArray<EditorialInboxSort> = ["new-first-growth", "volume", "affinity"];
/** The dossier page's first evidence page, the query that carries `presentation`. */
export const DOSSIER_EVIDENCE_PAGE_SIZE = 6;
/** The assistant reads at most twelve evidence items, so citations resolve within them. */
export const CITATION_EVIDENCE_LIMIT = 12;
const RUN_PROGRESS_POLL_MS = 2_000;

/**
 * Refetches the inbox and dossier reads that show `presentation`. They have no refresh
 * signal of their own yet; once the inbox has a revision atom, bump it here instead.
 */
function refreshTrendReads(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  dossier?: { readonly runId: EditorialRunId; readonly dossierId: EditorialDossierId },
) {
  for (const sort of INBOX_SORTS) {
    registry.refresh(editorialEnvironment.inbox({ environmentId, input: { sort } }));
  }
  if (dossier === undefined) return;
  for (const evidenceLimit of [DOSSIER_EVIDENCE_PAGE_SIZE, CITATION_EVIDENCE_LIMIT]) {
    registry.refresh(
      editorialEnvironment.dossier({ environmentId, input: { ...dossier, evidenceLimit } }),
    );
  }
}

const lastReadyByRun = new Map<string, number>();

/** Polled while a run drafts; stops once the server reports it idle. */
const runProgress = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:presentation-run-progress",
  tag: EDITORIAL_PRESENTATION_WS_METHODS.getRunProgress,
  staleTimeMs: RUN_PROGRESS_POLL_MS,
  refreshIntervalMs: RUN_PROGRESS_POLL_MS,
  isFinal: (progress) => progress.status === "idle",
  // New titles show up in the inbox as they are written, not only at the end.
  onAnswer: ({ environmentId }, progress, registry) =>
    Effect.sync(() => {
      const key = `${environmentId}\u0000${progress.runId}`;
      const previous = lastReadyByRun.get(key);
      lastReadyByRun.set(key, progress.ready);
      if (previous !== undefined && previous !== progress.ready) {
        refreshTrendReads(registry, environmentId);
      }
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
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => refreshTrendReads(registry, environmentId, input)),
  }),
  regenerate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:presentation-regenerate",
    tag: EDITORIAL_PRESENTATION_WS_METHODS.regenerate,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => refreshTrendReads(registry, environmentId, input)),
  }),
  /** Starts drafting the whole run on the server; progress then polls until it is idle. */
  ensureRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:presentation-ensure-run",
    tag: EDITORIAL_PRESENTATION_WS_METHODS.ensureRun,
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() => registry.refresh(runProgress({ environmentId, input }))),
  }),
  runProgress,
};
