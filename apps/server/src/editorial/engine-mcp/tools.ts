import {
  EngineCampaignView,
  EngineJobView,
  EngineLabFailure,
  EngineManifestView,
  EnginePromotionView,
} from "@earlyscript/editorial-contracts/engineLab";
import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { EngineChangeService } from "../EngineChangeService.ts";
import { EngineExperimentService } from "../EngineExperimentService.ts";
import { EnginePromotionService } from "../EnginePromotionService.ts";
import { EditorialRunDirectory } from "../RunDirectory.ts";

const Failure = Schema.Union([OrchestratorMcpFailure, EngineLabFailure]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  EditorialRunDirectory,
  ThreadManagement.ThreadManagementService,
  EngineChangeService,
  EngineExperimentService,
  EnginePromotionService,
];

const Id = TrimmedNonEmptyString;
const Key = TrimmedNonEmptyString.annotate({
  description:
    "Any string you choose. The same key answers the same result instead of acting twice.",
});

export const EngineInspectResult = Schema.Struct({
  target: Schema.String,
  active: Schema.NullOr(EngineManifestView),
  campaigns: Schema.Array(EngineCampaignView),
  candidate: Schema.NullOr(Schema.Struct({ ...EngineManifestView.fields, diff: Schema.Unknown })),
  /** What a candidate may change; for the active engine. */
  editable: Schema.Unknown,
  /** The base files for a code patch, by repository path; only for target `code`. */
  code: Schema.NullOr(
    Schema.Struct({
      baseSourceHash: Schema.String,
      files: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  /** A finished lab job's rankings per cutoff, with each trend's score components. */
  run: Schema.Unknown,
  /** A page of product runs, or of one product run's trends. */
  product: Schema.Unknown,
  promotions: Schema.Array(EnginePromotionView),
});
export type EngineInspectResult = typeof EngineInspectResult.Type;

const EngineInspectTool = Tool.make("engine_inspect", {
  description:
    "Read the trend engine lab, without changing anything. target `active`: the active engine's manifest (configuration, profile, sources, feeds, model and code hashes), what a candidate may change and within which bounds, the operator's campaigns with their remaining evaluations, and promotion requests. `candidate`: one candidate and its difference from its parent (id required). `code`: the pure computation files a code candidate may patch, with the base source hash to patch against. `run`: a finished lab job's rankings per cutoff, with each trend's score components (id = jobId). `product-runs`: a page of the product's nightly runs, newest first. `product-run`: a page of one product run's trends by rank, with components, gates, growth, profile fit and evidence titles (id = runId). Pages take `cursor` (the `next` of the previous page) and `limit` (at most 10). Contributions are what rank.ts computed; they are not causes.",
  parameters: Schema.Struct({
    target: Schema.Literals(["active", "candidate", "code", "run", "product-runs", "product-run"]),
    id: Schema.optional(
      Id.annotate({
        description:
          "candidate id (mf_…), job id (job_…) or product run id (run_…), for `candidate`, `run` and `product-run`.",
      }),
    ),
    cursor: Schema.optional(
      Schema.Int.annotate({
        description: "Where the page starts: the `next` of the previous page.",
      }),
    ),
    limit: Schema.optional(Schema.Int.annotate({ description: "Entries per page, at most 10." })),
  }),
  success: EngineInspectResult,
  failure: Failure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Inspect the trend engine lab")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

export const EngineCandidateCreateResult = Schema.Struct({
  candidate: EngineManifestView,
  created: Schema.Boolean,
  diff: Schema.Unknown,
  risks: Schema.Array(Schema.String),
});

const EngineCandidateCreateTool = Tool.make("engine_candidate_create", {
  description:
    "Create an immutable engine candidate from the active engine or one of this project's candidates. It changes nothing that runs and executes no code. change.kind `config`: `weights` (names of rank.weighted the engine computes, finite 0..2, at least one positive, not normalized) and, when the base has a relevance model, `relevance` with item_min and signal_min (0..1); unknown keys are refused. change.kind `code`: `baseSourceHash` from engine_inspect target `code` and `patch`, a unified diff that edits only the files that tool lists. Profile, sources, feeds, labels and retraining are not changeable here yet. Changing a candidate means creating a child of it.",
  parameters: Schema.Struct({
    baseId: Id.annotate({
      description:
        "The active engine's id (mf_…) from engine_inspect, or one of this project's candidates.",
    }),
    intent: TrimmedNonEmptyString.annotate({
      description: "What the change is for, in a sentence.",
    }),
    hypothesis: TrimmedNonEmptyString.annotate({
      description: "What you expect to happen to the top 5, and why.",
    }),
    idempotencyKey: Key,
    change: Schema.Record(Schema.String, Schema.Unknown).annotate({
      description:
        'e.g. {"kind":"config","weights":{"growth":0.3,"log_authors_7d":0.5}} or {"kind":"code","baseSourceHash":"sha256:…","patch":"--- a/packages/trend-engine/src/rank.ts\\n+++ b/…"}',
    }),
  }),
  success: EngineCandidateCreateResult,
  failure: Failure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Create an engine candidate")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

export const EngineEvaluateResult = Schema.Struct({
  job: EngineJobView,
  created: Schema.Boolean,
  remaining: Schema.Number,
});

const EngineEvaluateTool = Tool.make("engine_evaluate", {
  description:
    "Queue the development comparison of a candidate against the campaign's reference engine, over the cutoffs, corpus and labels the operator fixed for the campaign. It returns at once with a jobId; follow it with engine_job_get. Each new candidate takes one of the campaign's evaluations, failed or cancelled ones included; asking again for the same candidate or key answers the same job. Test cutoffs of the frozen evaluation are never available.",
  parameters: Schema.Struct({
    candidateId: Id,
    campaignId: Id.annotate({
      description: "An open development campaign of this project, from engine_inspect.",
    }),
    idempotencyKey: Key,
  }),
  success: EngineEvaluateResult,
  failure: Failure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Evaluate an engine candidate")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

const EngineJobGetTool = Tool.make("engine_job_get", {
  description:
    "Read a lab job: status (queued, running, succeeded, failed, cancelled), its events after `afterSeq`, and once it succeeded the development report. The report gives P@5, G@5 and core@5 of both engines as ranges (unlabelled positions count 0 at the lower bound and 1 at the upper), label coverage, entered and left trends per cutoff, and whether the candidate's output is logically equal to the reference's. `succeeded` means the computation finished, not that the candidate won.",
  parameters: Schema.Struct({
    jobId: Id,
    afterSeq: Schema.optional(
      Schema.Int.annotate({ description: "Only events after this sequence number." }),
    ),
  }),
  success: EngineJobView,
  failure: Failure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Read an engine lab job")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

const EngineJobCancelTool = Tool.make("engine_job_cancel", {
  description:
    "Cancel a queued or running lab job of this project. It stops only that job's processes; the evaluation stays counted and recorded.",
  parameters: Schema.Struct({ jobId: Id, reason: TrimmedNonEmptyString }),
  success: EngineJobView,
  failure: Failure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Cancel an engine lab job")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

const EnginePromotionRequestTool = Tool.make("engine_promotion_request", {
  description:
    "Ask Miguel to promote a candidate, with the report of its evaluation. It changes nothing: the request lists the checks still pending, and only Miguel approves, outside this tool. A candidate that claims a better editorial result also needs a prospective shadow labelled blind by Miguel; a development report alone never promotes it. expectedActiveId must be the engine active now.",
  parameters: Schema.Struct({
    candidateId: Id,
    reportId: Id,
    expectedActiveId: Id,
    reason: TrimmedNonEmptyString,
  }),
  success: EnginePromotionView,
  failure: Failure,
  failureMode: "return" as const,
  dependencies,
})
  .annotate(Tool.Title, "Request an engine promotion")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Strict, true);

/** The engine lab: models propose, evaluate and ask; nothing here activates an engine. */
export const EngineLabToolkit = Toolkit.make(
  EngineInspectTool,
  EngineCandidateCreateTool,
  EngineEvaluateTool,
  EngineJobGetTool,
  EngineJobCancelTool,
  EnginePromotionRequestTool,
);
