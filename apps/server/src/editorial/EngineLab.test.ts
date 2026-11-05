// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off - the lab's worker files and the nightly job's files are on disk.
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
  LAB_CLOCK_START,
  labClock,
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
  // The server's clock in August: requests come before the shadow's cutoffs, which the test
  // then lets pass. The worker, a child process, keeps the real clock.
  activeClock = labClock(LAB_CLOCK_START);
  return activeClock
    .provide(
      Effect.gen(function* () {
        yield* useSyntheticProfile(harness);
        return yield* body(harness);
      }),
    )
    .pipe(Effect.provide(labLayer(harness)), Effect.ensuring(removeDir(dir)));
};

let activeClock = labClock(LAB_CLOCK_START);

/** Lets the shadow's days pass on the server's clock: half a day after its last cutoff. */
const afterCutoffs = (cutoffs: ReadonlyArray<string>) =>
  activeClock.set(new Date(Date.parse(cutoffs.at(-1)!) + 12 * 3_600_000).toISOString());

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
      // Cutoffs after the request, made on the 10th of August; they pass before the shadow runs.
      policy: syntheticPolicy(harness, harness.fixture.cutoffs.slice(3, 10)),
      actor: "miguel",
      requestId,
      referenceHash: (yield* (yield* EnginePromotionService).active).hash,
    });
    yield* afterCutoffs(harness.fixture.cutoffs.slice(3, 10));
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
          budget: 5,
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

        // Astra, B2: what the campaign fixed by content, edited under the same paths, voids a
        // result the worker already finished, when the server recovers it.
        const failedWith = (jobId: string) =>
          experiments
            .job({ projectId: TEST_PROJECT, jobId })
            .pipe(Effect.map((job) => ({ status: job.status, error: job.error })));
        const recorpus = yield* make("recorpus", 0.6);
        yield* crashed(recorpus.jobId, false);
        const corpus = harness.fixture.corpus_dir;
        const day = NodeFS.readdirSync(NodePath.join(corpus, "hn")).toSorted()[0]!;
        NodeFS.appendFileSync(NodePath.join(corpus, "hn", day), "\n");
        yield* experiments.runDue;
        const corpusEdited = yield* failedWith(recorpus.jobId);
        expect(corpusEdited.status).toBe("failed");
        expect(corpusEdited.error?.code).toBe("artifact-mismatch");
        expect(corpusEdited.error?.message).toContain("corpus");
        NodeFS.writeFileSync(
          NodePath.join(corpus, "hn", day),
          NodeFS.readFileSync(NodePath.join(corpus, "hn", day), "utf8").replace(/\n\n$/, "\n"),
        );

        const relabel = yield* make("relabel", 0.7);
        yield* crashed(relabel.jobId, false);
        NodeFS.appendFileSync(harness.fixture.labels_path, " ");
        yield* experiments.runDue;
        const labelsEdited = yield* failedWith(relabel.jobId);
        expect(labelsEdited.status).toBe("failed");
        expect(labelsEdited.error?.message).toContain("label files changed");
      }),
    ),
);

it.live("a report is computed only by the evaluator its campaign fixed (Astra, B2)", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const sql = yield* EditorialSql;
      const changes = yield* EngineChangeService;
      const experiments = yield* EngineExperimentService;
      const active = yield* (yield* EnginePromotionService).active;
      const campaign = yield* changes.createCampaign({
        projectId: TEST_PROJECT,
        kind: "development",
        budget: 1,
        policy: syntheticPolicy(harness, harness.fixture.cutoffs.slice(0, 1)),
        actor: "miguel",
      });
      // The campaign names its evaluator and inputs by content.
      const [row] = yield* sql<{
        policy_json: string;
      }>`SELECT policy_json FROM editorial_engine_campaigns WHERE campaign_id = ${campaign.campaignId}`;
      const policy = JSON.parse(row!.policy_json);
      expect(policy.inputs).toMatchObject({
        corpus_hash: expect.stringMatching(/^sha256:/),
        models_hash: null,
        labels_hash: expect.stringMatching(/^sha256:/),
        evaluator_hash: expect.stringMatching(/^sha256:/),
      });
      // Another evaluator than the one fixed: as if engine-lab's code changed meanwhile.
      const other = JSON.stringify({
        ...policy,
        inputs: { ...policy.inputs, evaluator_hash: "sha256:another" },
      });
      yield* sql`UPDATE editorial_engine_campaigns SET policy_json = ${other} WHERE campaign_id = ${campaign.campaignId}`;
      const created = yield* changes.createCandidate({
        projectId: TEST_PROJECT,
        threadId: null,
        base: active.hash,
        intent: "i",
        hypothesis: "h",
        idempotencyKey: "evaluator",
        change: { kind: "config", weights: { growth: 0.3 } },
      });
      const queued = yield* changes.evaluate({
        projectId: TEST_PROJECT,
        threadId: null,
        candidate: created.candidate.manifestHash,
        campaignId: campaign.campaignId,
        idempotencyKey: "evaluator",
      });
      yield* experiments.runDue;
      const job = yield* experiments.job({ projectId: TEST_PROJECT, jobId: queued.jobId });
      expect(job).toMatchObject({ status: "failed", reportId: null });
      expect(job.error?.message).toContain("not the campaign's sha256:another");
    }),
  ),
);

it.live("a job past its time limit fails and its executor's process group is killed", () =>
  withHarness(
    (harness) =>
      Effect.gen(function* () {
        const changes = yield* EngineChangeService;
        const experiments = yield* EngineExperimentService;
        const active = yield* (yield* EnginePromotionService).active;
        const campaign = yield* changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 1,
          policy: syntheticPolicy(harness, harness.fixture.cutoffs.slice(0, 3)),
          actor: "miguel",
        });
        const created = yield* changes.createCandidate({
          projectId: TEST_PROJECT,
          threadId: null,
          base: active.hash,
          intent: "i",
          hypothesis: "h",
          idempotencyKey: "slow",
          change: { kind: "config", weights: { growth: 0.3 } },
        });
        const queued = yield* changes.evaluate({
          projectId: TEST_PROJECT,
          threadId: null,
          candidate: created.candidate.manifestHash,
          campaignId: campaign.campaignId,
          idempotencyKey: "slow",
        });
        yield* experiments.runDue;
        const job = yield* experiments.job({ projectId: TEST_PROJECT, jobId: queued.jobId });
        expect(job.status).toBe("failed");
        expect(job.error?.code).toBe("timeout");
        // The worker it started is gone: its process group was killed with it.
        const token = `job-${queued.jobId.replace(/^job_/, "")}`;
        const pgid = Number(
          NodeFS.readFileSync(NodePath.join(harness.options.jobsRoot, token, "pgid"), "utf8"),
        );
        const alive = (() => {
          try {
            process.kill(pgid, 0);
            return true;
          } catch {
            return false;
          }
        })();
        expect(alive).toBe(false);
      }),
    { jobTimeoutMs: 1_500 },
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
        // The risk the model reads is true: no deploy or review step, the nightly runs it isolated.
        expect(created.risks.join(" ")).not.toContain("deploy and");
        expect(created.risks.join(" ")).toContain("same kind of sandbox");
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
        // Opus: three equivalent development days are too few to skip the labelled shadow.
        const tooFew = yield* Effect.flip(
          promotion.approve({ requestId: request.requestId, actor: "miguel", reason: "3 days" }),
        );
        expect(tooFew.code).toBe("insufficient-evidence");
        expect(tooFew.message).toContain("equivalence: 3 development days");
        yield* promotion.reject({ requestId: request.requestId, actor: "miguel", reason: "few" });
        const wider = yield* changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 1,
          policy: syntheticPolicy(harness, harness.fixture.cutoffs.slice(0, 5)),
          actor: "miguel",
        });
        const fiveDays = yield* changes.evaluate({
          projectId: TEST_PROJECT,
          threadId: null,
          candidate: created.candidate.manifestHash,
          campaignId: wider.campaignId,
          idempotencyKey: "code-5",
        });
        yield* experiments.runDue;
        const widerJob = yield* experiments.job({ projectId: TEST_PROJECT, jobId: fiveDays.jobId });
        expect(widerJob.report).toMatchObject({ equivalent: true });
        const asked = yield* promotion.request({
          projectId: TEST_PROJECT,
          threadId: null,
          candidate: created.candidate.manifestHash,
          reportId: widerJob.reportId!,
          expectedActive: active.hash,
          reason: "equal outputs over five days",
        });
        // Opus: the operator reads the patch itself and the evidence in plain words.
        const review = yield* promotion.review(asked.requestId);
        expect(review.patch).toContain("+// Same computation, another file");
        expect(review.patch).toContain("--- a/packages/trend-engine/src/rank.ts");
        expect(review.evidence).toContain("No change of outputs observed over 5 development days");
        expect(review.evidence).toContain("not a measured improvement");
        const activation = yield* promotion.approve({
          requestId: asked.requestId,
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

it.live("approves a code candidate whose exact code was installed meanwhile (Sol's B4 repro)", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const changes = yield* EngineChangeService;
      const experiments = yield* EngineExperimentService;
      const promotion = yield* EnginePromotionService;
      const active = yield* promotion.active;
      const first = NodeFS.readFileSync(
        NodePath.join(REPO_ROOT, "packages/trend-engine/src/rank.ts"),
        "utf8",
      ).split("\n");
      const patch = [
        "--- a/packages/trend-engine/src/rank.ts",
        "+++ b/packages/trend-engine/src/rank.ts",
        "@@ -1,2 +1,3 @@",
        ` ${first[0]}`,
        "+// sol harmless deployment test",
        ` ${first[1]}`,
        "",
      ].join("\n");
      const campaign = yield* changes.createCampaign({
        projectId: TEST_PROJECT,
        kind: "development",
        budget: 3,
        policy: syntheticPolicy(harness, harness.fixture.cutoffs.slice(0, 1)),
        actor: "miguel",
      });
      const created = yield* changes.createCandidate({
        projectId: TEST_PROJECT,
        threadId: "sol",
        base: active.hash,
        intent: "deployment",
        hypothesis: "equivalent comment",
        idempotencyKey: "sol-code",
        change: { kind: "code", baseSourceHash: active.manifest.code.engine_source_hash, patch },
      });
      const queued = yield* changes.evaluate({
        projectId: TEST_PROJECT,
        threadId: "sol",
        candidate: created.candidate.manifestHash,
        campaignId: campaign.campaignId,
        idempotencyKey: "sol-eval",
      });
      yield* experiments.runDue;
      const job = yield* experiments.job({ projectId: TEST_PROJECT, jobId: queued.jobId });
      const request = yield* promotion.request({
        projectId: TEST_PROJECT,
        threadId: "sol",
        candidate: created.candidate.manifestHash,
        reportId: job.reportId!,
        expectedActive: active.hash,
        reason: "deploy",
      });
      // One equivalent day is not enough; a 7-day shadow with unchanged outputs, observed after
      // the request and needing no labels, is (Opus).
      const oneDay = yield* Effect.flip(
        promotion.approve({ requestId: request.requestId, actor: "miguel", reason: "1 day" }),
      );
      expect(oneDay.message).toContain("equivalence: 1 development days");
      const shadowCutoffs = harness.fixture.cutoffs.slice(3, 10);
      const shadow = yield* changes.createCampaign({
        projectId: TEST_PROJECT,
        kind: "shadow",
        budget: 1,
        policy: syntheticPolicy(harness, shadowCutoffs),
        actor: "miguel",
        requestId: request.requestId,
        referenceHash: active.hash,
      });
      // Scheduled now, it waits for its days to pass.
      const waiting = yield* Effect.flip(changes.startShadow(shadow.campaignId));
      expect(waiting.code).toBe("insufficient-evidence");
      yield* afterCutoffs(shadowCutoffs);
      const { jobId: shadowJob } = yield* changes.startShadow(shadow.campaignId);
      yield* experiments.runDue;
      expect((yield* experiments.job({ projectId: null, jobId: shadowJob })).status).toBe(
        "succeeded",
      );
      expect((yield* promotion.review(request.requestId)).evidence).toContain("shadow days");
      // The same code installed in another engine directory, as Sol simulated it.
      const deployed = NodePath.join(harness.dir, "deployed");
      const pkg = NodePath.join(deployed, "packages/trend-engine");
      NodeFS.mkdirSync(pkg, { recursive: true });
      for (const name of ["src", "config"])
        NodeFS.cpSync(
          NodePath.join(REPO_ROOT, "packages/trend-engine", name),
          NodePath.join(pkg, name),
          { recursive: true },
        );
      NodeFS.copyFileSync(
        NodePath.join(REPO_ROOT, "packages/trend-engine/package.json"),
        NodePath.join(pkg, "package.json"),
      );
      NodeFS.writeFileSync(
        NodePath.join(pkg, "src/rank.ts"),
        `${first[0]}\n// sol harmless deployment test\n${first.slice(1).join("\n")}`,
      );
      (harness.options as { engineRoot: string | null }).engineRoot = deployed;
      expect((yield* promotion.productContext).engineSourceHash).toBe(
        created.candidate.engineSourceHash,
      );
      const activation = yield* promotion.approve({
        requestId: request.requestId,
        actor: "miguel",
        reason: "reviewed and deployed",
      });
      expect(activation).toMatchObject({
        kind: "promote",
        manifest_hash: created.candidate.manifestHash,
      });
      expect((yield* promotion.history).map((row) => row.kind)).toEqual(["promote", "install"]);
    }),
  ),
);

it.live(
  "a candidate that would link its output to the reference's is refused when it is made (Sol B1-R2, Opus)",
  () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const changes = yield* EngineChangeService;
        const experiments = yield* EngineExperimentService;
        const promotion = yield* EnginePromotionService;
        const active = yield* promotion.active;
        const rank = NodeFS.readFileSync(
          NodePath.join(REPO_ROOT, "packages/trend-engine/src/rank.ts"),
          "utf8",
        ).split("\n");
        const injected = [
          'import solFs from "node:fs";',
          'process.on("exit", () => {',
          ' const here=process.cwd(); const ref=here.replace("/candidate/", "/reference/");',
          ' solFs.renameSync(here+"/runs", here+"/actual-runs");',
          ' solFs.renameSync(here+"/members.json", here+"/actual-members.json");',
          ' solFs.symlinkSync(ref+"/runs",here+"/runs");',
          ' solFs.symlinkSync(ref+"/members.json",here+"/members.json");',
          "});",
        ];
        const patch = [
          "--- a/packages/trend-engine/src/rank.ts",
          "+++ b/packages/trend-engine/src/rank.ts",
          `@@ -1,2 +1,${2 + injected.length} @@`,
          ` ${rank[0]}`,
          ...injected.map((line) => `+${line}`),
          ` ${rank[1]}`,
          "",
        ].join("\n");
        yield* changes.createCampaign({
          projectId: TEST_PROJECT,
          kind: "development",
          budget: 3,
          policy: syntheticPolicy(harness, harness.fixture.cutoffs.slice(0, 1)),
          actor: "miguel",
        });
        // Opus: an added line that loads a module or reaches the process is refused outright;
        // the executor's defense against such code stays tested in engine-lab's worker tests.
        const refused = yield* Effect.flip(
          changes.createCandidate({
            projectId: TEST_PROJECT,
            threadId: "sol",
            base: active.hash,
            intent: "forge",
            hypothesis: "equal",
            idempotencyKey: "forge",
            change: {
              kind: "code",
              baseSourceHash: active.manifest.code.engine_source_hash,
              patch,
            },
          }),
        );
        expect(refused.code).toBe("invalid-change");
        expect(refused.message).toContain("an added line uses import");
        void experiments;
        expect((yield* promotion.history).filter((row) => row.kind === "promote")).toHaveLength(0);
      }),
    ),
);
