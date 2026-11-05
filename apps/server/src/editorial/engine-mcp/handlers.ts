import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { loadCaller } from "../../mcp/threadAccess.ts";
import { EngineChangeService } from "../EngineChangeService.ts";
import { EngineExperimentService } from "../EngineExperimentService.ts";
import { EnginePromotionService } from "../EnginePromotionService.ts";
import { labFailure } from "../engineLabSupport.ts";
import { productRun, productRuns } from "../engineProductRuns.ts";
import { EngineLabToolkit, type EngineInspectResult } from "./tools.ts";

/**
 * The calling thread's project: every candidate, campaign and job is resolved inside it. A
 * client outside a thread has none, and the lab answers nothing to it.
 */
const callerProject = Effect.gen(function* () {
  const caller = yield* loadCaller();
  if (caller.caller === undefined) {
    return yield* labFailure(
      "permission-denied",
      "The engine lab answers agents running in a thread of a project.",
    );
  }
  return { projectId: String(caller.caller.projectId), threadId: String(caller.caller.id) };
});

const requireId = (id: string | undefined, target: string) =>
  id === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `target ${target} needs an id.`,
        }),
      )
    : Effect.succeed(id);

export const layer = McpToolAccess.toLayer(EngineLabToolkit, {
  engine_inspect: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* callerProject;
      const changes = yield* EngineChangeService;
      const experiments = yield* EngineExperimentService;
      const promotion = yield* EnginePromotionService;
      const current = yield* promotion.active;
      const { diff: _diff, ...active } = yield* changes.candidate(projectId, current.hash);
      const result: EngineInspectResult = {
        target: input.target,
        active,
        campaigns: yield* changes.campaigns(projectId),
        candidate: null,
        editable: changes.editable(current.manifest),
        code: null,
        run: null,
        product: null,
        promotions: yield* promotion.listRequests(projectId),
      };
      switch (input.target) {
        case "active":
          return result;
        case "candidate":
          return {
            ...result,
            candidate: yield* changes.candidate(projectId, yield* requireId(input.id, "candidate")),
          };
        case "code":
          return { ...result, code: yield* changes.codeFiles };
        case "run":
          return {
            ...result,
            run: yield* experiments.rankings({
              projectId,
              jobId: yield* requireId(input.id, "run"),
            }),
          };
        case "product-runs":
          return {
            ...result,
            product: yield* productRuns({ cursor: input.cursor, limit: input.limit }),
          };
        case "product-run":
          return {
            ...result,
            product: yield* productRun({
              runId: yield* requireId(input.id, "product-run"),
              cursor: input.cursor,
              limit: input.limit,
            }),
          };
      }
    }),
  ),
  engine_candidate_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId, threadId } = yield* callerProject;
      const changes = yield* EngineChangeService;
      return yield* changes.createCandidate({
        projectId,
        threadId,
        base: input.baseId,
        intent: input.intent,
        hypothesis: input.hypothesis,
        idempotencyKey: input.idempotencyKey,
        change: input.change,
      });
    }),
  ),
  engine_evaluate: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId, threadId } = yield* callerProject;
      const changes = yield* EngineChangeService;
      const experiments = yield* EngineExperimentService;
      const queued = yield* changes.evaluate({
        projectId,
        threadId,
        candidate: input.candidateId,
        campaignId: input.campaignId,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        job: yield* experiments.job({ projectId, jobId: queued.jobId }),
        created: queued.created,
        remaining: queued.remaining,
      };
    }),
  ),
  engine_job_get: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* callerProject;
      const experiments = yield* EngineExperimentService;
      return yield* experiments.job({ projectId, jobId: input.jobId, afterSeq: input.afterSeq });
    }),
  ),
  engine_job_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* callerProject;
      const experiments = yield* EngineExperimentService;
      return yield* experiments.cancel({ projectId, jobId: input.jobId, reason: input.reason });
    }),
  ),
  engine_promotion_request: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { projectId, threadId } = yield* callerProject;
      const promotion = yield* EnginePromotionService;
      return yield* promotion.request({
        projectId,
        threadId,
        candidate: input.candidateId,
        reportId: input.reportId,
        expectedActive: input.expectedActiveId,
        reason: input.reason,
      });
    }),
  ),
});
