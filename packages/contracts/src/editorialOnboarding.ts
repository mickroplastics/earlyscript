import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime } from "./baseSchemas.ts";

// Earlyscript first-run wizard: every step the operator accepts is stored as a dated decision
// (what was accepted, when, with which app version), and finishing the four steps is stored
// apart. Append-only: reopening the wizard adds rows and never rewrites earlier ones.

export const EDITORIAL_ONBOARDING_WS_METHODS = {
  record: "editorial.onboarding.record",
  list: "editorial.onboarding.list",
  status: "editorial.onboarding.status",
  complete: "editorial.onboarding.complete",
} as const;

/** In wizard order; the web's `ONBOARDING_STAGES` uses the same ids. */
export const EDITORIAL_ONBOARDING_STEPS = ["datos", "proveedores", "estudio", "motor"] as const;
export const EditorialOnboardingStep = Schema.Literals(EDITORIAL_ONBOARDING_STEPS);
export type EditorialOnboardingStep = typeof EditorialOnboardingStep.Type;

/** Serialized size limit of one acceptance: ids, booleans and hashes, never raw texts. */
export const EDITORIAL_ONBOARDING_MAX_PAYLOAD_BYTES = 16 * 1024;

export const EditorialOnboardingPayload = Schema.Record(Schema.String, Schema.Unknown);
export type EditorialOnboardingPayload = typeof EditorialOnboardingPayload.Type;

export const EditorialOnboardingAcceptance = Schema.Struct({
  id: Schema.String,
  step: EditorialOnboardingStep,
  acceptedAt: IsoDateTime,
  payload: EditorialOnboardingPayload,
  /** The server's version when the step was accepted. */
  appVersion: Schema.String,
});
export type EditorialOnboardingAcceptance = typeof EditorialOnboardingAcceptance.Type;

export const EditorialOnboardingRecordInput = Schema.Struct({
  step: EditorialOnboardingStep,
  payload: EditorialOnboardingPayload,
});
export type EditorialOnboardingRecordInput = typeof EditorialOnboardingRecordInput.Type;

/** In the order they were accepted, oldest first. */
export const EditorialOnboardingList = Schema.Struct({
  acceptances: Schema.Array(EditorialOnboardingAcceptance),
});
export type EditorialOnboardingList = typeof EditorialOnboardingList.Type;

export const EditorialOnboardingStepStatus = Schema.Struct({
  step: EditorialOnboardingStep,
  /** The latest acceptance of the step; null when it was never accepted. */
  lastAcceptedAt: Schema.NullOr(IsoDateTime),
});
export type EditorialOnboardingStepStatus = typeof EditorialOnboardingStepStatus.Type;

export const EditorialOnboardingStatus = Schema.Struct({
  /** In wizard order. */
  steps: Schema.Array(EditorialOnboardingStepStatus),
  /** The last time the operator finished the wizard; null when never finished. */
  completedAt: Schema.NullOr(IsoDateTime),
});
export type EditorialOnboardingStatus = typeof EditorialOnboardingStatus.Type;

export class EditorialOnboardingError extends Schema.TaggedError<EditorialOnboardingError>()(
  "EditorialOnboardingError",
  {
    reason: Schema.Literals(["unavailable", "storage", "invalid-payload"]),
    message: Schema.String,
  },
) {}

const onboardingError = Schema.Union([EditorialOnboardingError, EnvironmentAuthorizationError]);

/** Appends one acceptance and answers it as stored. */
const EditorialOnboardingRecordRpc = Rpc.make(EDITORIAL_ONBOARDING_WS_METHODS.record, {
  payload: EditorialOnboardingRecordInput,
  success: EditorialOnboardingAcceptance,
  error: onboardingError,
});

const EditorialOnboardingListRpc = Rpc.make(EDITORIAL_ONBOARDING_WS_METHODS.list, {
  payload: Schema.Struct({}),
  success: EditorialOnboardingList,
  error: onboardingError,
});

const EditorialOnboardingStatusRpc = Rpc.make(EDITORIAL_ONBOARDING_WS_METHODS.status, {
  payload: Schema.Struct({}),
  success: EditorialOnboardingStatus,
  error: onboardingError,
});

/** Records that the operator finished the wizard, and answers the status after it. */
const EditorialOnboardingCompleteRpc = Rpc.make(EDITORIAL_ONBOARDING_WS_METHODS.complete, {
  payload: Schema.Struct({}),
  success: EditorialOnboardingStatus,
  error: onboardingError,
});

/** Merged into `WsRpcGroup` next to the other editorial groups. */
export const EditorialOnboardingRpcGroup = RpcGroup.make(
  EditorialOnboardingRecordRpc,
  EditorialOnboardingListRpc,
  EditorialOnboardingStatusRpc,
  EditorialOnboardingCompleteRpc,
);

export const EDITORIAL_ONBOARDING_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_ONBOARDING_WS_METHODS.record]: AuthOrchestrationOperateScope,
  [EDITORIAL_ONBOARDING_WS_METHODS.list]: AuthOrchestrationReadScope,
  [EDITORIAL_ONBOARDING_WS_METHODS.status]: AuthOrchestrationReadScope,
  [EDITORIAL_ONBOARDING_WS_METHODS.complete]: AuthOrchestrationOperateScope,
} as const;
