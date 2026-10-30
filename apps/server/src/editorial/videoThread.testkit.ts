// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";
import { layerAt, makeTempDir, removeDir } from "./persistence/EditorialDatabase.testkit.ts";
import * as ScriptVersionService from "./ScriptVersionService.ts";

export const VIDEO_THREAD_ID = "thread-video";
export const SCRIPT_PATH = "videos/quantum.md";

export interface VideoWorkspace {
  /** The thread's worktree. */
  readonly workspace: string;
  /** A sibling folder outside it. */
  readonly outside: string;
  readonly write: (relativePath: string, contents: string) => Effect.Effect<void>;
}

const layerWorkspaceFiles = WorkspaceFileSystem.layer.pipe(
  Layer.provide(Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void })),
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "editorial-script-test-" }),
  ),
  Layer.provide(NodeServices.layer),
);

/**
 * Editorial services and ScriptVersionService over a temporary database, with
 * one registered video thread whose worktree is a temporary folder. The
 * thread has dossier `dossier-1` attached.
 */
export const withVideoWorkspace = <A, E, R>(
  body: (workspace: VideoWorkspace) => Effect.Effect<A, E, R>,
) => {
  const root = makeTempDir();
  const workspace = NodePath.join(root, "workspace");
  const outside = NodePath.join(root, "outside");
  NodeFS.mkdirSync(workspace);
  NodeFS.mkdirSync(outside);
  const layer = ScriptVersionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed({ ...liveThreadShell(threadId), worktreePath: workspace }),
        }),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
        layerWorkspaceFiles,
      ),
    ),
    Layer.provideMerge(layerAt(NodePath.join(root, EditorialDatabase.EDITORIAL_DATABASE_FILENAME))),
  );
  const write: VideoWorkspace["write"] = (relativePath, contents) =>
    Effect.sync(() => {
      const target = NodePath.join(workspace, relativePath);
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      NodeFS.writeFileSync(target, contents);
    });
  return Effect.gen(function* () {
    yield* EditorialThreadService.use((threads) =>
      threads.registerVideoThread({
        operationId: "op-video",
        environmentId: "env-1",
        threadId: ThreadId.make(VIDEO_THREAD_ID),
        mode: "assisted",
        runId: "run-1",
        dossierId: "dossier-1",
        dossierHash: "sha256:dossier",
        scriptPath: SCRIPT_PATH,
      }),
    );
    return yield* body({ workspace, outside, write });
  }).pipe(Effect.provide(layer), Effect.ensuring(removeDir(root)));
};

export const SCRIPT = `# Hook

IBM opened its quantum roadmap this week [hn:1].

## Block 1

Error correction got cheaper [gh:2].

## Close

Subscribe for the next one.
`;
