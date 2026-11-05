#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a development bridge over an editorial.sqlite of its own.

// The engine lab toolkit over stdio, for a model CLI in a demonstration: the same tools,
// handlers, services and executors as the server's /mcp, with one live thread of one project.
// Logs go to stderr. Never point it at a live install's database.
//   node apps/server/scripts/engine-lab-mcp-stdio.ts --db <editorial.sqlite> --project <id>

import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- only the stdio transport; the toolkit registers through McpHttpServer.
import { McpProtocol, McpServer } from "effect/ai";

import * as EditorialProfile from "../src/editorial/EditorialProfileService.ts";
import * as EditorialSources from "../src/editorial/EditorialSourcesService.ts";
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
import * as McpHttpServer from "../src/mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../src/mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../src/orchestration-v2/ThreadManagementService.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  if (at < 0 || args[at + 1] === undefined) throw new Error(`--${name} is required`);
  return args[at + 1]!;
};
const db = NodePath.resolve(flag("db"));
const project = flag("project");
const THREAD = "thread:engine-lab-demo";

const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) =>
    Effect.succeed(
      (threadId === THREAD
        ? {
            id: threadId,
            projectId: project,
            providerInstanceId: ProviderInstanceId.make("claude"),
            runtimeMode: "full-access",
            interactionMode: "default",
            activeRunId: "run-demo",
            archivedAt: null,
            deletedAt: null,
            pendingBackgroundTasks: [],
          }
        : null) as never,
    ),
});

const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("environment:engine-lab-demo"),
  requestNamespace: "provider:engine-lab-demo",
  thread: {
    threadId: ThreadId.make(THREAD),
    providerSessionId: "demo",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
};

const services = Effect.gen(function* () {
  const engine = yield* resolveEngineLocation.pipe(
    Effect.map(Result.succeed),
    Effect.catchTags({ EngineNotFound: (missing) => Effect.succeed(Result.fail(missing)) }),
  );
  const remote = yield* Config.String("EARLYSCRIPT_ENGINE_LAB_REMOTE").pipe(Config.option);
  return EngineExperimentService.layerRunner.pipe(
    Layer.provideMerge(Layer.merge(EngineChangeService.layer, EngineExperimentService.layer)),
    Layer.provideMerge(EnginePromotionService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        layerOptionsWith({
          engine,
          engineRoot: Result.isSuccess(engine) ? engineRootOf(engine.success) : null,
          jobsRoot: NodePath.join(NodePath.dirname(db), "editorial-engine-lab", "jobs"),
          remote: Option.match(remote, { onNone: () => null, onSome: parseRemote }),
          ...DEFAULT_LAB_TIMING,
          pollMs: 5_000,
        }),
        EditorialSources.layerWithCorpusDir(NodePath.dirname(db)),
        EditorialProfile.layer,
      ),
    ),
    Layer.provideMerge(EditorialDatabase.layerFromPath(db)),
  );
}).pipe(Layer.unwrap);

const layer = McpHttpServer.layerEngineLabToolkit.pipe(
  Layer.provideMerge(
    McpServer.layerStdio({
      name: "earlyscript-engine-lab",
      version: "0.0.0",
      protocols: [McpProtocol.v2025_06_18],
    }),
  ),
  Layer.provideMerge(Layer.succeed(McpInvocationContext.McpInvocationContext, scope)),
  Layer.provideMerge(threads),
  Layer.provideMerge(services),
  Layer.provideMerge(Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
  Layer.provideMerge(NodeServices.layer),
);

Layer.launch(layer).pipe(NodeRuntime.runMain);
