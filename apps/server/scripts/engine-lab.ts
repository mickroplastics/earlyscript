#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the operator's command line over editorial.sqlite.

// The operator's side of the engine lab, which no MCP tool reaches: campaigns, approval,
// rejection, reversion and prospective shadows. `show` and `approve` print the evidence, the
// configuration change and the patch in full; `approve` changes nothing without `--yes`.
//   node apps/server/scripts/engine-lab.ts <action> --db <editorial.sqlite> [flags]

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as EditorialProfileService from "../src/editorial/EditorialProfileService.ts";
import * as EditorialSourcesService from "../src/editorial/EditorialSourcesService.ts";
import * as EngineChangeService from "../src/editorial/EngineChangeService.ts";
import * as EngineExperimentService from "../src/editorial/EngineExperimentService.ts";
import * as EnginePromotionService from "../src/editorial/EnginePromotionService.ts";
import {
  DEFAULT_LAB_TIMING,
  engineRootOf,
  layerOptionsWith,
  parseRemote,
} from "../src/editorial/engineLabSupport.ts";
import { verifyLabLedger } from "../src/editorial/engineLabVerify.ts";
import { resolveEngineLocation } from "../src/editorial/engineProcess.ts";
import * as EditorialDatabase from "../src/editorial/persistence/EditorialDatabase.ts";

const [action = "help", ...rest] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = rest.indexOf(`--${name}`);
  return at < 0 ? undefined : rest[at + 1];
};
const has = (name: string) => rest.includes(`--${name}`);
const need = (name: string): string => {
  const value = flag(name);
  if (value === undefined) throw new Error(`--${name} is required for ${action}`);
  return value;
};
const list = (name: string) =>
  need(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const policyFromFlags = () => ({
  cutoffs: list("cutoffs"),
  executor: (flag("executor") ?? "local") as "local" | "remote",
  corpus_dir: NodePath.resolve(need("corpus")),
  profile_path: flag("executor") === "remote" ? need("profile") : NodePath.resolve(need("profile")),
  cache_file: flag("cache") ?? null,
  cache_only: has("cache-only"),
  models_dir: flag("models") ?? null,
  embedder: (flag("embedder") ?? "local") as "local" | "synthetic",
  workers: Number(flag("workers") ?? "1"),
  labels:
    flag("labels") === undefined
      ? null
      : { cards: NodePath.resolve(need("labels-cards")), labels: NodePath.resolve(need("labels")) },
  input_roots: list("inputs"),
  label_roots: flag("label-roots") === undefined ? [] : list("label-roots"),
  judge:
    flag("judge-labels") === undefined
      ? null
      : {
          cards: NodePath.resolve(need("judge-cards")),
          labels: NodePath.resolve(need("judge-labels")),
        },
  ...(flag("arm-timeout-min") === undefined && flag("memory-mb") === undefined
    ? {}
    : {
        limits: {
          arm_timeout_ms: Number(flag("arm-timeout-min") ?? "30") * 60_000,
          memory_mb: Number(flag("memory-mb") ?? "4096"),
        },
      }),
});

/** The review an operator reads before approving: words first, then the change itself. */
const printReview = (review: EnginePromotionService.RequestReview) =>
  Console.log(
    [
      `Request ${review.request.requestId}: ${review.kind} candidate ${review.request.candidateHash}`,
      `Status: ${review.request.status}. Still needed: ${review.request.pendingChecks.join("; ") || "nothing"}`,
      `Evidence: ${review.evidence}`,
      "",
      "Configuration change:",
      ...(review.configDiff.length === 0
        ? ["  (none)"]
        : review.configDiff.map((entry) => `  ${JSON.stringify(entry)}`)),
      "",
      review.patch === null
        ? "Code: unchanged (the installed engine's)."
        : "Code patch (from the stored files, against the installed sources):",
      ...(review.patch === null ? [] : [review.patch]),
      review.patch === null
        ? ""
        : "If approved, the nightly run executes this code in bwrap: no network, only the corpus, profile, models, cache and runs directory.",
    ].join("\n"),
  );

const program = Effect.gen(function* () {
  const changes = yield* EngineChangeService.EngineChangeService;
  const experiments = yield* EngineExperimentService.EngineExperimentService;
  const promotion = yield* EnginePromotionService.EnginePromotionService;
  /** A remote executor's identity of the corpus and models, asked before a campaign exists. */
  const identityOf = (policy: ReturnType<typeof policyFromFlags>) =>
    policy.executor === "remote"
      ? experiments.identify({
          executor: "remote",
          input_roots: policy.input_roots,
          corpus_dir: policy.corpus_dir,
          models_dir: policy.models_dir,
        })
      : Effect.succeed(null);
  switch (action) {
    case "active": {
      const active = yield* promotion.active;
      return yield* print({
        manifestHash: active.hash,
        activationId: active.activationId,
        manifest: active.manifest,
      });
    }
    case "history":
      return yield* print(yield* promotion.history);
    case "campaign-create": {
      const policy = policyFromFlags();
      const executorIdentity = yield* identityOf(policy);
      return yield* print(
        yield* changes.createCampaign({
          projectId: need("project"),
          kind: "development",
          budget: Number(flag("budget") ?? "3"),
          policy,
          ...(executorIdentity === null ? {} : { executorIdentity }),
          actor: need("actor"),
        }),
      );
    }
    case "campaign-close":
      return yield* print(yield* changes.closeCampaign(need("campaign"), need("actor")));
    case "requests":
      return yield* print(yield* promotion.listRequests(flag("project") ?? null));
    case "show":
      return yield* printReview(yield* promotion.review(need("request")));
    case "approve": {
      // Miguel sees what he approves: the review first, then nothing moves without --yes.
      yield* printReview(yield* promotion.review(need("request")));
      if (!has("yes")) {
        return yield* Console.log(
          "\nNothing was approved. Read the review above, then run approve again with --yes.",
        );
      }
      return yield* print(
        yield* promotion.approve({
          requestId: need("request"),
          actor: need("actor"),
          reason: need("reason"),
        }),
      );
    }
    case "reject":
      return yield* print(
        yield* promotion.reject({
          requestId: need("request"),
          actor: need("actor"),
          reason: need("reason"),
        }),
      );
    case "revert":
      return yield* print(
        yield* promotion.revert({
          expectedActive: need("expected"),
          actor: need("actor"),
          reason: need("reason"),
        }),
      );
    case "shadow-start": {
      const requests = yield* promotion.listRequests(null);
      const request = requests.find((entry) => entry.requestId === need("request"));
      if (request === undefined || request.status !== "requested") {
        throw new Error(`No open request ${need("request")}.`);
      }
      const policy = policyFromFlags();
      const executorIdentity = yield* identityOf(policy);
      const campaign = yield* changes.createCampaign({
        projectId: need("project"),
        kind: "shadow",
        budget: 1,
        policy,
        ...(executorIdentity === null ? {} : { executorIdentity }),
        actor: need("actor"),
        requestId: request.requestId,
        referenceHash: request.expectedActiveHash,
      });
      // Scheduled now; it runs once its last cutoff has passed (shadow-run then).
      const job = yield* changes.startShadow(campaign.campaignId).pipe(Effect.result);
      return yield* print({
        campaign,
        job: Result.isSuccess(job) ? job.success : { waiting: job.failure.message },
      });
    }
    case "shadow-run": {
      return yield* print(yield* changes.startShadow(need("campaign")));
    }
    case "shadow-cards": {
      const cards = yield* experiments.shadowCards(need("job"));
      NodeFS.writeFileSync(need("out"), cards.map((card) => `${JSON.stringify(card)}\n`).join(""));
      return yield* print({ cards: cards.length, out: need("out") });
    }
    case "shadow-score":
      return yield* print(
        yield* experiments.scoreShadow({
          jobId: need("job"),
          labelsPath: NodePath.resolve(need("labels")),
          actor: need("actor"),
        }),
      );
    case "run-due": {
      const passes = Number(flag("passes") ?? "1");
      for (let k = 0; k < passes; k++) yield* experiments.runDue;
      return yield* print({ passes });
    }
    case "job":
      return yield* print(yield* experiments.job({ projectId: null, jobId: need("job") }));
    case "verify":
      return yield* print(yield* verifyLabLedger);
    default:
      return yield* Console.log(
        "engine-lab <active|history|campaign-create|campaign-close|requests|show|approve|reject|revert|shadow-start|shadow-run|shadow-cards|shadow-score|run-due|job|verify> --db <editorial.sqlite> …",
      );
  }
});

const layer = Effect.gen(function* () {
  const db = NodePath.resolve(need("db"));
  if (!NodeFS.existsSync(db)) throw new Error(`No editorial database at ${db}.`);
  const engine = yield* resolveEngineLocation.pipe(
    Effect.map(Result.succeed),
    Effect.catchTags({ EngineNotFound: (missing) => Effect.succeed(Result.fail(missing)) }),
  );
  const remote = yield* Config.String("EARLYSCRIPT_ENGINE_LAB_REMOTE").pipe(Config.option);
  const options = layerOptionsWith({
    engine,
    engineRoot: Result.isSuccess(engine) ? engineRootOf(engine.success) : null,
    jobsRoot: NodePath.join(NodePath.dirname(db), "editorial-engine-lab", "jobs"),
    artifactsRoot: NodePath.join(NodePath.dirname(db), "editorial-engine-lab", "artifacts"),
    remote: Option.match(remote, { onNone: () => null, onSome: parseRemote }),
    ...DEFAULT_LAB_TIMING,
  });
  const database = EditorialDatabase.layerFromPath(db);
  return Layer.merge(EngineChangeService.layer, EngineExperimentService.layer).pipe(
    Layer.provideMerge(EnginePromotionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        options,
        EditorialSourcesService.layerWithCorpusDir(NodePath.dirname(db)),
        EditorialProfileService.layer,
      ),
    ),
    Layer.provideMerge(database),
  );
}).pipe(Layer.unwrap);

if (import.meta.main) {
  program.pipe(
    Effect.provide(layer.pipe(Layer.provideMerge(NodeServices.layer))),
    NodeRuntime.runMain,
  );
}
