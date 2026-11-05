#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - the operator's command line over editorial.sqlite.

// The operator's side of the engine lab, which no MCP tool reaches: campaigns, approval,
// rejection, reversion and prospective shadows.
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
  judge:
    flag("judge-labels") === undefined
      ? null
      : {
          cards: NodePath.resolve(need("judge-cards")),
          labels: NodePath.resolve(need("judge-labels")),
        },
});

const program = Effect.gen(function* () {
  const changes = yield* EngineChangeService.EngineChangeService;
  const experiments = yield* EngineExperimentService.EngineExperimentService;
  const promotion = yield* EnginePromotionService.EnginePromotionService;
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
    case "campaign-create":
      return yield* print(
        yield* changes.createCampaign({
          projectId: need("project"),
          kind: "development",
          budget: Number(flag("budget") ?? "3"),
          policy: policyFromFlags(),
          actor: need("actor"),
        }),
      );
    case "campaign-close":
      return yield* print(yield* changes.closeCampaign(need("campaign"), need("actor")));
    case "requests":
      return yield* print(yield* promotion.listRequests(flag("project") ?? null));
    case "approve":
      return yield* print(
        yield* promotion.approve({
          requestId: need("request"),
          actor: need("actor"),
          reason: need("reason"),
        }),
      );
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
      const campaign = yield* changes.createCampaign({
        projectId: need("project"),
        kind: "shadow",
        budget: 1,
        policy: policyFromFlags(),
        actor: need("actor"),
        requestId: request.requestId,
        referenceHash: request.expectedActiveHash,
      });
      const job = yield* changes.startShadow(campaign.campaignId);
      return yield* print({ campaign, job });
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
    default:
      return yield* Console.log(
        "engine-lab <active|history|campaign-create|campaign-close|requests|approve|reject|revert|shadow-start|shadow-cards|shadow-score|run-due|job> --db <editorial.sqlite> …",
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
