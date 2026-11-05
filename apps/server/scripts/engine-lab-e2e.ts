#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - an end-to-end run over files it lays out itself.

// The engine lab end to end over a synthetic corpus: a scripted agent through the MCP toolkit,
// the operator's shadow and approval, then two real nightly runs of the trend engine, one with
// the approved manifest and one after the revert, checked by their hashes.
//   node apps/server/scripts/engine-lab-e2e.ts --out <dir> --models <revision dir>

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  labelSyntheticCards,
  SYNTHETIC_PROFILE,
  writeSyntheticCorpus,
} from "@earlyscript/engine-lab/synthetic";
import { REPO_ROOT } from "@earlyscript/engine-lab/testkit";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- a client of the registered toolkit, as the MCP tests are; it registers nothing.
import { McpSchema, McpServer } from "effect/ai";

import { EditorialImportService } from "../src/editorial/EditorialImportService.ts";
import * as EditorialJobsService from "../src/editorial/EditorialJobsService.ts";
import { EditorialPresentationService } from "../src/editorial/EditorialPresentationService.ts";
import * as EditorialProfile from "../src/editorial/EditorialProfileService.ts";
import * as EditorialSources from "../src/editorial/EditorialSourcesService.ts";
import * as EngineChangeService from "../src/editorial/EngineChangeService.ts";
import * as EngineExperimentService from "../src/editorial/EngineExperimentService.ts";
import * as EnginePromotionService from "../src/editorial/EnginePromotionService.ts";
import { DEFAULT_LAB_TIMING, layerOptionsWith } from "../src/editorial/engineLabSupport.ts";
import { verifyLabLedger } from "../src/editorial/engineLabVerify.ts";
import * as EditorialDatabase from "../src/editorial/persistence/EditorialDatabase.ts";
import { EditorialRunDirectory } from "../src/editorial/RunDirectory.ts";
import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../src/orchestration-v2/ThreadManagementService.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0 || args[at + 1] === undefined) throw new Error(`--${name} is required`);
  return NodePath.resolve(args[at + 1]!);
};
const out = flag("out");
const models = flag("models");
const PROJECT = "project:engine-lab-e2e";
const THREAD = "thread:engine-lab-e2e";
NodeFS.rmSync(out, { recursive: true, force: true });
NodeFS.mkdirSync(out, { recursive: true });

// Two synthetic corpora: December 2026 for the lab (its shadow comes after the request) and the
// weeks before today for the product's nightly run.
const lab = writeSyntheticCorpus({
  dir: NodePath.join(out, "lab"),
  fromDay: "2026-12-01",
  days: 26,
});
const now = DateTime.nowUnsafe();
const today = DateTime.formatIsoDate(now);
const nightlyFrom = DateTime.formatIsoDate(DateTime.subtract(now, { days: 26 }));
const product = writeSyntheticCorpus({
  dir: NodePath.join(out, "product"),
  fromDay: nightlyFrom,
  days: 26,
});
const db = NodePath.join(out, "state", "editorial.sqlite");
NodeFS.mkdirSync(NodePath.dirname(db), { recursive: true });
const engine = {
  cli: NodePath.join(REPO_ROOT, "packages/trend-engine/src/cli.ts"),
  defaultConfig: lab.config_path,
};
const profilePath = NodePath.join(out, "profile.json");

const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) =>
    Effect.succeed(
      (threadId === THREAD
        ? {
            id: threadId,
            projectId: PROJECT,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            interactionMode: "default",
            activeRunId: "run-e2e",
            archivedAt: null,
            deletedAt: null,
            pendingBackgroundTasks: [],
          }
        : null) as never,
    ),
});

const services = Layer.merge(EngineChangeService.layer, EngineExperimentService.layer).pipe(
  Layer.provideMerge(EnginePromotionService.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      layerOptionsWith({
        engine: Result.succeed(engine),
        engineRoot: REPO_ROOT,
        jobsRoot: NodePath.join(out, "state", "editorial-engine-lab", "jobs"),
        remote: null,
        ...DEFAULT_LAB_TIMING,
      }),
      EditorialSources.layerWithCorpusDir(product.corpus_dir),
      EditorialProfile.layer,
    ),
  ),
  Layer.provideMerge(EditorialDatabase.layerFromPath(db)),
);

/** No drafting in this run: every presentation is already done. */
const progressOf = (runId: string) =>
  ({
    runId,
    status: "idle",
    total: 0,
    ready: 0,
    failed: 0,
    startedAt: null,
    finishedAt: null,
  }) as never;

const nightlyLayer = EditorialJobsService.layerWith({
  engine: Result.succeed(engine),
  jobsDir: NodePath.join(out, "state", "editorial-jobs"),
  profilesDir: NodePath.join(out, "state", "editorial-profiles"),
  cacheFile: NodePath.join(out, "embeddings.sqlite"),
  modelsDir: models,
  ...EditorialJobsService.DEFAULT_JOB_TIMING,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(EditorialImportService)({
        importRun: (runId) => Effect.succeed({ runId, outcome: "imported" as const }),
        sync: Effect.succeed({ runs: [], returned: [] }),
      }),
      Layer.mock(EditorialPresentationService)({
        startRun: (runId) => Effect.succeed(progressOf(runId)),
        runProgress: (runId) => Effect.succeed(progressOf(runId)),
        awaitRun: (runId) => Effect.succeed(progressOf(runId)),
        draftingProviderEnabled: Effect.succeed(true),
        getBudget: Effect.succeed({ monthlyLimit: 0, usedThisMonth: 0, month: today.slice(0, 7) }),
      }),
      Layer.mock(EditorialRunDirectory)({ runsDir: NodePath.join(out, "state", "runs") }),
    ),
  ),
);

const layer = Layer.mergeAll(
  McpHttpServer.layerEngineLabToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(threads),
  ),
  nightlyLayer,
).pipe(Layer.provideMerge(services), Layer.provideMerge(NodeServices.layer));

const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment:engine-lab-e2e"),
  requestNamespace: "provider:engine-lab-e2e",
  thread: {
    threadId: ThreadId.make(THREAD),
    providerSessionId: "e2e",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "engine-lab-e2e", version: "1" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "engine-lab-e2e", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const calls: Array<{ tool: string; args: unknown; error: boolean; result: unknown }> = [];
const mcp = (tool: string, input: Record<string, unknown>) =>
  McpServer.McpServer.use((server) => server.callTool({ name: tool, arguments: input })).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.map((result) => {
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      calls.push({
        tool,
        args: input,
        error: result.isError === true,
        result: result.isError ? text : result.structuredContent,
      });
      if (result.isError) return { error: text } as Record<string, any>;
      return result.structuredContent as Record<string, any>;
    }),
  );

const write = (name: string, value: unknown) =>
  Effect.sync(() =>
    NodeFS.writeFileSync(NodePath.join(out, name), `${JSON.stringify(value, null, 2)}\n`),
  );

/** A real nightly run: the job's plan, the engine's run.json and the manifest file beside it. */
const realNightly = Effect.fn("EngineLabE2e.realNightly")(function* (label: string) {
  const jobs = yield* EditorialJobsService.EditorialJobsService;
  const job = yield* jobs.runNow;
  // One job per pass, oldest first: a job keyed with an older plan is replaced before ours.
  let done = job;
  for (let pass = 0; pass < 4 && (done.status === "pending" || done.status === "running"); pass++) {
    yield* jobs.runDue;
    done = (yield* jobs.list).jobs.find((entry) => entry.jobId === job.jobId)!;
  }
  const runDir = done.artifacts.runDir;
  const run =
    runDir === null
      ? null
      : JSON.parse(NodeFS.readFileSync(NodePath.join(runDir, "run.json"), "utf8"));
  const jobDir = done.artifacts.jobDir;
  const manifestFile = NodeFS.readdirSync(jobDir).find((name) =>
    name.startsWith("engine-manifest."),
  );
  const manifest =
    manifestFile === undefined
      ? null
      : JSON.parse(NodeFS.readFileSync(NodePath.join(jobDir, manifestFile), "utf8"));
  const evidence = {
    label,
    jobId: done.jobId,
    status: done.status,
    phases: done.artifacts.phases.map((phase) => `${phase.phase}:${phase.status}`),
    jobConfigHash: done.configHash,
    runId: run?.run_id ?? null,
    runStatus: run?.status ?? null,
    runConfigHash: run?.config_hash ?? null,
    runProfileHash: run?.profile?.hash ?? null,
    runLogicalHash: run?.logical_hash ?? null,
    dossiers: run?.dossiers ?? null,
    manifest,
  };
  yield* write(`nightly-${label}.json`, evidence);
  return evidence;
});

class E2eFailure extends Schema.TaggedError<E2eFailure>()("E2eFailure", {
  message: Schema.String,
}) {}

const program = Effect.gen(function* () {
  // The product: the synthetic channel's profile; HN and GitHub ranked, nothing captured.
  const profiles = yield* EditorialProfile.EditorialProfileService;
  yield* profiles.update({
    name: SYNTHETIC_PROFILE.name,
    audience: SYNTHETIC_PROFILE.audience,
    language: "en",
    include: [...SYNTHETIC_PROFILE.include],
    exclude: [...SYNTHETIC_PROFILE.exclude],
  });
  NodeFS.writeFileSync(profilePath, (yield* profiles.activeFile).bytes);
  const sources = yield* EditorialSources.EditorialSourcesService;
  for (const source of ["hn", "github"])
    yield* sources.update({ source, collect: false, rank: true });
  for (const entry of (yield* sources.list).sources) {
    if (entry.source !== "hn" && entry.source !== "github" && (entry.collect || entry.rank)) {
      yield* sources.update({ source: entry.source, collect: false, rank: false });
    }
  }
  const changes = yield* EngineChangeService.EngineChangeService;
  const experiments = yield* EngineExperimentService.EngineExperimentService;
  const promotion = yield* EnginePromotionService.EnginePromotionService;
  const policy = (cutoffs: ReadonlyArray<string>) => ({
    cutoffs,
    executor: "local" as const,
    corpus_dir: lab.corpus_dir,
    profile_path: profilePath,
    cache_file: null,
    cache_only: false,
    models_dir: null,
    embedder: "synthetic" as const,
    workers: 1,
    labels: { cards: lab.cards_path, labels: lab.labels_path },
    judge: null,
  });

  // Before the lab: the plan only (the job it keys), so the run after the revert is a new one.
  const beforeLab = yield* Effect.gen(function* () {
    const jobs = yield* EditorialJobsService.EditorialJobsService;
    const job = yield* jobs.runNow;
    return { jobConfigHash: job.configHash, profileHash: job.profileHash };
  });
  // Operator: a development campaign of three evaluations.
  const campaign = yield* changes.createCampaign({
    projectId: PROJECT,
    kind: "development",
    budget: 3,
    policy: policy(lab.cutoffs.slice(0, 3)),
    actor: "operator",
  });

  // The agent, through the MCP toolkit.
  const active = (yield* mcp("engine_inspect", { target: "active" })).active;
  const better = yield* mcp("engine_candidate_create", {
    baseId: active.manifestId,
    intent: "Rank topics many people write about above one-account spikes.",
    hypothesis: "More weight on authors puts founders' topics in the top 5.",
    idempotencyKey: "better",
    change: { kind: "config", weights: { growth: 0.1, log_authors_7d: 0.9 } },
  });
  const worse = yield* mcp("engine_candidate_create", {
    baseId: active.manifestId,
    intent: "Deliberately worse: growth only.",
    hypothesis: "Spikes from one account win.",
    idempotencyKey: "worse",
    change: { kind: "config", weights: { growth: 2, log_authors_7d: 0 } },
  });
  const code = (yield* mcp("engine_inspect", { target: "code" })).code;
  const rankFirst = String(code.files["packages/trend-engine/src/rank.ts"]).split("\n")[0];
  const patch = `--- a/packages/trend-engine/src/rank.ts\n+++ b/packages/trend-engine/src/rank.ts\n@@ -1,1 +1,2 @@\n ${rankFirst}\n+// Same computation: the outputs stay logically equal.\n`;
  const coded = yield* mcp("engine_candidate_create", {
    baseId: active.manifestId,
    intent: "Pure refactor of rank.ts.",
    hypothesis: "Logically equal outputs.",
    idempotencyKey: "code",
    change: { kind: "code", baseSourceHash: code.baseSourceHash, patch },
  });
  const extra = yield* mcp("engine_candidate_create", {
    baseId: active.manifestId,
    intent: "A fourth idea.",
    hypothesis: "Over budget.",
    idempotencyKey: "extra",
    change: { kind: "config", weights: { growth: 0.3 } },
  });
  const jobs: Record<string, any> = {};
  for (const [name, made] of Object.entries({ better, worse, code: coded, extra })) {
    jobs[name] = yield* mcp("engine_evaluate", {
      candidateId: made.candidate.manifestId,
      campaignId: campaign.campaignId,
      idempotencyKey: name,
    });
  }
  for (let k = 0; k < 3; k++) yield* experiments.runDue;
  const reports: Record<string, any> = {};
  for (const name of ["better", "worse", "code"])
    reports[name] = yield* mcp("engine_job_get", { jobId: jobs[name].job.jobId });
  yield* mcp("engine_inspect", { target: "run", id: jobs.better.job.jobId });
  const askBetter = yield* mcp("engine_promotion_request", {
    candidateId: better.candidate.manifestId,
    reportId: reports.better.reportId,
    expectedActiveId: active.manifestId,
    reason: "Better G@5 in development.",
  });
  const askWorse = yield* mcp("engine_promotion_request", {
    candidateId: worse.candidate.manifestId,
    reportId: reports.worse.reportId,
    expectedActiveId: active.manifestId,
    reason: "Try it.",
  });
  const askCode = yield* mcp("engine_promotion_request", {
    candidateId: coded.candidate.manifestId,
    reportId: reports.code.reportId,
    expectedActiveId: active.manifestId,
    reason: "Equal outputs.",
  });

  // The operator: a prospective shadow per request, blind cards, labels, gate.
  const shadow = Effect.fn("EngineLabE2e.shadow")(function* (requestId: string) {
    const created = yield* changes.createCampaign({
      projectId: PROJECT,
      kind: "shadow",
      budget: 1,
      policy: policy(lab.cutoffs.slice(3, 10)),
      actor: "operator",
      requestId,
      referenceHash: active.manifestHash,
    });
    const { jobId } = yield* changes.startShadow(created.campaignId);
    yield* experiments.runDue;
    const cards = (yield* experiments.shadowCards(jobId)) as Parameters<
      typeof labelSyntheticCards
    >[0];
    const labelsPath = NodePath.join(out, `${requestId}-labels.json`);
    NodeFS.writeFileSync(
      NodePath.join(out, `${requestId}-cards.jsonl`),
      cards.map((card) => `${JSON.stringify(card)}\n`).join(""),
    );
    NodeFS.writeFileSync(
      labelsPath,
      JSON.stringify({ labeler: "synthetic", labels: labelSyntheticCards(cards) }),
    );
    return yield* experiments.scoreShadow({ jobId, labelsPath, actor: "operator" });
  });
  const gateBetter = yield* shadow(askBetter.requestId);
  const gateWorse = yield* shadow(askWorse.requestId);
  const refusals: Record<string, unknown> = {};
  for (const [name, request] of Object.entries({ worse: askWorse, code: askCode })) {
    const outcome = yield* Effect.result(
      promotion.approve({ requestId: request.requestId, actor: "operator", reason: "e2e" }),
    );
    refusals[name] = Result.isFailure(outcome) ? outcome.failure : "approved";
  }
  const approved = yield* promotion.approve({
    requestId: askBetter.requestId,
    actor: "operator",
    reason: "Shadow passed.",
  });
  const afterApproval = yield* realNightly("1-approved");
  const reverted = yield* promotion.revert({
    actor: "operator",
    reason: "Back to the installed engine.",
    expectedActive: approved.manifest_hash,
  });
  const afterRevert = yield* realNightly("2-reverted");
  const ledger = yield* verifyLabLedger;
  const summary = {
    beforeLab,
    installed: {
      manifestHash: active.manifestHash,
      configHash: active.configHash,
      engineSourceHash: active.engineSourceHash,
    },
    candidates: {
      better: better.candidate.manifestHash,
      worse: worse.candidate.manifestHash,
      code: coded.candidate.manifestHash,
    },
    budget: { fourth: jobs.extra },
    development: Object.fromEntries(
      Object.entries(reports).map(([name, job]) => [
        name,
        {
          status: job.status,
          verdict: job.report?.human?.verdict,
          g5: job.report?.human?.candidate?.g5,
          reference_g5: job.report?.human?.reference?.g5,
          equivalent: job.report?.equivalent,
          sandbox: job.report?.sandbox,
        },
      ]),
    ),
    gates: {
      better: gateBetter.verdict,
      worse: gateWorse.verdict,
      betterAdvantage: gateBetter.g5_advantage,
    },
    refusals,
    approved,
    afterApproval: {
      runId: afterApproval.runId,
      configHash: afterApproval.runConfigHash,
      profileHash: afterApproval.runProfileHash,
      manifest: afterApproval.manifest,
      status: afterApproval.runStatus,
    },
    reverted,
    afterRevert: {
      runId: afterRevert.runId,
      configHash: afterRevert.runConfigHash,
      profileHash: afterRevert.runProfileHash,
      manifest: afterRevert.manifest,
      status: afterRevert.runStatus,
    },
    checks: {
      approvedRunUsesCandidateConfig:
        afterApproval.runConfigHash ===
        (yield* changes.candidate(PROJECT, better.candidate.manifestHash)).configHash,
      approvedRunManifest: afterApproval.manifest?.manifest_hash === better.candidate.manifestHash,
      planBeforeLabIsInstalled: beforeLab.jobConfigHash === active.configHash,
      revertRestoresConfig: afterRevert.runConfigHash === active.configHash,
      revertRestoresManifest: afterRevert.manifest?.manifest_hash === active.manifestHash,
      sameProfile:
        new Set([beforeLab.profileHash, afterApproval.runProfileHash, afterRevert.runProfileHash])
          .size === 1,
      sameCode:
        new Set([
          afterApproval.manifest?.engine_source_hash,
          afterRevert.manifest?.engine_source_hash,
          active.engineSourceHash,
        ]).size === 1,
      freshRuns: afterApproval.runId !== afterRevert.runId && afterRevert.status === "done",
      ledger: ledger.ok,
    },
    ledger,
  };
  yield* write("mcp-calls.json", calls);
  yield* write("summary.json", summary);
  yield* Console.log(JSON.stringify(summary.checks, null, 2));
  if (!Object.values(summary.checks).every(Boolean))
    return yield* new E2eFailure({ message: "an end-to-end check failed; see summary.json" });
});

program.pipe(Effect.provide(layer), NodeRuntime.runMain);
