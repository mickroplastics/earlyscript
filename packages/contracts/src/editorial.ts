import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Earlyscript editorial space: read-only views over the trend engine's runs. The server
// reads `dossier/1` files from the runs directory; nothing here writes editorial state.

export const EDITORIAL_WS_METHODS = {
  listRuns: "editorial.listRuns",
  getInbox: "editorial.getInbox",
  getDossier: "editorial.getDossier",
} as const;

export const EditorialRunId = TrimmedNonEmptyString.pipe(Schema.brand("EditorialRunId"));
export type EditorialRunId = typeof EditorialRunId.Type;

export const EditorialDossierId = TrimmedNonEmptyString.pipe(Schema.brand("EditorialDossierId"));
export type EditorialDossierId = typeof EditorialDossierId.Type;

export const EditorialRunSummary = Schema.Struct({
  runId: EditorialRunId,
  /** The engine only saw items published before this instant. */
  cutoffAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  status: Schema.String,
  configVersion: Schema.NullOr(Schema.String),
  sources: Schema.Array(Schema.String),
  dossierCount: NonNegativeInt,
});
export type EditorialRunSummary = typeof EditorialRunSummary.Type;

export const EditorialSourceCoverage = Schema.Struct({
  source: Schema.String,
  windowDays: NonNegativeInt,
  daysComplete: NonNegativeInt,
  daysPartial: NonNegativeInt,
  daysUnavailable: NonNegativeInt,
});
export type EditorialSourceCoverage = typeof EditorialSourceCoverage.Type;

/** One day of the trend's activity. `known: false` means the day was not captured, not zero. */
export const EditorialCurveDay = Schema.Struct({
  day: Schema.String,
  items: NonNegativeInt,
  authors: NonNegativeInt,
  sources: NonNegativeInt,
  known: Schema.Boolean,
});
export type EditorialCurveDay = typeof EditorialCurveDay.Type;

/** Assistant-written title and summary (U7). Absent until a presentation exists for the dossier. */
export const EditorialTrendPresentation = Schema.Struct({
  title: Schema.String,
  summary: Schema.Struct({
    whatHappened: Schema.String,
    whyItMatters: Schema.String,
    videoAngle: Schema.String,
  }),
  citedItemIds: Schema.Array(Schema.String),
  provider: Schema.String,
  model: Schema.String,
  promptVersion: Schema.String,
  generatedAt: IsoDateTime,
});
export type EditorialTrendPresentation = typeof EditorialTrendPresentation.Type;

export const EditorialTrendSummary = Schema.Struct({
  dossierId: EditorialDossierId,
  runId: EditorialRunId,
  /** Engine label built from terms. Always shown, also next to an assistant title. */
  label: Schema.String,
  terms: Schema.Array(Schema.String),
  /** Title of the most recent evidence item, until an assistant title exists. */
  subtitle: Schema.NullOr(Schema.String),
  presentation: Schema.optionalKey(EditorialTrendPresentation),
  stage: Schema.String,
  corroboration: Schema.String,
  items7d: NonNegativeInt,
  items28d: NonNegativeInt,
  authors7d: NonNegativeInt,
  /** Competition rank by `items7d` (the engine's baseline); ties share a rank. */
  volumeRank: PositiveInt,
  /** Rank by the engine's weighted score. */
  scoreRank: PositiveInt,
  score: Schema.Finite,
  growth: Schema.NullOr(Schema.Finite),
  affinity: Schema.NullOr(Schema.Finite),
  sourceCount: NonNegativeInt,
  /** Sources named by the evidence; `sourceCount` can be higher when the curve saw more. */
  sources: Schema.Array(Schema.String),
  /** Last 14 days of `items`; `null` for a day that was not captured. */
  sparkline: Schema.Array(Schema.NullOr(NonNegativeInt)),
  /** Unread in the inbox. Until read state exists (U3), every trend of the latest run is new. */
  isNew: Schema.Boolean,
});
export type EditorialTrendSummary = typeof EditorialTrendSummary.Type;

export const EditorialRankComponent = Schema.Struct({
  name: Schema.String,
  value: Schema.Finite,
  weight: Schema.Finite,
  contribution: Schema.Finite,
});
export type EditorialRankComponent = typeof EditorialRankComponent.Type;

export const EditorialEvidenceItem = Schema.Struct({
  itemId: Schema.String,
  source: Schema.String,
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
  publishedAt: IsoDateTime,
  permalink: Schema.NullOr(Schema.String),
  externalUrl: Schema.NullOr(Schema.String),
});
export type EditorialEvidenceItem = typeof EditorialEvidenceItem.Type;

export const EditorialTrendDossier = Schema.Struct({
  trend: EditorialTrendSummary,
  run: EditorialRunSummary,
  rankMethod: Schema.String,
  rankComponents: Schema.Array(EditorialRankComponent),
  /** Profile inclusion threshold the engine applied (`profile.include_min`). */
  affinityThreshold: Schema.Finite,
  curve: Schema.Array(EditorialCurveDay),
  coverage: Schema.Array(EditorialSourceCoverage),
  evidence: Schema.Array(EditorialEvidenceItem),
  evidenceTotal: NonNegativeInt,
  evidenceOffset: NonNegativeInt,
});
export type EditorialTrendDossier = typeof EditorialTrendDossier.Type;

export const EditorialInboxSort = Schema.Literals(["new-first-growth", "volume", "affinity"]);
export type EditorialInboxSort = typeof EditorialInboxSort.Type;

const EDITORIAL_INBOX_PAGE_LIMIT = 100;
const EDITORIAL_EVIDENCE_PAGE_LIMIT = 50;

export const EditorialListRunsInput = Schema.Struct({});
export const EditorialListRunsResult = Schema.Struct({
  runs: Schema.Array(EditorialRunSummary),
});
export type EditorialListRunsResult = typeof EditorialListRunsResult.Type;

export const EditorialGetInboxInput = Schema.Struct({
  /** Defaults to the most recent run. */
  runId: Schema.optionalKey(EditorialRunId),
  sort: Schema.optionalKey(EditorialInboxSort),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(EDITORIAL_INBOX_PAGE_LIMIT)),
  ),
});
export type EditorialGetInboxInput = typeof EditorialGetInboxInput.Type;

export const EditorialInbox = Schema.Struct({
  run: Schema.NullOr(EditorialRunSummary),
  sort: EditorialInboxSort,
  trends: Schema.Array(EditorialTrendSummary),
  total: NonNegativeInt,
  newCount: NonNegativeInt,
});
export type EditorialInbox = typeof EditorialInbox.Type;

export const EditorialGetDossierInput = Schema.Struct({
  runId: EditorialRunId,
  dossierId: EditorialDossierId,
  evidenceOffset: Schema.optionalKey(NonNegativeInt),
  evidenceLimit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(EDITORIAL_EVIDENCE_PAGE_LIMIT)),
  ),
});
export type EditorialGetDossierInput = typeof EditorialGetDossierInput.Type;

export class EditorialReadError extends Schema.TaggedError<EditorialReadError>()(
  "EditorialReadError",
  {
    reason: Schema.Literals(["run-not-found", "dossier-not-found", "unreadable"]),
    message: Schema.String,
  },
) {}

const EditorialListRunsRpc = Rpc.make(EDITORIAL_WS_METHODS.listRuns, {
  payload: EditorialListRunsInput,
  success: EditorialListRunsResult,
  error: Schema.Union([EditorialReadError, EnvironmentAuthorizationError]),
});

const EditorialGetInboxRpc = Rpc.make(EDITORIAL_WS_METHODS.getInbox, {
  payload: EditorialGetInboxInput,
  success: EditorialInbox,
  error: Schema.Union([EditorialReadError, EnvironmentAuthorizationError]),
});

const EditorialGetDossierRpc = Rpc.make(EDITORIAL_WS_METHODS.getDossier, {
  payload: EditorialGetDossierInput,
  success: EditorialTrendDossier,
  error: Schema.Union([EditorialReadError, EnvironmentAuthorizationError]),
});

/** Merged into `WsRpcGroup`, so it shares the socket, the scope middleware and the typed client. */
export const EditorialRpcGroup = RpcGroup.make(
  EditorialListRunsRpc,
  EditorialGetInboxRpc,
  EditorialGetDossierRpc,
);

/** Read-only methods; writes (U3) will need their own operate scope. */
export const EDITORIAL_RPC_REQUIRED_SCOPES = {
  [EDITORIAL_WS_METHODS.listRuns]: AuthOrchestrationReadScope,
  [EDITORIAL_WS_METHODS.getInbox]: AuthOrchestrationReadScope,
  [EDITORIAL_WS_METHODS.getDossier]: AuthOrchestrationReadScope,
} as const;
