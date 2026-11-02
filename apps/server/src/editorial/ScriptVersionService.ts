// @effect-diagnostics nodeBuiltinImport:off - path syntax checks, no file access.
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { EditorialCommandService, type RecordDecisionInput } from "./EditorialCommandService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import type { Decision, ScriptVersion, VideoThread } from "./persistence/EditorialModel.ts";
import { threadWorkspaceRoot } from "./threadWorkspace.ts";
import {
  type EditorialConflictError,
  type EditorialInvalidInputError,
  EditorialNotFoundError,
  type EditorialPersistenceError,
  toPersistenceError,
  type WorkClockStateError,
} from "./persistence/Errors.ts";

export const ScriptFileFailure = Schema.Literals([
  "outside-workspace",
  "not-found",
  "not-a-file",
  "binary",
  "too-large",
  "no-workspace",
  "unreadable",
]);
export type ScriptFileFailure = typeof ScriptFileFailure.Type;

export class ScriptFileError extends Schema.TaggedError<ScriptFileError>()("ScriptFileError", {
  threadId: Schema.String,
  path: Schema.String,
  reason: ScriptFileFailure,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "outside-workspace":
        return `Script path ${this.path} is not inside the thread workspace.`;
      case "not-found":
        return `Script file ${this.path} does not exist in the thread workspace.`;
      case "not-a-file":
        return `Script path ${this.path} is not a file.`;
      case "binary":
        return `Script file ${this.path} is not text.`;
      case "too-large":
        return `Script file ${this.path} is larger than a script snapshot may be.`;
      case "no-workspace":
        return `Thread ${this.threadId} has no workspace to read ${this.path} from.`;
      case "unreadable":
        return `Script file ${this.path} could not be read.`;
    }
  }
}

export interface ScriptFile {
  /** Relative to the workspace, normalized. */
  readonly relativePath: string;
  readonly workspaceRoot: string;
  readonly contents: string;
}

type ReadError =
  | ScriptFileError
  | EditorialNotFoundError
  | EditorialPersistenceError
  | EditorialInvalidInputError;

/**
 * Reads a video thread's script from its workspace and keeps immutable,
 * content-hashed snapshots of it. The decision always refers to the version
 * the server read itself, so an edit after the client's last read is caught.
 */
export class ScriptVersionService extends Context.Service<
  ScriptVersionService,
  {
    /**
     * A workspace-relative file of a video thread; the registered script path
     * when `path` is omitted. Absolute paths and paths that leave the
     * workspace, through `..` or a symlink, are refused.
     */
    readonly readScript: (input: {
      readonly threadId: string;
      readonly path?: string | undefined;
    }) => Effect.Effect<ScriptFile, ReadError>;
    /** Saves the script file as it is on disk now; that version becomes the head. */
    readonly snapshot: (threadId: string) => Effect.Effect<ScriptVersion, ReadError>;
    /**
     * Snapshots the script, then records the decision. Fails with a conflict
     * when `scriptVersionHash` is not the content the server just read, and
     * with `not-found` when the script file is gone but the thread had saved a
     * version or the decision names one.
     */
    readonly decide: (
      input: RecordDecisionInput,
    ) => Effect.Effect<Decision, ReadError | EditorialConflictError | WorkClockStateError>;
  }
>()("t3/editorial/ScriptVersionService") {}

/** Syntax checks the workspace file reader skips for absolute host paths. */
const isWorkspaceRelative = (path: string) =>
  path.length > 0 &&
  !path.includes("\0") &&
  !path.startsWith("~") &&
  !NodePath.posix.isAbsolute(path) &&
  !NodePath.win32.isAbsolute(path);

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const threads = yield* EditorialThreadService;
  const commands = yield* EditorialCommandService;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;

  const requireVideoThread = (threadId: string) =>
    threads.getVideoThread(threadId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new EditorialNotFoundError({ entity: "video_thread", id: threadId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const rootOf = threadWorkspaceRoot(threadManagement, projects);

  /** The thread's worktree, else its project's checkout. */
  const workspaceRootOf = Effect.fn("ScriptVersionService.workspaceRootOf")(function* (
    thread: VideoThread,
    path: string,
  ) {
    const noWorkspace = (cause?: unknown) =>
      new ScriptFileError({ threadId: thread.threadId, path, reason: "no-workspace", cause });
    const root = yield* rootOf(thread.threadId).pipe(Effect.mapError(noWorkspace));
    return root === null ? yield* noWorkspace() : root;
  });

  const readScript: ScriptVersionService["Service"]["readScript"] = Effect.fn(
    "ScriptVersionService.readScript",
  )(function* (input) {
    const thread = yield* requireVideoThread(input.threadId);
    const path = (input.path ?? thread.scriptPath ?? "").trim();
    const failure = (reason: ScriptFileFailure, cause?: unknown) =>
      new ScriptFileError({ threadId: thread.threadId, path, reason, cause });
    if (!isWorkspaceRelative(path)) return yield* failure("outside-workspace");
    const workspaceRoot = yield* workspaceRootOf(thread, path);
    // The reader resolves `..` and symlinks and refuses targets outside the root.
    const read = yield* files
      .readFile({ cwd: workspaceRoot, relativePath: path, allowMissing: true })
      .pipe(
        Effect.mapError((error) => {
          switch (error._tag) {
            case "WorkspacePathOutsideRootError":
            case "WorkspaceFilePathEscapeError":
              return failure("outside-workspace", error);
            case "WorkspacePathNotFileError":
              return failure("not-a-file", error);
            case "WorkspaceBinaryFileError":
              return failure("binary", error);
            case "WorkspaceFileSystemOperationError":
              return failure("unreadable", error);
          }
        }),
      );
    if (read.exists === false) return yield* failure("not-found");
    if (read.truncated) return yield* failure("too-large");
    return { relativePath: read.relativePath, workspaceRoot, contents: read.contents };
  });

  const snapshot: ScriptVersionService["Service"]["snapshot"] = Effect.fn(
    "ScriptVersionService.snapshot",
  )(function* (threadId) {
    const file = yield* readScript({ threadId });
    return yield* commands.saveScriptVersion({
      threadId,
      content: file.contents,
      scriptPath: file.relativePath,
    });
  });

  /**
   * Only a thread that never saved a script may be decided without its file,
   * and only by a decision that names no version. A script that disappeared
   * after a snapshot is refused until the operator restores or replaces it.
   */
  const neverHadScript = Effect.fn("ScriptVersionService.neverHadScript")(function* (
    input: RecordDecisionInput,
  ) {
    if ((input.scriptVersionHash ?? "").trim() !== "") return false;
    const rows = yield* sql<{ readonly script_head_hash: string | null }>`
      SELECT script_head_hash FROM editorial_video_threads WHERE thread_id = ${input.threadId}
    `.pipe(Effect.mapError(toPersistenceError("editorial.scriptHead")));
    return (rows[0]?.script_head_hash ?? null) === null;
  });

  const decide: ScriptVersionService["Service"]["decide"] = Effect.fn(
    "ScriptVersionService.decide",
  )(function* (input) {
    yield* snapshot(input.threadId).pipe(
      Effect.catchIf(
        (error) => error._tag === "ScriptFileError" && error.reason === "not-found",
        (missing) =>
          neverHadScript(input).pipe(
            Effect.flatMap((never) => (never ? Effect.void : Effect.fail(missing))),
          ),
      ),
    );
    return yield* commands.recordDecision(input);
  });

  return ScriptVersionService.of({ readScript, snapshot, decide });
});

export const layer = Layer.effect(ScriptVersionService, make);
