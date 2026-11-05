// The engine lab's contract: what the engine MCP tools take and answer, and the errors they
// return. Candidates are immutable manifests; evaluations are jobs; promotion is Miguel's.
import * as Schema from "effect/Schema";

export const EngineLabErrorCode = Schema.Literals([
  "permission-denied",
  "budget-exhausted",
  "sealed-partition",
  "stale-base",
  "artifact-mismatch",
  "executor-unavailable",
  "insufficient-evidence",
  "unsupported-change",
  "invalid-change",
  "not-found",
]);
export type EngineLabErrorCode = typeof EngineLabErrorCode.Type;

/** A refusal the model can act on: the code says which rule, the message what to do. */
export class EngineLabFailure extends Schema.TaggedError<EngineLabFailure>()("EngineLabFailure", {
  code: EngineLabErrorCode,
  message: Schema.String,
}) {}

export const EngineJobStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type EngineJobStatus = typeof EngineJobStatus.Type;

export const EnginePromotionStatus = Schema.Literals([
  "requested",
  "approved",
  "rejected",
  "stale",
]);
export type EnginePromotionStatus = typeof EnginePromotionStatus.Type;

const Json = Schema.Unknown;

export const EngineManifestView = Schema.Struct({
  /** `mf_` and 16 hex characters of the manifest hash. */
  manifestId: Schema.String,
  manifestHash: Schema.String,
  kind: Schema.Literals(["installed", "config", "code"]),
  parentHash: Schema.NullOr(Schema.String),
  configHash: Schema.String,
  profileHash: Schema.String,
  feedsHash: Schema.String,
  engineSourceHash: Schema.String,
  intent: Schema.NullOr(Schema.String),
  hypothesis: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  /** The whole manifest: configuration, sources, model and code identity. */
  manifest: Json,
});
export type EngineManifestView = typeof EngineManifestView.Type;

export const EngineCampaignView = Schema.Struct({
  campaignId: Schema.String,
  kind: Schema.Literals(["development", "shadow"]),
  referenceHash: Schema.String,
  budget: Schema.Number,
  used: Schema.Number,
  remaining: Schema.Number,
  status: Schema.Literals(["open", "closed"]),
  cutoffs: Schema.Array(Schema.String),
  executor: Schema.String,
  labels: Schema.NullOr(Schema.String),
  judge: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type EngineCampaignView = typeof EngineCampaignView.Type;

export const EngineJobView = Schema.Struct({
  jobId: Schema.String,
  campaignId: Schema.String,
  candidateHash: Schema.String,
  referenceHash: Schema.String,
  status: EngineJobStatus,
  executor: Schema.String,
  tries: Schema.Number,
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  reportId: Schema.NullOr(Schema.String),
  reportHash: Schema.NullOr(Schema.String),
  events: Schema.Array(
    Schema.Struct({
      seq: Schema.Number,
      at: Schema.String,
      kind: Schema.String,
      detail: Schema.String,
    }),
  ),
  /** The finished development report; null until the job succeeds. */
  report: Json,
});
export type EngineJobView = typeof EngineJobView.Type;

export const EnginePromotionView = Schema.Struct({
  requestId: Schema.String,
  candidateHash: Schema.String,
  reportId: Schema.String,
  expectedActiveHash: Schema.String,
  status: EnginePromotionStatus,
  reason: Schema.String,
  /** What Miguel's approval still needs, in order. */
  pendingChecks: Schema.Array(Schema.String),
  diff: Json,
  createdAt: Schema.String,
  decidedAt: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(Schema.String),
});
export type EnginePromotionView = typeof EnginePromotionView.Type;
