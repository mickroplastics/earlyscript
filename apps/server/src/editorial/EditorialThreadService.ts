import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2CreationSource,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import type {
  EditorialActor,
  VideoThread,
  VideoThreadLaunchState,
  VideoThreadMode,
  WorkClockSummary,
} from "./persistence/EditorialModel.ts";
import {
  EditorialConflictError,
  EditorialInvalidInputError,
  EditorialNotFoundError,
  type EditorialPersistenceError,
  toPersistenceError,
} from "./persistence/Errors.ts";
import { makeNewId, nowIso } from "./persistence/support.ts";
import { EditorialVideoProject } from "./VideoProject.ts";
import { type WorkClockError, WorkClockService } from "./WorkClockService.ts";

export interface RegisterVideoThreadInput {
  /** Generated once by the caller and reused on every retry of the same creation. */
  readonly operationId: string;
  readonly environmentId: string;
  /** The ThreadId the caller will launch, chosen before launching. */
  readonly threadId: string;
  readonly mode: VideoThreadMode;
  readonly trendKey?: string | undefined;
  readonly runId?: string | undefined;
  readonly dossierId?: string | undefined;
  readonly dossierHash?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly actor?: EditorialActor | undefined;
}

export interface RegisterVideoThreadResult {
  readonly thread: VideoThread;
  /** False when the operation was already registered and this call replayed it. */
  readonly created: boolean;
}

export interface CreateVideoInput {
  /** Generated once by the client when Miguel chooses to create; reused on every retry. */
  readonly operationId: string;
  /** The studio project of `VideoProject.ts` when omitted. */
  readonly projectId?: ProjectId | undefined;
  readonly mode: VideoThreadMode;
  /** Video title; the thread is titled "Video: <title>". */
  readonly title: string;
  /**
   * Composer defaults of the client. A manual thread keeps them but never runs them, so it
   * opens even when their provider is disabled or there is none.
   */
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly interactionMode?: ProviderInteractionMode | undefined;
  /** The project's own checkout when omitted, as a new composer thread. */
  readonly workspaceStrategy?: ThreadLaunch.ThreadLaunchWorkspaceStrategy | undefined;
  readonly creationSource?: OrchestrationV2CreationSource | undefined;
  /**
   * A trend chosen in Tendencias. An assisted thread links the trend as "in production"; a
   * manual one only records it, for the paired comparison on the same topic.
   */
  readonly trendKey?: string | undefined;
  readonly runId?: string | undefined;
  /** The immutable dossier attached to the thread, with its hash. */
  readonly dossierId?: string | undefined;
  readonly dossierHash?: string | undefined;
  /** Relative to the thread workspace; `videos/<slug>-<id>.md` when omitted. */
  readonly scriptPath?: string | undefined;
}

export interface CreateVideoResult {
  readonly thread: VideoThread;
  readonly clock: WorkClockSummary;
  /** False when a retry found the operation already registered. */
  readonly created: boolean;
}

const isProviderInstanceDisabled = Schema.is(
  ThreadManagement.ThreadManagementProviderInstanceDisabledError,
);

export class EditorialVideoLaunchError extends Schema.TaggedError<EditorialVideoLaunchError>()(
  "EditorialVideoLaunchError",
  {
    operationId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  /**
   * Shown as is in the client's toast, by both creation RPCs, so it says in Spanish what to do
   * about the causes Miguel can fix. The server log keeps the cause itself.
   */
  override get message(): string {
    const cause = this.cause as { readonly _tag?: unknown; readonly operation?: unknown };
    if (isProviderInstanceDisabled(this.cause)) {
      return `El proveedor «${this.cause.instanceId}» está desactivado. Actívalo en Ajustes › Proveedores o usa «Crear hilo manual», que funciona sin modelo.`;
    }
    if (cause?._tag === "ThreadLaunchError" && cause.operation === "resolve-project") {
      return "El proyecto del hilo ya no existe en T3.";
    }
    return "El hilo quedó registrado, pero no se pudo crear en T3. Vuelve a intentarlo; la causa queda en el registro del servidor.";
  }
}

export type CreateVideoError =
  | EditorialPersistenceError
  | EditorialInvalidInputError
  | EditorialConflictError
  | EditorialNotFoundError
  | EditorialVideoLaunchError
  | WorkClockError;

/**
 * Durable link between a T3 thread and its editorial context. `createVideo`
 * registers first, then calls ThreadLaunchService.launch; a retry resumes by
 * operation id and launch_state, never launching twice.
 */
export class EditorialThreadService extends Context.Service<
  EditorialThreadService,
  {
    readonly registerVideoThread: (
      input: RegisterVideoThreadInput,
    ) => Effect.Effect<
      RegisterVideoThreadResult,
      EditorialPersistenceError | EditorialInvalidInputError | EditorialConflictError
    >;
    readonly getVideoThread: (
      threadId: string,
    ) => Effect.Effect<Option.Option<VideoThread>, EditorialPersistenceError>;
    /** Records whether the T3 thread exists; writes an event only when the state changes. */
    readonly markLaunchState: (
      threadId: string,
      state: Exclude<VideoThreadLaunchState, "pending">,
    ) => Effect.Effect<VideoThread, EditorialPersistenceError | EditorialNotFoundError>;
    /**
     * Registers, launches the T3 thread without a first message (creating it
     * starts no agent), links the trend and starts the work clock: Explorar
     * for a manual thread, Leer for an assisted one.
     */
    readonly createVideo: (
      input: CreateVideoInput,
    ) => Effect.Effect<CreateVideoResult, CreateVideoError>;
  }
>()("t3/editorial/EditorialThreadService") {}

interface VideoThreadRow {
  readonly thread_id: string;
  readonly environment_id: string;
  readonly operation_id: string;
  readonly mode: VideoThreadMode;
  readonly trend_key: string | null;
  readonly run_id: string | null;
  readonly dossier_id: string | null;
  readonly dossier_hash: string | null;
  readonly script_path: string | null;
  readonly launch_state: VideoThreadLaunchState;
  readonly created_by: EditorialActor;
  readonly created_at: string;
}

const toVideoThread = (row: VideoThreadRow): VideoThread => ({
  threadId: row.thread_id,
  environmentId: row.environment_id,
  operationId: row.operation_id,
  mode: row.mode,
  trendKey: row.trend_key,
  runId: row.run_id,
  dossierId: row.dossier_id,
  dossierHash: row.dossier_hash,
  scriptPath: row.script_path,
  launchState: row.launch_state,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const selectBy = (sql: SqlClient.SqlClient, column: "thread_id" | "operation_id", value: string) =>
  sql<VideoThreadRow>`
    SELECT
      thread_id, environment_id, operation_id, mode, trend_key, run_id, dossier_id,
      dossier_hash, script_path, launch_state, created_by, created_at
    FROM editorial_video_threads
    WHERE ${sql(column)} = ${value}
  `.pipe(Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), toVideoThread)));

const nullable = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

const MAX_SLUG_LENGTH = 48;

/** ASCII file stem from the title, so a script path reads like its video. */
const slugify = (title: string) =>
  title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

export const defaultScriptPath = (title: string, threadId: string) => {
  const slug = slugify(title);
  const suffix = threadId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  return `videos/${slug.length === 0 ? "video" : slug}-${suffix}.md`;
};

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const eventLog = yield* EditorialEventLog;
  const commands = yield* EditorialCommandService;
  const clock = yield* WorkClockService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const videoProject = yield* EditorialVideoProject;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const newId = yield* makeNewId;

  const registerVideoThread: EditorialThreadService["Service"]["registerVideoThread"] = Effect.fn(
    "EditorialThreadService.registerVideoThread",
  )(function* (input) {
    const operation = "editorial.registerVideoThread";
    for (const [field, value] of [
      ["operationId", input.operationId],
      ["environmentId", input.environmentId],
      ["threadId", input.threadId],
    ] as const) {
      if (value.trim().length === 0) {
        return yield* new EditorialInvalidInputError({ operation, detail: `${field} is required` });
      }
    }
    return yield* eventLog.transact(
      operation,
      Effect.gen(function* () {
        // The persisted operation wins over whatever a retry proposes.
        const replay = yield* selectBy(sql, "operation_id", input.operationId);
        if (Option.isSome(replay))
          return { result: { thread: replay.value, created: false }, events: [] };
        if (Option.isSome(yield* selectBy(sql, "thread_id", input.threadId))) {
          return yield* new EditorialConflictError({
            operation,
            detail: `thread ${input.threadId} is registered by another operation`,
          });
        }
        const at = yield* nowIso;
        const actor = input.actor ?? "operator";
        const thread: VideoThread = {
          threadId: input.threadId,
          environmentId: input.environmentId,
          operationId: input.operationId,
          mode: input.mode,
          trendKey: nullable(input.trendKey),
          runId: nullable(input.runId),
          dossierId: nullable(input.dossierId),
          dossierHash: nullable(input.dossierHash),
          scriptPath: nullable(input.scriptPath),
          launchState: "pending",
          createdBy: actor,
          createdAt: at,
        };
        yield* sql`
            INSERT INTO editorial_video_threads (
              thread_id, environment_id, operation_id, mode, trend_key, run_id, dossier_id,
              dossier_hash, script_path, launch_state, created_by, created_at
            )
            VALUES (
              ${thread.threadId}, ${thread.environmentId}, ${thread.operationId}, ${thread.mode},
              ${thread.trendKey}, ${thread.runId}, ${thread.dossierId}, ${thread.dossierHash},
              ${thread.scriptPath}, ${thread.launchState}, ${actor}, ${at}
            )
          `;
        const event = yield* appendEvent(sql, {
          type: "video-thread.registered",
          aggregateKind: "video_thread",
          aggregateId: thread.threadId,
          operationId: thread.operationId,
          actor,
          payload: {
            environmentId: thread.environmentId,
            mode: thread.mode,
            trendKey: thread.trendKey,
            runId: thread.runId,
            dossierId: thread.dossierId,
          },
          createdAt: at,
        });
        return { result: { thread, created: true }, events: [event] };
      }),
    );
  });

  const getVideoThread: EditorialThreadService["Service"]["getVideoThread"] = (threadId) =>
    selectBy(sql, "thread_id", threadId).pipe(
      Effect.mapError(toPersistenceError("editorial.getVideoThread")),
    );

  const markLaunchState: EditorialThreadService["Service"]["markLaunchState"] = Effect.fn(
    "EditorialThreadService.markLaunchState",
  )(function* (threadId, state) {
    const operation = "editorial.markLaunchState";
    return yield* eventLog.transact(
      operation,
      Effect.gen(function* () {
        const current = yield* selectBy(sql, "thread_id", threadId);
        if (Option.isNone(current)) {
          return yield* new EditorialNotFoundError({ entity: "video_thread", id: threadId });
        }
        if (current.value.launchState === state) return { result: current.value, events: [] };
        yield* sql`
          UPDATE editorial_video_threads SET launch_state = ${state} WHERE thread_id = ${threadId}
        `;
        const event = yield* appendEvent(sql, {
          type: state === "launched" ? "video-thread.launched" : "video-thread.launch-failed",
          aggregateKind: "video_thread",
          aggregateId: threadId,
          actor: "system",
          payload: { operationId: current.value.operationId, previous: current.value.launchState },
          createdAt: yield* nowIso,
        });
        return { result: { ...current.value, launchState: state }, events: [event] };
      }),
    );
  });

  const createVideo: EditorialThreadService["Service"]["createVideo"] = Effect.fn(
    "EditorialThreadService.createVideo",
  )(function* (input) {
    const operation = "editorial.createVideo";
    const title = input.title.trim();
    if (title.length === 0) {
      return yield* new EditorialInvalidInputError({ operation, detail: "title is required" });
    }
    const dossierId = nullable(input.dossierId);
    const dossierHash = nullable(input.dossierHash);
    if ((dossierId === null) !== (dossierHash === null)) {
      return yield* new EditorialInvalidInputError({
        operation,
        detail: "a dossier is attached with both dossierId and dossierHash",
      });
    }
    const proposedThreadId = yield* newId;
    const registered = yield* registerVideoThread({
      operationId: input.operationId,
      environmentId: yield* environment.getEnvironmentId,
      threadId: proposedThreadId,
      mode: input.mode,
      trendKey: input.trendKey,
      runId: input.runId,
      dossierId: dossierId ?? undefined,
      dossierHash: dossierHash ?? undefined,
      scriptPath: nullable(input.scriptPath) ?? defaultScriptPath(title, proposedThreadId),
      actor: "operator",
    });
    let thread = registered.thread;
    // A retry must describe the same video; another one needs another operation id.
    if (thread.mode !== input.mode || thread.dossierId !== dossierId) {
      return yield* new EditorialConflictError({
        operation,
        detail: `operation ${input.operationId} already created a ${thread.mode} video thread`,
      });
    }
    if (thread.launchState !== "launched") {
      const threadId = ThreadId.make(thread.threadId);
      // The command id derives from the operation, so a retry replays the
      // launch receipt instead of creating a second thread.
      const commandId = CommandId.make(`editorial:create-video:${thread.operationId}`);
      const launchThread = (projectId: ProjectId) =>
        launches
          .launch({
            commandId,
            threadId,
            projectId,
            title: `Video: ${title}`,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode ?? "approval-required",
            interactionMode: input.interactionMode ?? "default",
            workspaceStrategy: input.workspaceStrategy ?? { type: "root" },
            createdBy: "user",
            creationSource: input.creationSource ?? "web",
          })
          .pipe(Effect.asVoid);
      // The launch refuses a disabled provider; a manual thread never runs one, so it is
      // created by the launch's own `thread.create`, in the project root, unprepared. The
      // shared command id lets a retry through either path replay it.
      const createManualThread = (projectId: ProjectId) =>
        threadManagement
          .dispatch({
            type: "thread.create",
            commandId,
            threadId,
            projectId,
            title: `Video: ${title}`,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode ?? "approval-required",
            interactionMode: input.interactionMode ?? "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: input.creationSource ?? "web",
          })
          .pipe(Effect.asVoid);
      const createThread = Effect.fnUntraced(function* (projectId: ProjectId) {
        if (
          input.mode === "manual" &&
          !(yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId,
            instanceId: input.modelSelection.instanceId,
          }))
        ) {
          return yield* createManualThread(projectId);
        }
        return yield* launchThread(projectId);
      });
      yield* videoProject.resolve(input.projectId).pipe(
        Effect.flatMap(createThread),
        Effect.catch((cause) =>
          markLaunchState(thread.threadId, "failed").pipe(
            Effect.ignore,
            // The client sees only that the launch failed; the server log keeps why.
            Effect.andThen(
              Effect.logWarning("Video thread launch failed", {
                operationId: thread.operationId,
                cause,
              }),
            ),
            Effect.andThen(
              Effect.fail(
                new EditorialVideoLaunchError({
                  operationId: thread.operationId,
                  threadId: thread.threadId,
                  cause,
                }),
              ),
            ),
          ),
        ),
      );
      thread = yield* markLaunchState(thread.threadId, "launched");
    }
    // The trend's production link names its assisted thread. A manual thread on the same
    // topic keeps the trend key as the paired comparison's condition and links nothing, so the
    // trend's "Crear hilo de video" still finds or creates the assisted one.
    if (thread.trendKey !== null && thread.mode === "assisted") {
      yield* commands.linkProduction({ trendKey: thread.trendKey, threadId: thread.threadId });
    }
    const summary = yield* clock.start(
      thread.threadId,
      thread.mode === "manual" ? "explore" : "read",
      { operationId: `${thread.operationId}:clock` },
    );
    return { thread, clock: summary, created: registered.created };
  });

  return EditorialThreadService.of({
    registerVideoThread,
    getVideoThread,
    markLaunchState,
    createVideo,
  });
});

export const layer = Layer.effect(EditorialThreadService, make);
