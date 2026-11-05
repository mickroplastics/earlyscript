// @effect-diagnostics nodeBuiltinImport:off - the lab's worker runs the real engine over a synthetic corpus on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { EngineChangeService } from "../EngineChangeService.ts";
import { EngineExperimentService } from "../EngineExperimentService.ts";
import {
  labHarness,
  labLayer,
  OTHER_PROJECT,
  syntheticPolicy,
  TEST_PROJECT,
  useSyntheticProfile,
  type LabHarness,
} from "../engineLab.testkit.ts";
import { makeTempDir, removeDir } from "../persistence/EditorialDatabase.testkit.ts";
import { EngineLabToolkit } from "./tools.ts";

const LIVE = "thread-lab";
const STOPPED = "thread-stopped";
const OTHER = "thread-other";

const shells: Record<string, { projectId: string; activeRunId: string | null }> = {
  [LIVE]: { projectId: TEST_PROJECT, activeRunId: "run-1" },
  [STOPPED]: { projectId: TEST_PROJECT, activeRunId: null },
  [OTHER]: { projectId: OTHER_PROJECT, activeRunId: "run-2" },
};

const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => {
    const shell = shells[threadId];
    return Effect.succeed(
      (shell === undefined
        ? null
        : {
            id: threadId,
            projectId: shell.projectId,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            interactionMode: "default",
            activeRunId: shell.activeRunId,
            archivedAt: null,
            deletedAt: null,
            pendingBackgroundTasks: [],
          }) as never,
    );
  },
});

const scopeOf = (
  threadId: string,
  readOnly = false,
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment:engine-lab"),
  requestNamespace: "provider:engine-lab",
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: "provider:engine-lab",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: readOnly
    ? { sessionId: "client-ro", label: "read-only client", access: "read-only" }
    : undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "engine-lab-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "engine-lab-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const serverLayer = (harness: LabHarness) =>
  McpHttpServer.layerEngineLabToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(layerThreads),
    Layer.provideMerge(labLayer(harness)),
  );

const call = (name: string, args: Record<string, unknown>, threadId = LIVE, readOnly = false) =>
  McpServer.McpServer.use((server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(threadId, readOnly)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

const ok = (result: McpSchema.CallToolResult) => {
  expect(result.isError, JSON.stringify(result.content)).toBe(false);
  return result.structuredContent as Record<string, any>;
};
const refusal = (result: McpSchema.CallToolResult) => {
  expect(result.isError).toBe(true);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

/** A harness with the synthetic profile and an open campaign of `budget` evaluations. */
const withLab = <A, E>(
  body: (input: {
    harness: LabHarness;
    campaignId: string;
    activeId: string;
  }) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof serverLayer>>>,
  budget = 3,
) => {
  const dir = makeTempDir();
  const harness = labHarness(dir);
  return Effect.gen(function* () {
    yield* useSyntheticProfile(harness);
    const changes = yield* EngineChangeService;
    const campaign = yield* changes.createCampaign({
      projectId: TEST_PROJECT,
      kind: "development",
      budget,
      policy: syntheticPolicy(harness),
      actor: "miguel",
    });
    const inspect = ok(yield* call("engine_inspect", { target: "active" }));
    return yield* body({
      harness,
      campaignId: campaign.campaignId,
      activeId: inspect.active.manifestId,
    });
  }).pipe(Effect.provide(serverLayer(harness)), Effect.ensuring(removeDir(dir)));
};

const weights = (activeId: string, key: string, change: Record<string, number>) =>
  call("engine_candidate_create", {
    baseId: activeId,
    intent: "Favour topics many people write about.",
    hypothesis: "More authors, more founders in the top 5.",
    idempotencyKey: key,
    change: { kind: "config", weights: change },
  });

it("the engine catalog has six tools and none that approves or activates", () => {
  expect(Object.keys(EngineLabToolkit.tools)).toEqual([
    "engine_inspect",
    "engine_candidate_create",
    "engine_evaluate",
    "engine_job_get",
    "engine_job_cancel",
    "engine_promotion_request",
  ]);
  const evaluate = EngineLabToolkit.tools.engine_evaluate.parametersSchema as unknown as {
    fields: object;
  };
  // Cutoffs, corpus and labels are the campaign's: the call cannot name them.
  expect(Object.keys(evaluate.fields)).toEqual(["candidateId", "campaignId", "idempotencyKey"]);
});

it.live(
  "reads and writes only as a live thread of the campaign's project, never as a read-only client",
  () =>
    withLab(({ activeId, campaignId }) =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const readOnly = Object.fromEntries(
          server.tools.map((entry) => [entry.tool.name, entry.tool.annotations?.readOnlyHint]),
        );
        expect(readOnly).toMatchObject({
          engine_inspect: true,
          engine_job_get: true,
          engine_candidate_create: false,
        });
        for (const name of ["engine_promote", "engine_approve", "engine_activate"]) {
          const error = yield* Effect.flip(call(name, {}));
          expect(error).toMatchObject({ _tag: "InvalidParams" });
        }
        expect(
          refusal(
            yield* call(
              "engine_candidate_create",
              {
                baseId: activeId,
                intent: "x",
                hypothesis: "y",
                idempotencyKey: "ro2",
                change: { kind: "config", weights: { growth: 0.2 } },
              },
              LIVE,
              true,
            ),
          ),
        ).toContain("read-only access");
        // An expired session: the thread no longer runs.
        expect(
          refusal(
            yield* call(
              "engine_candidate_create",
              {
                baseId: activeId,
                intent: "x",
                hypothesis: "y",
                idempotencyKey: "s",
                change: { kind: "config", weights: { growth: 0.2 } },
              },
              STOPPED,
            ),
          ),
        ).toContain("no longer owns an active thread run");
        // Another project has no campaign, and cannot read this one's candidates or jobs.
        const created = ok(yield* weights(activeId, "k1", { growth: 0.2 }));
        expect(
          refusal(
            yield* call(
              "engine_inspect",
              { target: "candidate", id: created.candidate.manifestId },
              OTHER,
            ),
          ),
        ).toContain("permission-denied");
        expect(
          refusal(
            yield* call(
              "engine_candidate_create",
              {
                baseId: activeId,
                intent: "x",
                hypothesis: "y",
                idempotencyKey: "o",
                change: { kind: "config", weights: { growth: 0.3 } },
              },
              OTHER,
            ),
          ),
        ).toContain("permission-denied");
        const queued = ok(
          yield* call("engine_evaluate", {
            candidateId: created.candidate.manifestId,
            campaignId,
            idempotencyKey: "e1",
          }),
        );
        expect(
          refusal(yield* call("engine_job_get", { jobId: queued.job.jobId }, OTHER)),
        ).toContain("permission-denied");
        expect(
          refusal(
            yield* call(
              "engine_evaluate",
              { candidateId: created.candidate.manifestId, campaignId, idempotencyKey: "e2" },
              OTHER,
            ),
          ),
        ).toContain("permission-denied");
      }),
    ),
);

it.live("validates every change before it stores a candidate, and candidates are immutable", () =>
  withLab(({ activeId }) =>
    Effect.gen(function* () {
      const create = (key: string, change: Record<string, unknown>) =>
        call("engine_candidate_create", {
          baseId: activeId,
          intent: "i",
          hypothesis: "h",
          idempotencyKey: key,
          change,
        });
      expect(
        refusal(yield* create("nan", { kind: "config", weights: { growth: "NaN" } })),
      ).toContain("invalid-change");
      expect(
        refusal(yield* create("inf", { kind: "config", weights: { growth: "Infinity" } })),
      ).toContain("invalid-change");
      expect(
        refusal(
          yield* create("unknown", {
            kind: "config",
            weights: { growth: 0.2 },
            cluster: { threshold: 0.5 },
          }),
        ),
      ).toContain("Unknown keys cluster");
      expect(refusal(yield* create("profile", { kind: "profile", include: ["x"] }))).toContain(
        "unsupported-change",
      );
      const code = ok(yield* call("engine_inspect", { target: "code" })).code;
      expect(Object.keys(code.files)).toEqual([
        "packages/trend-engine/src/rank.ts",
        "packages/trend-engine/src/relevance.ts",
        "packages/trend-engine/src/series.ts",
      ]);
      const outside =
        "--- a/packages/trend-engine/src/editorial-score.ts\n+++ b/packages/trend-engine/src/editorial-score.ts\n@@ -1 +1 @@\n-a\n+b\n";
      expect(
        refusal(
          yield* create("outside", {
            kind: "code",
            baseSourceHash: code.baseSourceHash,
            patch: outside,
          }),
        ),
      ).toContain("outside the files");
      const rank = code.files["packages/trend-engine/src/rank.ts"].split("\n");
      const patch = `--- a/packages/trend-engine/src/rank.ts\n+++ b/packages/trend-engine/src/rank.ts\n@@ -1,1 +1,2 @@\n ${rank[0]}\n+// a comment\n`;
      expect(
        refusal(yield* create("stale", { kind: "code", baseSourceHash: "sha256:0", patch })),
      ).toContain("stale-base");
      const made = ok(
        yield* create("code", { kind: "code", baseSourceHash: code.baseSourceHash, patch }),
      );
      expect(made.candidate.kind).toBe("code");
      // The same key and change answers the same candidate; the same key with another, a refusal.
      expect(
        ok(yield* create("code", { kind: "code", baseSourceHash: code.baseSourceHash, patch }))
          .created,
      ).toBe(false);
      expect(
        refusal(yield* create("code", { kind: "config", weights: { growth: 0.2 } })),
      ).toContain("already made another candidate");
    }),
  ),
);

it.live("four evaluations against a budget of three take three seats, also after a restart", () => {
  const dir = makeTempDir();
  const harness = labHarness(dir);
  const setup = Effect.gen(function* () {
    yield* useSyntheticProfile(harness);
    const changes = yield* EngineChangeService;
    const campaign = yield* changes.createCampaign({
      projectId: TEST_PROJECT,
      kind: "development",
      budget: 3,
      policy: syntheticPolicy(harness),
      actor: "miguel",
    });
    const active = ok(yield* call("engine_inspect", { target: "active" })).active
      .manifestId as string;
    const ids: Array<string> = [];
    for (const [k, growth] of [0.1, 0.2, 0.3, 0.4].entries())
      ids.push(ok(yield* weights(active, `c${k}`, { growth })).candidate.manifestId);
    const results = yield* Effect.forEach(
      ids,
      (candidateId, k) =>
        call("engine_evaluate", {
          candidateId,
          campaignId: campaign.campaignId,
          idempotencyKey: `e${k}`,
        }),
      { concurrency: "unbounded" },
    );
    const accepted = results.filter((result) => !result.isError);
    expect(accepted).toHaveLength(3);
    expect(refusal(results.find((result) => result.isError)!)).toContain("budget-exhausted");
    // A retry with the same key, or the same candidate under another key, takes no seat.
    const first = ok(accepted[0]!);
    const again = ok(
      yield* call("engine_evaluate", {
        candidateId: first.job.candidateHash,
        campaignId: campaign.campaignId,
        idempotencyKey: "other-key",
      }),
    );
    expect(again).toMatchObject({ created: false, job: { jobId: first.job.jobId } });
    return { campaignId: campaign.campaignId, active, ids };
  }).pipe(Effect.provide(serverLayer(harness)));
  const afterRestart = (state: { campaignId: string; active: string; ids: Array<string> }) =>
    Effect.gen(function* () {
      const fifth = ok(yield* weights(state.active, "c5", { growth: 0.45 })).candidate.manifestId;
      expect(
        refusal(
          yield* call("engine_evaluate", {
            candidateId: fifth,
            campaignId: state.campaignId,
            idempotencyKey: "e5",
          }),
        ),
      ).toContain("budget-exhausted");
      const inspect = ok(yield* call("engine_inspect", { target: "active" }));
      expect(inspect.campaigns[0]).toMatchObject({ budget: 3, used: 3, remaining: 0 });
    }).pipe(Effect.provide(serverLayer(harness)));
  return setup.pipe(Effect.flatMap(afterRestart), Effect.ensuring(removeDir(dir)));
});

it.live("evaluates in the background and reports both engines over the same cutoffs", () =>
  withLab(({ activeId, campaignId }) =>
    Effect.gen(function* () {
      const candidate = ok(yield* weights(activeId, "better", { growth: 0.1, log_authors_7d: 0.9 }))
        .candidate.manifestId;
      const queued = ok(
        yield* call("engine_evaluate", { candidateId: candidate, campaignId, idempotencyKey: "b" }),
      );
      expect(queued.job.status).toBe("queued");
      yield* (yield* EngineExperimentService).runDue;
      const job = ok(yield* call("engine_job_get", { jobId: queued.job.jobId }));
      expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
      expect(job.report.human).toMatchObject({
        labeler: "synthetic",
        validated_per_item: true,
        verdict: "better",
      });
      expect(job.report.notes[0]).toContain("not the promotion gate");
      const run = ok(yield* call("engine_inspect", { target: "run", id: queued.job.jobId })).run;
      expect(run.candidate[0].top[0].components.map((c: { name: string }) => c.name)).toEqual([
        "growth",
        "log_authors_7d",
        "include_score",
      ]);
      expect(run.candidate[0].top[0]).not.toHaveProperty("item_ids");
      expect(run.candidate[0].top.length).toBeLessThanOrEqual(5);
      expect(run.candidate[0].top[0].human_label).toBeTypeOf("string");
    }),
  ),
);

it.live("cancels a queued job without running it; its seat stays used", () =>
  withLab(({ activeId, campaignId }) =>
    Effect.gen(function* () {
      const candidate = ok(yield* weights(activeId, "x", { growth: 0.3 })).candidate.manifestId;
      const queued = ok(
        yield* call("engine_evaluate", { candidateId: candidate, campaignId, idempotencyKey: "x" }),
      );
      const cancelled = ok(
        yield* call("engine_job_cancel", { jobId: queued.job.jobId, reason: "changed my mind" }),
      );
      expect(cancelled.status).toBe("cancelled");
      yield* (yield* EngineExperimentService).runDue;
      expect(ok(yield* call("engine_job_get", { jobId: queued.job.jobId })).status).toBe(
        "cancelled",
      );
      expect(ok(yield* call("engine_inspect", { target: "active" })).campaigns[0]).toMatchObject({
        used: 1,
      });
    }),
  ),
);

it.live("cancels a running job by its process group and accepts no result", () =>
  withLab(({ harness, activeId, campaignId }) =>
    Effect.gen(function* () {
      const code = ok(yield* call("engine_inspect", { target: "code" })).code;
      const rank = code.files["packages/trend-engine/src/rank.ts"].split("\n");
      const slow = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);";
      const patch = `--- a/packages/trend-engine/src/rank.ts\n+++ b/packages/trend-engine/src/rank.ts\n@@ -1,1 +1,2 @@\n ${rank[0]}\n+${slow}\n`;
      const candidate = ok(
        yield* call("engine_candidate_create", {
          baseId: activeId,
          intent: "slow",
          hypothesis: "slow",
          idempotencyKey: "slow",
          change: { kind: "code", baseSourceHash: code.baseSourceHash, patch },
        }),
      ).candidate.manifestId;
      const queued = ok(
        yield* call("engine_evaluate", {
          candidateId: candidate,
          campaignId,
          idempotencyKey: "slow",
        }),
      );
      const experiments = yield* EngineExperimentService;
      const running = yield* Effect.forkChild(experiments.runDue);
      // The candidate's arm is blocked: wait for the worker to record its process group.
      const token = `job-${queued.job.jobId.replace(/^job_/, "")}`;
      yield* waitForFile(NodePath.join(harness.options.jobsRoot, token, "candidate"));
      const cancelled = ok(
        yield* call("engine_job_cancel", { jobId: queued.job.jobId, reason: "too slow" }),
      );
      expect(cancelled.events.map((e: { kind: string }) => e.kind)).toContain("cancel-requested");
      yield* Fiber.join(running);
      const job = ok(yield* call("engine_job_get", { jobId: queued.job.jobId }));
      expect(job).toMatchObject({ status: "cancelled", reportId: null });
      expect(NodeFS.existsSync(NodePath.join(harness.options.jobsRoot, token, "result.json"))).toBe(
        false,
      );
    }),
  ),
);

it.live("refuses a promotion request against an engine that is no longer active", () =>
  withLab(({ activeId, campaignId }) =>
    Effect.gen(function* () {
      const candidate = ok(yield* weights(activeId, "p", { growth: 0.1, log_authors_7d: 0.9 }))
        .candidate.manifestId;
      const queued = ok(
        yield* call("engine_evaluate", { candidateId: candidate, campaignId, idempotencyKey: "p" }),
      );
      yield* (yield* EngineExperimentService).runDue;
      const reportId = ok(yield* call("engine_job_get", { jobId: queued.job.jobId })).reportId;
      const asked = ok(
        yield* call("engine_promotion_request", {
          candidateId: candidate,
          reportId,
          expectedActiveId: activeId,
          reason: "better in development",
        }),
      );
      expect(asked.status).toBe("requested");
      expect(asked.pendingChecks.join(" ")).toContain("shadow");
      expect(
        refusal(
          yield* call("engine_promotion_request", {
            candidateId: candidate,
            reportId,
            expectedActiveId: candidate,
            reason: "x",
          }),
        ),
      ).toContain("stale-base");
    }),
  ),
);

/** Resolves when `path` exists, from file system events rather than polling. */
const waitForFile = (path: string) =>
  Effect.callback<void>((resume) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.dirname(path)), { recursive: true });
    if (NodeFS.existsSync(path)) return resume(Effect.void);
    const watcher = NodeFS.watch(
      NodePath.dirname(NodePath.dirname(path)),
      { recursive: true },
      () => {
        if (NodeFS.existsSync(path)) {
          watcher.close();
          resume(Effect.void);
        }
      },
    );
    return Effect.sync(() => watcher.close());
  });
