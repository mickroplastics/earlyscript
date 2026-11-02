import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeNewId } from "./persistence/support.ts";
import {
  STUDIO_AGENTS_FILE,
  STUDIO_AGENTS_MD,
  STUDIO_CLAUDE_FILE,
  STUDIO_CLAUDE_MD,
} from "./studioInstructions.ts";

/** Folder of the studio project, under the server's base directory. */
export const VIDEO_PROJECT_FOLDER = "estudio";
export const VIDEO_PROJECT_TITLE = "Estudio";

/**
 * The project a video thread opens in: the client's, else the studio project, created on first
 * use in `<baseDir>/estudio` and found by its folder after. Its `AGENTS.md` and `CLAUDE.md` are
 * written when missing, never over the operator's edits.
 */
export class EditorialVideoProject extends Context.Service<
  EditorialVideoProject,
  {
    readonly resolve: (
      projectId: ProjectId | undefined,
    ) => Effect.Effect<ProjectId, ProjectService.ProjectServiceError>;
  }
>()("t3/editorial/VideoProject/EditorialVideoProject") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const fileSystem = yield* FileSystem.FileSystem;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const newId = yield* makeNewId;
  // Two first clicks at once must find one project, not create two.
  const lock = yield* Semaphore.make(1);
  const workspaceRoot = path.join(baseDir, VIDEO_PROJECT_FOLDER);

  /** `wx`: a file that is already there, edited or not, stays as it is. */
  const writeIfMissing = (name: string, contents: string) =>
    fileSystem.writeFileString(path.join(workspaceRoot, name), contents, { flag: "wx" }).pipe(
      Effect.catch((error) =>
        error.reason._tag === "AlreadyExists"
          ? Effect.void
          : // The thread still opens; its agent then lacks the studio's instructions.
            Effect.logWarning("Cannot write the studio instructions", { name, error }),
      ),
    );

  const studio = lock.withPermits(1)(
    Effect.gen(function* () {
      // `bootstrap` looks the folder up before creating anything, and a missing one fails it.
      yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectService.ProjectOperationError({
              operation: "normalize-workspace",
              workspaceRoot,
              cause,
            }),
        ),
      );
      yield* writeIfMissing(STUDIO_AGENTS_FILE, STUDIO_AGENTS_MD);
      yield* writeIfMissing(STUDIO_CLAUDE_FILE, STUDIO_CLAUDE_MD);
      const { project } = yield* projects.bootstrap({
        commandId: CommandId.make(`editorial:video-project:${yield* newId}`),
        projectId: ProjectId.make(yield* newId),
        title: VIDEO_PROJECT_TITLE,
        workspaceRoot,
      });
      return project.id;
    }),
  );

  const resolve: EditorialVideoProject["Service"]["resolve"] = Effect.fn(
    "EditorialVideoProject.resolve",
  )(function* (projectId) {
    return projectId ?? (yield* studio);
  });

  return EditorialVideoProject.of({ resolve });
});

export const layer = Layer.effect(EditorialVideoProject, make);
