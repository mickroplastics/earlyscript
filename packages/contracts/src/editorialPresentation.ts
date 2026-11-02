import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt } from "./baseSchemas.ts";
import { EditorialDossierId, EditorialRunId, EditorialTrendPresentation } from "./editorial.ts";

// Earlyscript: assistant-written title and summary of each trend. The server writes them
// through the text generation service and stores them in editorial.sqlite; reading them
// back goes through `editorial.getInbox` and `editorial.getDossier` (`presentation`).

/** Evidence items the assistant reads per trend, in the engine's selection order. */
export const PRESENTATION_EVIDENCE_LIMIT = 12;

/**
 * Longest excerpt of one evidence item sent to the assistant. The engine's default
 * (`text.excerpt_chars` of engine.v1.json) is the same, but an imported or custom run may store
 * longer ones: the server cuts at this boundary, and the first-run step promises it.
 */
export const PRESENTATION_EXCERPT_CHARS = 500;

export const EDITORIAL_PRESENTATION_WS_METHODS = {
  ensure: "editorial.presentation.ensure",
  regenerate: "editorial.presentation.regenerate",
  ensureRun: "editorial.presentation.ensureRun",
  getRunProgress: "editorial.presentation.getRunProgress",
} as const;

export const EditorialPresentationTarget = Schema.Struct({
  runId: EditorialRunId,
  dossierId: EditorialDossierId,
});
export type EditorialPresentationTarget = typeof EditorialPresentationTarget.Type;

export const EditorialPresentationResult = Schema.Struct({
  runId: EditorialRunId,
  dossierId: EditorialDossierId,
  presentation: EditorialTrendPresentation,
  /** What the validation changed or dropped (cut parts, unknown citations). */
  warnings: Schema.Array(Schema.String),
  /** True when a stored presentation for the same input was returned without generating. */
  reused: Schema.Boolean,
});
export type EditorialPresentationResult = typeof EditorialPresentationResult.Type;

export const EditorialPresentationRunInput = Schema.Struct({ runId: EditorialRunId });
export type EditorialPresentationRunInput = typeof EditorialPresentationRunInput.Type;

/** Drafting every trend of a run. Counts cover the run's dossiers against their current input. */
export const EditorialPresentationRunProgress = Schema.Struct({
  runId: EditorialRunId,
  /** `running` while a background drafting of the run is in progress in this server. */
  status: Schema.Literals(["idle", "running"]),
  total: NonNegativeInt,
  ready: NonNegativeInt,
  /** Latest attempt failed and no ready presentation exists for the current input. */
  failed: NonNegativeInt,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
});
export type EditorialPresentationRunProgress = typeof EditorialPresentationRunProgress.Type;

export class EditorialPresentationError extends Schema.TaggedError<EditorialPresentationError>()(
  "EditorialPresentationError",
  {
    reason: Schema.Literals([
      "run-not-found",
      "dossier-not-found",
      "generation-failed",
      "storage-failed",
      "unavailable",
    ]),
    message: Schema.String,
  },
) {}

const errors = Schema.Union([EditorialPresentationError, EnvironmentAuthorizationError]);

const EnsureRpc = Rpc.make(EDITORIAL_PRESENTATION_WS_METHODS.ensure, {
  payload: EditorialPresentationTarget,
  success: EditorialPresentationResult,
  error: errors,
});

const RegenerateRpc = Rpc.make(EDITORIAL_PRESENTATION_WS_METHODS.regenerate, {
  payload: EditorialPresentationTarget,
  success: EditorialPresentationResult,
  error: errors,
});

const EnsureRunRpc = Rpc.make(EDITORIAL_PRESENTATION_WS_METHODS.ensureRun, {
  payload: EditorialPresentationRunInput,
  success: EditorialPresentationRunProgress,
  error: errors,
});

const GetRunProgressRpc = Rpc.make(EDITORIAL_PRESENTATION_WS_METHODS.getRunProgress, {
  payload: EditorialPresentationRunInput,
  success: EditorialPresentationRunProgress,
  error: errors,
});

/** Merged into `WsRpcGroup` next to `EditorialRpcGroup`. */
export const EditorialPresentationRpcGroup = RpcGroup.make(
  EnsureRpc,
  RegenerateRpc,
  EnsureRunRpc,
  GetRunProgressRpc,
);

/**
 * Drafting spends inference on the operator's provider, like regenerating a thread title
 * (`orchestration.dispatchCommand`), so it needs the operate scope. Progress is a read.
 */
export const EDITORIAL_PRESENTATION_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_PRESENTATION_WS_METHODS.ensure]: AuthOrchestrationOperateScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.regenerate]: AuthOrchestrationOperateScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.ensureRun]: AuthOrchestrationOperateScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.getRunProgress]: AuthOrchestrationReadScope,
} as const;
