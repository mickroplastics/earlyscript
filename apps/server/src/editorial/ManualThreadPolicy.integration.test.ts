// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  ThreadId,
  type ProjectCloneSnapshot,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as EditorialThreadService from "./EditorialThreadService.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";
import {
  makeTempDir,
  removeDir,
  TEST_ENVIRONMENT_ID,
} from "./persistence/EditorialDatabase.testkit.ts";
import * as EditorialPersistence from "./persistenceLayer.ts";
import * as EditorialRuntime from "./runtimeLayer.ts";
import { layerWorkspaceFiles } from "./videoThread.testkit.ts";

// Every way the map (07-mapa-de-integracion.md §8) lists for work to reach a
// thread, run against the real orchestrator, launch service, thread
// management, scheduled tasks and provider turn start. The provider adapter
// only counts session opens: a manual thread must never reach one.

const projectId = ProjectId.make("project:manual-policy");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" } as const;
const project = {
  id: projectId,
  title: "Studio",
  workspaceRoot: "/studio",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  deletedAt: null,
} as const;

type SettingsOverrides = Parameters<typeof ServerSettings.layerTest>[0];

/** Project states the launcher checks, all off by default. */
interface ProjectDoubles {
  /** The project's repository is still being cloned. */
  readonly cloning?: boolean;
  /** The project is Scratch: each thread gets this folder of its own. */
  readonly scratchFolder?: string;
}

/** Every provider the settings page lists, switched off. */
const disabledProviders = Object.fromEntries(
  (["codex", "claudeAgent"] as const).map((driver) => [
    ProviderInstanceId.make(driver),
    { driver: ProviderDriverKind.make(driver), enabled: false, config: {} },
  ]),
);

const makeLayer = (
  sessionOpens: Ref.Ref<number>,
  dbPath: string,
  settings: SettingsOverrides = {},
  doubles: ProjectDoubles = {},
) => {
  const adapter = {
    instanceId: modelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      Ref.update(sessionOpens, (count) => count + 1).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: ProviderDriverKind.make("codex"),
              providerSessionId: input.providerSessionId,
              cause: "no provider process in this test",
            }),
          ),
        ),
      ),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistryRequiringPolicy(
    { name: "manual-thread-policy" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest(settings);
  const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(layerReceipts),
  );
  const layerExternal = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
      get: (id) =>
        Effect.succeed(
          doubles.cloning === true && id === projectId
            ? ({ phase: "running" } as unknown as ProjectCloneSnapshot)
            : null,
        ),
    }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    layerServerSettings,
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: (id) =>
        Effect.succeed(doubles.scratchFolder !== undefined && id === projectId),
      folderForThread: (input) =>
        Effect.succeed(
          doubles.scratchFolder !== undefined && input.projectId === projectId
            ? Option.some(doubles.scratchFolder)
            : Option.none(),
        ),
    }),
  );
  const layerLaunch = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(layerExternal, layerThreadManagement, layerReceipts, IdAllocator.layer),
    ),
  );
  // The manual launcher reads receipts through the same repository the server provides.
  const layerT3 = Layer.mergeAll(
    layerLaunch,
    layerThreadManagement,
    layerExternal,
    OrchestrationCommandReceipts.layer.pipe(Layer.provide(layerDatabase)),
  );
  const layerScheduledTasks = ScheduledTasks.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerT3,
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
      ),
    ),
  );
  const layerEditorialStorage = EditorialPersistence.layerFromDatabase(
    EditorialDatabase.layerFromPath(dbPath),
  ).pipe(Layer.provide(NodeServices.layer));
  const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "manual-policy-" }).pipe(
    Layer.provideMerge(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );
  // The composition server.ts uses: the orchestration layers get ManualThreadPolicy
  // only from the editorial storage, so a wrong mount fails to build.
  return EditorialRuntime.aroundOrchestration(
    Layer.mergeAll(layerT3, layerScheduledTasks, layerOrchestrator),
    layerEditorialStorage,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(TEST_ENVIRONMENT_ID),
        }),
        layerWorkspaceFiles,
      ),
    ),
    Layer.provideMerge(layerDatabase),
    Layer.provideMerge(layerFiles),
  );
};

const withHarness = <A, E, R>(
  body: (sessionOpens: Ref.Ref<number>) => Effect.Effect<A, E, R>,
  settings: SettingsOverrides = {},
  doubles: ProjectDoubles = {},
) =>
  Effect.gen(function* () {
    const sessionOpens = yield* Ref.make(0);
    const dir = makeTempDir();
    return yield* body(sessionOpens).pipe(
      Effect.provide(
        makeLayer(
          sessionOpens,
          NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME),
          settings,
          doubles,
        ),
      ),
      Effect.ensuring(removeDir(dir)),
    );
  });

const createVideo = (operationId: string, mode: "manual" | "assisted") =>
  EditorialThreadService.EditorialThreadService.use((threads) =>
    threads.createVideo({
      operationId,
      projectId,
      mode,
      title: "Quantum error correction",
      modelSelection,
    }),
  ).pipe(Effect.map(({ thread }) => ThreadId.make(thread.threadId)));

const message = (threadId: ThreadId, id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`command:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: "Write the hook.",
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

/** Rejected before commit, with the editorial cause. */
const assertBlocked = (error: unknown) => {
  const rejected = error as Orchestrator.OrchestratorCommandRejectedError;
  assert.strictEqual(rejected._tag, "OrchestratorCommandRejectedError");
  assert.strictEqual(
    (rejected.cause as { readonly _tag?: string } | undefined)?._tag,
    "ManualThreadAgentBlockedError",
  );
};

const assertNoAgentWork = (threadId: ThreadId, sessionOpens: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projection = yield* threads.getThreadProjection(threadId);
    assert.deepStrictEqual(projection.runs, []);
    assert.deepStrictEqual(projection.messages, []);
    assert.strictEqual(yield* Ref.get(sessionOpens), 0);
  });

describe("ManualThreadPolicy at every entry", () => {
  it.effect("creates a manual video thread with no message, run or session", () =>
    withHarness((sessionOpens) =>
      Effect.gen(function* () {
        const threadId = yield* createVideo("op:create", "manual");
        const retried = yield* createVideo("op:create", "manual");
        assert.strictEqual(retried, threadId);
        const threads = yield* ThreadManagement.ThreadManagementService;
        const listed = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
        assert.deepStrictEqual(
          listed.map((thread) => [thread.id, thread.title]),
          [[threadId, "Video: Quantum error correction"]],
        );
        yield* assertNoAgentWork(threadId, sessionOpens);
      }),
    ),
  );

  it.effect("creates a manual video thread with every provider disabled", () =>
    withHarness(
      (sessionOpens) =>
        Effect.gen(function* () {
          const threadId = yield* createVideo("op:disabled", "manual");
          const retried = yield* createVideo("op:disabled", "manual");
          assert.strictEqual(retried, threadId);
          const threads = yield* ThreadManagement.ThreadManagementService;
          const listed = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
          assert.deepStrictEqual(
            listed.map((thread) => [thread.id, thread.title]),
            [[threadId, "Video: Quantum error correction"]],
          );
          const video = yield* EditorialThreadService.EditorialThreadService.use((service) =>
            service.getVideoThread(threadId),
          );
          assert.strictEqual(Option.getOrThrow(video).launchState, "launched");
          // Creating it enabled nothing: a message is still refused.
          const refused = yield* Effect.flip(
            ThreadMessageIntake.dispatchCommand(message(threadId, "disabled")),
          );
          assert.strictEqual(refused._tag, "ThreadManagementProviderInstanceDisabledError");
          yield* assertNoAgentWork(threadId, sessionOpens);
        }),
      { providerInstances: disabledProviders },
    ),
  );

  it.effect("creates a manual video thread when the project disables its provider", () =>
    withHarness(
      (sessionOpens) =>
        Effect.gen(function* () {
          const threadId = yield* createVideo("op:project-disabled", "manual");
          yield* assertNoAgentWork(threadId, sessionOpens);
        }),
      {
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [modelSelection.instanceId]: { enabled: false } } },
        },
      },
    ),
  );

  // The manual launcher keeps every launch check but the provider's (review round 2, R3).
  const failManualLaunch = (input: {
    readonly operationId: string;
    readonly projectId?: ProjectId;
  }) =>
    EditorialThreadService.EditorialThreadService.use((threads) =>
      threads.createVideo({
        operationId: input.operationId,
        projectId: input.projectId ?? projectId,
        mode: "manual",
        title: "Quantum error correction",
        modelSelection,
      }),
    ).pipe(
      Effect.flip,
      Effect.flatMap((error) =>
        Effect.gen(function* () {
          assert.strictEqual(error._tag, "EditorialVideoLaunchError");
          const launch = error._tag === "EditorialVideoLaunchError" ? error : undefined;
          assert.strictEqual(
            (launch?.cause as { readonly operation?: string } | undefined)?.operation,
            "resolve-project",
          );
          const video = yield* EditorialThreadService.EditorialThreadService.use((service) =>
            service.getVideoThread(launch?.threadId ?? ""),
          );
          assert.strictEqual(Option.getOrThrow(video).launchState, "failed");
          return error.message;
        }),
      ),
    );

  it.effect("a manual thread with every provider disabled refuses a missing project", () =>
    withHarness(
      (sessionOpens) =>
        Effect.gen(function* () {
          const missing = ProjectId.make("project:missing");
          const message = yield* failManualLaunch({
            operationId: "op:missing",
            projectId: missing,
          });
          assert.strictEqual(message, "El proyecto del hilo ya no existe en T3.");
          const threads = yield* ThreadManagement.ThreadManagementService;
          const listed = yield* threads.listProjectThreads({
            projectId: missing,
            includeSubagents: false,
          });
          assert.deepStrictEqual(listed, []);
          assert.strictEqual(yield* Ref.get(sessionOpens), 0);
        }),
      { providerInstances: disabledProviders },
    ),
  );

  it.effect("a manual thread with every provider disabled waits for its project's clone", () =>
    withHarness(
      () =>
        Effect.gen(function* () {
          const message = yield* failManualLaunch({ operationId: "op:cloning" });
          assert.include(message, "se está clonando");
          const threads = yield* ThreadManagement.ThreadManagementService;
          const listed = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
          assert.deepStrictEqual(listed, []);
        }),
      { providerInstances: disabledProviders },
      { cloning: true },
    ),
  );

  it.effect("a manual thread with every provider disabled gets its own Scratch folder", () =>
    withHarness(
      (sessionOpens) =>
        Effect.gen(function* () {
          const folder = "/scratch/2026-11-01-quantum-error-correction";
          // Scratch has no Git: the launcher turns a worktree request into the thread's folder.
          const { thread } = yield* EditorialThreadService.EditorialThreadService.use((service) =>
            service.createVideo({
              operationId: "op:scratch",
              projectId,
              mode: "manual",
              title: "Quantum error correction",
              modelSelection,
              workspaceStrategy: { type: "worktree", baseRef: "main" },
            }),
          );
          const threadId = ThreadId.make(thread.threadId);
          const threads = yield* ThreadManagement.ThreadManagementService;
          const shell = yield* threads.getThreadShell(threadId);
          assert.strictEqual(shell?.worktreePath, folder);
          assert.strictEqual(shell?.branch, null);
          yield* assertNoAgentWork(threadId, sessionOpens);
        }),
      { providerInstances: disabledProviders },
      { scratchFolder: "/scratch/2026-11-01-quantum-error-correction" },
    ),
  );

  it.effect("an assisted video thread with a disabled provider still fails to launch", () =>
    withHarness(
      () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(createVideo("op:disabled-assisted", "assisted"));
          assert.strictEqual(error._tag, "EditorialVideoLaunchError");
          assert.strictEqual(
            error._tag === "EditorialVideoLaunchError"
              ? (error.cause as { readonly _tag?: string })._tag
              : undefined,
            "ThreadManagementProviderInstanceDisabledError",
          );
          // The toast shows this text as is.
          assert.include(error.message, "Ajustes › Proveedores");
          const threads = yield* ThreadManagement.ThreadManagementService;
          const listed = yield* threads.listProjectThreads({ projectId, includeSubagents: false });
          assert.deepStrictEqual(listed, []);
        }),
      { providerInstances: disabledProviders },
    ),
  );

  it.effect("WS dispatchCommand: refuses a message", () =>
    withHarness((sessionOpens) =>
      Effect.gen(function* () {
        const threadId = yield* createVideo("op:ws", "manual");
        const error = yield* Effect.flip(
          ThreadMessageIntake.dispatchCommand(message(threadId, "ws")),
        );
        assertBlocked(error);
        // The rejection has a receipt: a retry of the same command is refused again.
        const replay = yield* Effect.flip(
          ThreadMessageIntake.dispatchCommand(message(threadId, "ws")),
        );
        assert.strictEqual(replay._tag, "OrchestratorCommandPreviouslyRejectedError");
        yield* assertNoAgentWork(threadId, sessionOpens);
      }),
    ),
  );

  it.effect("ThreadManagementService.sendToThread: refuses a message", () =>
    withHarness((sessionOpens) =>
      Effect.gen(function* () {
        const threadId = yield* createVideo("op:send", "manual");
        const threads = yield* ThreadManagement.ThreadManagementService;
        const error = yield* Effect.flip(
          threads.sendToThread({
            projectId,
            commandId: CommandId.make("command:send"),
            threadId,
            messageId: MessageId.make("message:send"),
            text: "Write the hook.",
            attachments: [],
            mode: "auto",
            createdBy: "agent",
            creationSource: "mcp",
          }),
        );
        assertBlocked(error);
        yield* assertNoAgentWork(threadId, sessionOpens);
      }),
    ),
  );

  it.effect("ThreadLaunchService.launch on the existing thread: refuses its message", () =>
    withHarness((sessionOpens) =>
      Effect.gen(function* () {
        const threadId = yield* createVideo("op:relaunch", "manual");
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const error = yield* Effect.flip(
          launches.launch({
            commandId: CommandId.make("command:relaunch"),
            threadId,
            reuseExistingThread: true,
            projectId,
            title: "Video: Quantum error correction",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { text: "Write the hook.", attachments: [] },
            createdBy: "agent",
            creationSource: "mcp",
          }),
        );
        assert.strictEqual(error._tag, "ThreadLaunchError");
        assertBlocked(error._tag === "ThreadLaunchError" ? error.cause : undefined);
        yield* assertNoAgentWork(threadId, sessionOpens);
      }),
    ),
  );

  it.effect("scheduled task bound to the thread: the run fails and sends nothing", () =>
    withHarness((sessionOpens) =>
      Effect.gen(function* () {
        const threadId = yield* createVideo("op:scheduled", "manual");
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const { task } = yield* tasks.upsert({
          id: ScheduledTaskId.make("scheduled-task:manual"),
          title: "Morning draft",
          prompt: "Draft today's script.",
          enabled: false,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId,
          threadId,
          workspaceStrategy: { type: "root" },
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
        });
        const result = yield* tasks.runNow({ id: task.id });
        assert.strictEqual(result.task.lastRunStatus, "failed");
        yield* assertNoAgentWork(threadId, sessionOpens);
      }),
    ),
  );

  it.effect("queue, queue resume and replayed turn starts: fail at the provider turn start", () =>
    withHarness((sessionOpens) =>
      Effect.gen(function* () {
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threads = EditorialThreadService.EditorialThreadService;
        // Work admitted while the thread was not manual: a started run whose
        // turn start is still in the outbox (as after a restart) and a queued run.
        const threadId = ThreadId.make("thread:queued-before-manual");
        yield* launches.launch({
          commandId: CommandId.make("command:launch-queued"),
          threadId,
          projectId,
          title: "Video: Queued",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch(message(threadId, "first"));
        yield* orchestrator.dispatch({
          ...message(threadId, "second"),
          dispatchMode: { type: "queue_after_active" },
        });
        yield* threads.use((service) =>
          service.registerVideoThread({
            operationId: "op:queued",
            environmentId: TEST_ENVIRONMENT_ID,
            threadId,
            mode: "manual",
          }),
        );
        // Drained right after the registration commits: nothing may slip through.
        yield* worker.drain();
        const afterReplay = yield* orchestrator.getThreadProjection(threadId);
        for (const run of afterReplay.runs.filter((candidate) => candidate.status === "queued")) {
          yield* orchestrator
            .dispatch({
              type: "queued-run.start",
              commandId: CommandId.make(`command:start-${run.id}`),
              threadId,
              runId: run.id,
            })
            .pipe(Effect.ignore);
        }
        yield* orchestrator
          .dispatch({ type: "queue.resume", commandId: CommandId.make("command:resume"), threadId })
          .pipe(Effect.ignore);
        yield* worker.drain();

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.strictEqual(yield* Ref.get(sessionOpens), 0);
        assert.isTrue(projection.runs.length >= 1);
        assert.isFalse(
          projection.runs.some((run) => run.status === "starting" || run.status === "running"),
        );
        assert.isTrue(
          projection.turnItems.some(
            (item) =>
              item.type === "error" && item.title === "No agent runs in a manual video thread",
          ),
        );
      }),
    ),
  );

  it.effect("thread.metadata.update: refuses a title regeneration in a manual thread only", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const regenerate = (threadId: ThreadId, id: string) =>
          orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`command:${id}`),
            threadId,
            regenerateTitle: true,
          });
        const manual = yield* createVideo("op:title-manual", "manual");
        assertBlocked(yield* Effect.flip(regenerate(manual, "title-manual")));
        // Renaming by hand stays possible.
        yield* orchestrator.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:rename-manual"),
          threadId: manual,
          title: "Video: QEC",
        });
        const assisted = yield* createVideo("op:title-assisted", "assisted");
        yield* regenerate(assisted, "title-assisted");
      }),
    ),
  );

  it.effect("effects left in the outbox by a restart: agent effects fail at once", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const manual = yield* createVideo("op:outbox-manual", "manual");
        const assisted = yield* createVideo("op:outbox-assisted", "assisted");
        const requests = [
          {
            type: "runtime-request.respond",
            providerSessionId: ProviderSessionId.make("provider-session:outbox"),
            requestId: RuntimeRequestId.make("runtime-request:outbox"),
            decision: "accept",
          },
          { type: "thread-title.generate", kind: { type: "regenerate" } },
          { type: "provider-runtime.continue", sourceRunId: RunId.make("run:outbox") },
        ] as const;
        const pending = [manual, assisted].flatMap((threadId) =>
          requests.map((request) => ({
            id: `effect:${threadId}:${request.type}`,
            commandId: CommandId.make(`command:${threadId}:${request.type}`),
            threadId,
            request,
          })),
        );
        yield* EffectOutbox.EffectOutboxV2.use((outbox) => outbox.enqueue(pending)).pipe(
          Effect.provide(EffectOutbox.layer),
        );
        yield* worker.drain();

        const settled = yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
          Effect.forEach(pending, (effect) => outbox.get(effect.id)),
        ).pipe(Effect.provide(EffectOutbox.layer));
        for (const [index, effect] of settled.entries()) {
          assert.isTrue(Option.isSome(effect));
          if (Option.isNone(effect)) continue;
          const refused = (effect.value.lastError ?? "").includes("manual video thread");
          if (pending[index]?.threadId === manual) {
            assert.strictEqual(effect.value.status, "failed", effect.value.request.type);
            assert.strictEqual(effect.value.attemptCount, 1, effect.value.request.type);
            assert.isTrue(refused, effect.value.request.type);
          } else {
            assert.isFalse(refused, effect.value.request.type);
          }
        }
      }),
    ),
  );

  it.effect("upstream and assisted threads still reach the provider", () =>
    withHarness((sessionOpens) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const assisted = yield* createVideo("op:assisted", "assisted");
        yield* ThreadMessageIntake.dispatchCommand(message(assisted, "assisted"));
        yield* worker.drain();
        assert.strictEqual(yield* Ref.get(sessionOpens), 1);
        const projection = yield* orchestrator.getThreadProjection(assisted);
        assert.strictEqual(projection.runs.length, 1);
      }),
    ),
  );
});
