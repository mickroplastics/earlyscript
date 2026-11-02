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
  getBudget: "editorial.presentation.getBudget",
  updateBudget: "editorial.presentation.updateBudget",
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

/** Highest monthly cap the settings accept; 0 means no cap. */
export const EDITORIAL_DRAFT_BUDGET_MAX = 100_000;
/** What a database without a saved cap uses: about fifteen nightly runs of 40 trends. */
export const EDITORIAL_DRAFT_BUDGET_DEFAULT = 600;

/**
 * Drafting runs on the operator's subscriptions, which have no per-call price, so the cap is a
 * count: trends drafted (ready or in flight) per calendar month of the server's time zone.
 * Failed attempts do not count, so a night without a provider never eats the month.
 */
export const EditorialDraftBudget = Schema.Struct({
  /** 0: no cap. */
  monthlyLimit: NonNegativeInt,
  usedThisMonth: NonNegativeInt,
  /** The month the count covers, `YYYY-MM`. */
  month: Schema.String,
});
export type EditorialDraftBudget = typeof EditorialDraftBudget.Type;

/** True when the cap stops the next draft. */
export const isDraftBudgetReached = (budget: EditorialDraftBudget): boolean =>
  budget.monthlyLimit > 0 && budget.usedThisMonth >= budget.monthlyLimit;

export const EditorialDraftBudgetUpdate = Schema.Struct({
  monthlyLimit: NonNegativeInt.check(Schema.isLessThanOrEqualTo(EDITORIAL_DRAFT_BUDGET_MAX)),
});
export type EditorialDraftBudgetUpdate = typeof EditorialDraftBudgetUpdate.Type;

export class EditorialPresentationError extends Schema.TaggedError<EditorialPresentationError>()(
  "EditorialPresentationError",
  {
    reason: Schema.Literals([
      "run-not-found",
      "dossier-not-found",
      "generation-failed",
      "storage-failed",
      "unavailable",
      "budget-reached",
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

const GetBudgetRpc = Rpc.make(EDITORIAL_PRESENTATION_WS_METHODS.getBudget, {
  payload: Schema.Struct({}),
  success: EditorialDraftBudget,
  error: errors,
});

const UpdateBudgetRpc = Rpc.make(EDITORIAL_PRESENTATION_WS_METHODS.updateBudget, {
  payload: EditorialDraftBudgetUpdate,
  success: EditorialDraftBudget,
  error: errors,
});

/** Merged into `WsRpcGroup` next to `EditorialRpcGroup`. */
export const EditorialPresentationRpcGroup = RpcGroup.make(
  EnsureRpc,
  RegenerateRpc,
  EnsureRunRpc,
  GetRunProgressRpc,
  GetBudgetRpc,
  UpdateBudgetRpc,
);

/**
 * Drafting spends inference on the operator's provider, like regenerating a thread title
 * (`orchestration.dispatchCommand`), so it needs the operate scope, and so does changing the
 * monthly cap on it. Progress and the cap are reads.
 */
export const EDITORIAL_PRESENTATION_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_PRESENTATION_WS_METHODS.ensure]: AuthOrchestrationOperateScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.regenerate]: AuthOrchestrationOperateScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.ensureRun]: AuthOrchestrationOperateScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.getRunProgress]: AuthOrchestrationReadScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.getBudget]: AuthOrchestrationReadScope,
  [EDITORIAL_PRESENTATION_WS_METHODS.updateBudget]: AuthOrchestrationOperateScope,
} as const;
