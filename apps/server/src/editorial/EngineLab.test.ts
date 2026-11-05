// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the lab's worker files and the nightly job's files are on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { artifactCli } from "@earlyscript/engine-lab/artifact";
import { engineSourceHash } from "@earlyscript/engine-lab/hash";
import { labelSyntheticCards } from "@earlyscript/engine-lab/synthetic";
import { REPO_ROOT } from "@earlyscript/engine-lab/testkit";
import { evaluateJob } from "@earlyscript/engine-lab/worker";
import type { JobSpec } from "@earlyscript/engine-lab/result";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { EditorialImportService } from "./EditorialImportService.ts";
import * as EditorialJobsService from "./EditorialJobsService.ts";
import { EditorialPresentationService } from "./EditorialPresentationService.ts";
import { EditorialProfileService } from "./EditorialProfileService.ts";
import { EngineChangeService } from "./EngineChangeService.ts";
import { EngineExperimentService } from "./EngineExperimentService.ts";
import { EnginePromotionService } from "./EnginePromotionService.ts";
import {
  labHarness,
  labLayer,
  syntheticPolicy,
  TEST_PROJECT,
  useSyntheticProfile,
  type LabHarness,
} from "./engineLab.testkit.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { EditorialSourcesService } from "./EditorialSourcesService.ts";
import { makeTempDir, removeDir } from "./persistence/EditorialDatabase.testkit.ts";
import { EditorialRunDirectory } from "./RunDirectory.ts";

const withHarness = <A, E>(
  body: (harness: LabHarness) => Effect.Effect<A, E, Layer.Success<ReturnType<typeof labLayer>>>,
  overrides: Parameters<typeof labHarness>[1] = {},
) => {
  const dir = makeTempDir();
  const harness = labHarness(dir, overrides);
  return Effect.gen(function* () {
    yield* useSyntheticProfile(harness);
    return yield* body(harness);
  }).pipe(Effect.provide(labLayer(harness)), Effect.ensuring(removeDir(dir)));
};

/** A candidate of `weights`, evaluated in a development campaign, and its report. */
const evaluated = (harness: LabHarness, key: string, weights: Record<string, number>) =>
  Effect.gen(function* () {
    const changes = yield* EngineChangeService;
    const experiments = yield* EngineExperimentService;
    const promotion = yield* EnginePromotionService;
    const active = yield* promotion.active;
    const campaign = yield* changes.createCampaign({
      projectId: TEST_PROJECT,
      kind: "development",
      budget: 3,
      policy: syntheticPolicy(harness),
      actor: "miguel",
    });
    const created = yield* changes.createCandidate({
      projectId: TEST_PROJECT,
      threadId: "thread-lab",
      base: active.hash,
      intent: "i",
      hypothesis: "h",
      idempotencyKey: key,
      change: { kind: "config", weights },
    });
    const queued = yield* changes.evaluate({
      projectId: TEST_PROJECT,
      threadId: "thread-lab",
      candidate: created.candidate.manifestHash,
      campaignId: campaign.campaignId,
      idempotencyKey: key,
    });
    yield* experiments.runDue;
    const job = yield* experiments.job({ projectId: TEST_PROJECT, jobId: queued.jobId });
    expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
    return {
      active,
      candidate: created.candidate.manifestHash,
      job,
      campaignId: campaign.campaignId,
    };
  });

/** The request's prospective shadow, labelled blind as the synthetic channel would. */
const shadowFor = (harness: LabHarness, requestId: string, labelled: "all" | "none" = "all") =>
  Effect.gen(function* () {
    const changes = yield* EngineChangeService;
    const experiments = yield* EngineExperimentService;
    const campaign = yield* changes.createCampaign({
      projectId: TEST_PROJECT,
      kind: "shadow",
      budget: 1,
      // Cutoffs after the request: the synthetic corpus lies in December 2026.
      policy: syntheticPolicy(harness, harness.fixture.cutoffs.slice(3, 10)),
      actor: "miguel",
      requestId,
      referenceHash: (yield* (yield* EnginePromotionService).active).hash,
    });
    const { jobId } = yield* changes.startShadow(campaign.campaignId);
    yield* experiments.runDue;
    const cards = (yield* experiments.shadowCards(jobId)) as Parameters<
      typeof labelSyntheticCards
    >[0];
    const labelsPath = NodePath.join(harness.dir, `${jobId}-labels.json`);
    NodeFS.writeFileSync(
      labelsPath,
      JSON.stringify({
        labeler: "synthetic",
        labels: labelled === "all" ? labelSyntheticCards(cards) : [],
      }),
    );
    return yield* experiments.scoreShadow({ jobId, labelsPath, actor: "miguel" });
  });

it.live("refuses campaigns over the frozen evaluation's cutoffs or files", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const changes = yield* EngineChangeService;
      const sealed = yield* Effect.flip(
        changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 3,
          policy: syntheticPolicy(harness, ["2026-11-06"]),
          actor: "miguel",
        }),
      );
      expect(sealed.code).toBe("sealed-partition");
      const ledger = yield* Effect.flip(
        changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 3,
          policy: {
            ...syntheticPolicy(harness),
            labels: {
              cards: "/home/mick/earlyscript-data/eval-prospectivo/cards.jsonl",
              labels: "/x/labels.json",
            },
          },
          actor: "miguel",
        }),
      );
      expect(ledger.code).toBe("sealed-partition");
    }),
  ),
);

it.live(
  "refuses campaign inputs that resolve into the frozen evaluation or outside the authorized roots (Sol, B2)",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const changes = yield* EngineChangeService;
        // Synthetic stand-ins named like the sealed directories; no real reserve is touched.
        const sealedDir = NodePath.join(harness.dir, "eval-prospectivo", "corpus");
        NodeFS.mkdirSync(NodePath.dirname(sealedDir), { recursive: true });
        NodeFS.cpSync(harness.fixture.corpus_dir, sealedDir, { recursive: true });
        const alias = NodePath.join(harness.dir, "friendly-corpus");
        NodeFS.symlinkSync(sealedDir, alias);
        const create = (policy: ReturnType<typeof syntheticPolicy>) =>
          Effect.flip(
            changes.createCampaign({
              projectId: TEST_PROJECT,
              kind: "development",
              budget: 3,
              policy,
              actor: "miguel",
            }),
          );
        expect((yield* create({ ...syntheticPolicy(harness), corpus_dir: alias })).code).toBe(
          "sealed-partition",
        );
        const labels = NodePath.join(harness.dir, "labels-link.json");
        NodeFS.copyFileSync(
          harness.fixture.labels_path,
          NodePath.join(harness.dir, "eval-prospectivo", "labels.json"),
        );
        NodeFS.symlinkSync(NodePath.join(harness.dir, "eval-prospectivo", "labels.json"), labels);
        const policy = syntheticPolicy(harness);
        expect(
          (yield* create({ ...policy, labels: { cards: policy.labels.cards, labels } })).code,
        ).toBe("sealed-partition");
        expect((yield* create({ ...policy, input_roots: [harness.fixture.corpus_dir] })).code).toBe(
          "permission-denied",
        );
        expect((yield* create({ ...policy, input_roots: [] })).code).toBe("permission-denied");
        const ok = yield* changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 3,
          policy,
          actor: "miguel",
        });
        expect(ok.cutoffs).toEqual(policy.cutoffs);
      }),
    ),
);

it.live("a shadow over one day repeated is refused, and so is the promotion (Sol, B3)", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const changes = yield* EngineChangeService;
      const promotion = yield* EnginePromotionService;
      const better = yield* evaluated(harness, "repeat", { growth: 0.1, log_authors_7d: 0.9 });
      const request = yield* promotion.request({
        projectId: TEST_PROJECT,
        threadId: null,
        candidate: better.candidate,
        reportId: better.job.reportId!,
        expectedActive: better.active.hash,
        reason: "repeat",
      });
      const shadow = (cutoffs: ReadonlyArray<string>) =>
        Effect.flip(
          changes.createCampaign({
            projectId: TEST_PROJECT,
            kind: "shadow",
            budget: 1,
            policy: syntheticPolicy(harness, cutoffs),
            actor: "miguel",
            requestId: request.requestId,
            referenceHash: better.active.hash,
          }),
        );
      const day = harness.fixture.cutoffs[6]!;
      expect((yield* shadow(Array(7).fill(day))).message).toContain("repeat");
      expect((yield* shadow([day, day.slice(0, 10), harness.fixture.cutoffs[7]!])).code).toBe(
        "invalid-change",
      );
      expect((yield* shadow(harness.fixture.cutoffs.slice(3, 6))).code).toBe(
        "insufficient-evidence",
      );
      const refused = yield* Effect.flip(
        promotion.approve({ requestId: request.requestId, actor: "miguel", reason: "accept gate" }),
      );
      expect(refused.code).toBe("insufficient-evidence");
      expect((yield* promotion.history).filter((row) => row.kind === "promote")).toHaveLength(0);
    }),
  ),
);

it.live(
  "after a crash, the next pass takes the lapsed job and accepts the worker's one result",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const sql = yield* EditorialSql;
        const changes = yield* EngineChangeService;
        const experiments = yield* EngineExperimentService;
        const active = yield* (yield* EnginePromotionService).active;
        const campaign = yield* changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 3,
          policy: syntheticPolicy(harness),
          actor: "miguel",
        });
        const make = (key: string, growth: number) =>
          Effect.gen(function* () {
            const created = yield* changes.createCandidate({
              projectId: TEST_PROJECT,
              threadId: null,
              base: active.hash,
              intent: "i",
              hypothesis: "h",
              idempotencyKey: key,
              change: { kind: "config", weights: { growth } },
            });
            return yield* changes.evaluate({
              projectId: TEST_PROJECT,
              threadId: null,
              candidate: created.candidate.manifestHash,
              campaignId: campaign.campaignId,
              idempotencyKey: key,
            });
          });
        // The server died while each worker ran: the worker finished alone, the lease lapsed.
        const crashed = (jobId: string, tamper: boolean) =>
          Effect.gen(function* () {
            const [row] = yield* sql<{
              spec_json: string;
              secret: string;
            }>`SELECT spec_json, secret FROM editorial_engine_jobs WHERE job_id = ${jobId}`;
            const spec = { ...(JSON.parse(row!.spec_json) as JobSpec), secret: row!.secret };
            const result = yield* Effect.promise(() =>
              evaluateJob(spec, {
                jobsRoot: harness.options.jobsRoot,
                engineRoot: harness.options.engineRoot!,
              }),
            );
            if (tamper) {
              const file = NodePath.join(harness.options.jobsRoot, spec.token, "result.json");
              const first = result.arms.candidate[0]!;
              NodeFS.writeFileSync(
                file,
                JSON.stringify({
                  ...result,
                  arms: {
                    ...result.arms,
                    candidate: [
                      { ...first, top: first.top.toReversed() },
                      ...result.arms.candidate.slice(1),
                    ],
                  },
                }),
              );
            }
            yield* sql`UPDATE editorial_engine_jobs SET status = 'running', tries = 1, lease_owner = 'dead', lease_generation = 1, lease_until = '2000-01-01T00:00:00.000Z' WHERE job_id = ${jobId}`;
          });
        const honest = yield* make("honest", 0.2);
        yield* crashed(honest.jobId, false);
        yield* experiments.runDue;
        const recovered = yield* experiments.job({ projectId: TEST_PROJECT, jobId: honest.jobId });
        expect(recovered).toMatchObject({ status: "succeeded", tries: 2 });
        const reports = yield* sql<{
          n: number;
        }>`SELECT COUNT(*) AS n FROM editorial_engine_reports WHERE job_id = ${honest.jobId}`;
        expect(reports[0]!.n).toBe(1);
        // A report never changes once accepted.
        const update = yield* Effect.flip(
          sql`UPDATE editorial_engine_reports SET report_hash = 'x' WHERE job_id = ${honest.jobId}`,
        );
        expect(String(update.cause)).toContain("ConstraintError");
        const kept = yield* sql<{
          report_hash: string;
        }>`SELECT report_hash FROM editorial_engine_reports WHERE job_id = ${honest.jobId}`;
        expect(kept[0]!.report_hash).toMatch(/^sha256:/);

        const forged = yield* make("forged", 0.3);
        yield* crashed(forged.jobId, true);
        yield* experiments.runDue;
        const rejected = yield* experiments.job({ projectId: TEST_PROJECT, jobId: forged.jobId });
        expect(rejected).toMatchObject({
          status: "failed",
          reportId: null,
          error: { code: "artifact-mismatch" },
        });
      }),
    ),
);

it.live(
  "promotes only with a passing shadow; the next nightly plan runs the approved manifest, and a revert restores the previous one",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const promotion = yield* EnginePromotionService;
        const before = yield* nightlyConfigHash(harness);
        const better = yield* evaluated(harness, "better", { growth: 0.1, log_authors_7d: 0.9 });
        // Installing the pointer leaves the nightly plan exactly as it was.
        expect(yield* nightlyConfigHash(harness)).toBe(before);
        expect(before).toBe(better.active.manifest.config_hash);
        const request = yield* promotion.request({
          projectId: TEST_PROJECT,
          threadId: "thread-lab",
          candidate: better.candidate,
          reportId: better.job.reportId!,
          expectedActive: better.active.hash,
          reason: "better",
        });
        const early = yield* Effect.flip(
          promotion.approve({ requestId: request.requestId, actor: "miguel", reason: "ok" }),
        );
        expect(early.code).toBe("insufficient-evidence");
        const inconclusive = yield* shadowFor(harness, request.requestId, "none");
        expect(inconclusive.verdict).toBe("inconclusive");
        expect(
          (yield* Effect.flip(
            promotion.approve({ requestId: request.requestId, actor: "miguel", reason: "ok" }),
          )).code,
        ).toBe("insufficient-evidence");
        const gate = yield* shadowFor(harness, request.requestId);
        expect(gate.verdict, gate.reasons.join(" ")).toBe("pass");

        const activation = yield* promotion.approve({
          requestId: request.requestId,
          actor: "miguel",
          reason: "shadow passed",
        });
        expect(activation).toMatchObject({
          kind: "promote",
          manifest_hash: better.candidate,
          previous_hash: better.active.hash,
        });
        const candidateConfig = (yield* (yield* EngineChangeService).candidate(
          TEST_PROJECT,
          better.candidate,
        )).configHash;
        const promoted = yield* nightly(harness);
        expect(promoted.configHash).toBe(candidateConfig);
        expect(promoted.profileHash).toBe(better.active.manifest.profile_hash);

        const reverted = yield* promotion.revert({
          actor: "miguel",
          reason: "back",
          expectedActive: better.candidate,
        });
        expect(reverted).toMatchObject({ kind: "revert", manifest_hash: better.active.hash });
        expect((yield* nightly(harness)).configHash).toBe(before);
        expect((yield* promotion.history).map((row) => row.kind)).toEqual([
          "revert",
          "promote",
          "install",
        ]);
      }),
    ),
);

it.live(
  "refuses a worse candidate, a stale request and a code candidate that is not deployed",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const promotion = yield* EnginePromotionService;
        const worse = yield* evaluated(harness, "worse", { growth: 2, log_authors_7d: 0 });
        expect((worse.job.report as { human: { verdict: string } }).human.verdict).toBe("worse");
        const request = yield* promotion.request({
          projectId: TEST_PROJECT,
          threadId: null,
          candidate: worse.candidate,
          reportId: worse.job.reportId!,
          expectedActive: worse.active.hash,
          reason: "try",
        });
        const gate = yield* shadowFor(harness, request.requestId);
        expect(gate.verdict).not.toBe("pass");
        expect(
          (yield* Effect.flip(
            promotion.approve({ requestId: request.requestId, actor: "miguel", reason: "x" }),
          )).code,
        ).toBe("insufficient-evidence");

        // A profile changed through Settings: the active engine and every request made on it are stale.
        const profiles = yield* EditorialProfileService;
        const current = yield* profiles.get;
        yield* profiles.update({
          name: current.name,
          audience: "someone else",
          language: "en",
          include: [...current.include],
          exclude: [...current.exclude],
        });
        const stale = yield* Effect.flip(
          promotion.approve({ requestId: request.requestId, actor: "miguel", reason: "x" }),
        );
        expect(stale.code).toBe("stale-base");
        const listed = yield* promotion.listRequests(TEST_PROJECT);
        expect(listed.find((r) => r.requestId === request.requestId)?.status).toBe("stale");
      }),
    ),
);

it.live(
  "promotes code through a versioned artifact without touching the installed engine, and reverts to it (Sol, B4)",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const changes = yield* EngineChangeService;
        const experiments = yield* EngineExperimentService;
        const promotion = yield* EnginePromotionService;
        const active = yield* promotion.active;
        const code = yield* changes.codeFiles;
        const rank = code.files["packages/trend-engine/src/rank.ts"]!.split("\n");
        const patch = `--- a/packages/trend-engine/src/rank.ts\n+++ b/packages/trend-engine/src/rank.ts\n@@ -1,1 +1,2 @@\n ${rank[0]}\n+// Same computation, another file: outputs stay logically equal.\n`;
        const campaign = yield* changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 3,
          policy: syntheticPolicy(harness),
          actor: "miguel",
        });
        const created = yield* changes.createCandidate({
          projectId: TEST_PROJECT,
          threadId: null,
          base: active.hash,
          intent: "refactor",
          hypothesis: "equal outputs",
          idempotencyKey: "code",
          change: { kind: "code", baseSourceHash: code.baseSourceHash, patch },
        });
        const queued = yield* changes.evaluate({
          projectId: TEST_PROJECT,
          threadId: null,
          candidate: created.candidate.manifestHash,
          campaignId: campaign.campaignId,
          idempotencyKey: "code",
        });
        yield* experiments.runDue;
        const job = yield* experiments.job({ projectId: TEST_PROJECT, jobId: queued.jobId });
        expect(job.status, JSON.stringify(job.error)).toBe("succeeded");
        expect(job.report).toMatchObject({ equivalent: true, sandbox: "bwrap" });
        const request = yield* promotion.request({
          projectId: TEST_PROJECT,
          threadId: null,
          candidate: created.candidate.manifestHash,
          reportId: job.reportId!,
          expectedActive: active.hash,
          reason: "equal outputs",
        });
        const liveBefore = engineSourceHash(NodePath.join(REPO_ROOT, "packages/trend-engine/src"));
        expect(request.pendingChecks.join(" ")).not.toContain("deploy");
        const activation = yield* promotion.approve({
          requestId: request.requestId,
          actor: "miguel",
          reason: "equal outputs, reviewed",
        });
        expect(activation).toMatchObject({ kind: "promote", previous_hash: active.hash });
        // Sol's repro: approving no longer installs a manifest of its own and stales itself.
        expect((yield* promotion.history).map((row) => row.kind)).toEqual(["promote", "install"]);
        expect(engineSourceHash(NodePath.join(REPO_ROOT, "packages/trend-engine/src"))).toBe(
          liveBefore,
        );
        const sourceHash = created.candidate.engineSourceHash;
        expect(sourceHash).not.toBe(liveBefore);
        const enabled = yield* (yield* EditorialSourcesService).enabledSources;
        const defaultConfig = harness.fixture.config as unknown as Record<string, unknown>;
        const planned = yield* promotion.planEngine({ defaultConfig, enabled });
        expect(planned).toMatchObject({
          manifestHash: created.candidate.manifestHash,
          engineSourceHash: sourceHash,
          cli: artifactCli(harness.options.artifactsRoot, sourceHash),
          blocked: null,
        });
        // An artifact edited after it was built never runs: the nightly fails instead.
        const rankFile = NodePath.join(NodePath.dirname(planned.cli!), "rank.ts");
        NodeFS.chmodSync(rankFile, 0o644);
        NodeFS.appendFileSync(rankFile, "\n// edited\n");
        expect((yield* promotion.planEngine({ defaultConfig, enabled })).blocked).toContain(
          "hashes",
        );
        const reverted = yield* promotion.revert({
          actor: "miguel",
          reason: "back",
          expectedActive: created.candidate.manifestHash,
        });
        expect(reverted.manifest_hash).toBe(active.hash);
        expect(yield* promotion.planEngine({ defaultConfig, enabled })).toMatchObject({
          engineSourceHash: liveBefore,
          cli: null,
          blocked: null,
        });
      }),
    ),
);

it.live("two approvals at once move the active engine once", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const promotion = yield* EnginePromotionService;
      const a = yield* evaluated(harness, "a", { growth: 0.1, log_authors_7d: 0.9 });
      const b = yield* evaluated(harness, "b", { growth: 0.05, log_authors_7d: 1 });
      const ra = yield* promotion.request({
        projectId: TEST_PROJECT,
        threadId: null,
        candidate: a.candidate,
        reportId: a.job.reportId!,
        expectedActive: a.active.hash,
        reason: "a",
      });
      const rb = yield* promotion.request({
        projectId: TEST_PROJECT,
        threadId: null,
        candidate: b.candidate,
        reportId: b.job.reportId!,
        expectedActive: a.active.hash,
        reason: "b",
      });
      expect((yield* shadowFor(harness, ra.requestId)).verdict).toBe("pass");
      expect((yield* shadowFor(harness, rb.requestId)).verdict).toBe("pass");
      const outcomes = yield* Effect.forEach(
        [ra, rb],
        (r) =>
          Effect.result(
            promotion.approve({ requestId: r.requestId, actor: "miguel", reason: "both" }),
          ),
        { concurrency: "unbounded" },
      );
      expect(outcomes.filter(Result.isSuccess)).toHaveLength(1);
      const failure = outcomes.find(Result.isFailure)!;
      expect(Result.isFailure(failure) && failure.failure.code).toBe("stale-base");
      expect((yield* promotion.history).filter((row) => row.kind === "promote")).toHaveLength(1);
    }),
  ),
);

/** The nightly plan of the harness's product: what the next run's job is keyed with. */
const nightly = (harness: LabHarness) =>
  Effect.gen(function* () {
    const jobs = yield* EditorialJobsService.EditorialJobsService;
    return yield* jobs.runNow;
  }).pipe(
    Effect.provide(
      EditorialJobsService.layerWith({
        engine: harness.options.engine,
        jobsDir: NodePath.join(harness.dir, "nightly-jobs"),
        profilesDir: NodePath.join(harness.dir, "nightly-profiles"),
        cacheFile: NodePath.join(harness.dir, "embeddings.sqlite"),
        modelsDir: null,
        ...EditorialJobsService.DEFAULT_JOB_TIMING,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(EditorialImportService)({}),
            Layer.mock(EditorialPresentationService)({}),
            Layer.mock(EditorialRunDirectory)({ runsDir: NodePath.join(harness.dir, "runs") }),
          ),
        ),
      ),
    ),
  );

const nightlyConfigHash = (harness: LabHarness) =>
  nightly(harness).pipe(Effect.map((job) => job.configHash));
