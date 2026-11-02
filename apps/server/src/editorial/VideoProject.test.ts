import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { STUDIO_AGENTS_MD, STUDIO_CLAUDE_MD } from "./studioInstructions.ts";
import {
  EditorialVideoProject,
  layer as videoProjectLayer,
  VIDEO_PROJECT_FOLDER,
  VIDEO_PROJECT_TITLE,
} from "./VideoProject.ts";

// The real ProjectService over SQLite, with the real folder normalization. Only the
// repository identity and favicon lookups are doubles: the studio folder has neither.
const layerMetadata = Layer.mergeAll(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    invalidate: () => Effect.void,
    resolvePath: () => Effect.succeed(null),
  }),
);

const layerProjects = RuntimeLayer.layerProjectService.pipe(
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(layerMetadata),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest()),
);

/** `body(baseDir)` against the studio resolver and the projects it writes, over a fresh base. */
const withVideoProject = <A, E>(
  body: (
    baseDir: string,
  ) => Effect.Effect<
    A,
    E,
    EditorialVideoProject | ProjectService.ProjectService | FileSystem.FileSystem | Path.Path
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "editorial-video-project-" });
    return yield* body(baseDir).pipe(
      Effect.provide(
        videoProjectLayer.pipe(
          Layer.provideMerge(layerProjects),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Two first clicks at once. */
const resolveTwiceAtOnce = EditorialVideoProject.use((video) =>
  Effect.all([video.resolve(undefined), video.resolve(undefined)], {
    concurrency: "unbounded",
  }),
);

const createProject = (id: string, title: string, workspaceRoot: string) =>
  Effect.gen(function* () {
    yield* FileSystem.FileSystem.use((fs) => fs.makeDirectory(workspaceRoot, { recursive: true }));
    yield* ProjectService.ProjectService.use((projects) =>
      projects.create({
        commandId: CommandId.make(`command:${id}`),
        projectId: ProjectId.make(id),
        title,
        workspaceRoot,
      }),
    );
  });

const activeProjects = ProjectService.ProjectService.use((projects) => projects.snapshot).pipe(
  Effect.map((snapshot) => snapshot.projects.filter((project) => project.deletedAt === null)),
);

describe("EditorialVideoProject", () => {
  it.effect("keeps the project the client chose", () =>
    withVideoProject(() =>
      Effect.gen(function* () {
        const chosen = ProjectId.make("project:chosen");
        assert.strictEqual(
          yield* EditorialVideoProject.use((video) => video.resolve(chosen)),
          chosen,
        );
        assert.deepStrictEqual(yield* activeProjects, []);
      }),
    ),
  );

  it.effect("creates one studio folder and project for two first clicks at once", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const [first, second] = yield* resolveTwiceAtOnce;
        assert.strictEqual(first, second);
        const path = yield* Path.Path;
        const root = path.join(baseDir, VIDEO_PROJECT_FOLDER);
        assert.isTrue(yield* FileSystem.FileSystem.use((fs) => fs.exists(root)));
        const projects = yield* activeProjects;
        assert.deepStrictEqual(
          projects.map((project) => [project.id, project.title, project.workspaceRoot]),
          [[first, VIDEO_PROJECT_TITLE, root]],
        );
        // A later click finds it by its folder.
        assert.strictEqual(
          yield* EditorialVideoProject.use((video) => video.resolve(undefined)),
          first,
        );
      }),
    ),
  );

  it.effect("writes the studio's AGENTS.md and CLAUDE.md once and keeps the operator's edits", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(baseDir, VIDEO_PROJECT_FOLDER);
        yield* EditorialVideoProject.use((video) => video.resolve(undefined));
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "AGENTS.md")),
          STUDIO_AGENTS_MD,
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "CLAUDE.md")),
          STUDIO_CLAUDE_MD,
        );
        assert.include(STUDIO_AGENTS_MD, "dossier_read");
        assert.include(STUDIO_AGENTS_MD, "script_check");
        assert.include(STUDIO_AGENTS_MD, "expediente.md");

        yield* fs.writeFileString(path.join(root, "AGENTS.md"), "# Mis reglas\n");
        yield* fs.remove(path.join(root, "CLAUDE.md"));
        yield* EditorialVideoProject.use((video) => video.resolve(undefined));
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "AGENTS.md")),
          "# Mis reglas\n",
        );
        // A missing file comes back; an edited one never changes.
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "CLAUDE.md")),
          STUDIO_CLAUDE_MD,
        );
      }),
    ),
  );

  it.effect("writes the instructions back when the client sends the studio's own id", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(baseDir, VIDEO_PROJECT_FOLDER);
        // After the first thread the client sends the studio's id, not undefined.
        const studioId = yield* EditorialVideoProject.use((video) => video.resolve(undefined));
        yield* fs.remove(path.join(root, "AGENTS.md"));
        yield* fs.remove(path.join(root, "CLAUDE.md"));
        assert.strictEqual(
          yield* EditorialVideoProject.use((video) => video.resolve(studioId)),
          studioId,
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "AGENTS.md")),
          STUDIO_AGENTS_MD,
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "CLAUDE.md")),
          STUDIO_CLAUDE_MD,
        );

        yield* fs.writeFileString(path.join(root, "AGENTS.md"), "# Mis reglas\n");
        yield* EditorialVideoProject.use((video) => video.resolve(studioId));
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "AGENTS.md")),
          "# Mis reglas\n",
        );

        // Another project of the client gets nothing.
        yield* createProject("project:other", "Otro", path.join(baseDir, "other"));
        yield* EditorialVideoProject.use((video) => video.resolve(ProjectId.make("project:other")));
        assert.isFalse(yield* fs.exists(path.join(baseDir, "other", "AGENTS.md")));
      }),
    ),
  );

  it.effect("restores the instructions of the studio when a thread opens, never over edits", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(baseDir, VIDEO_PROJECT_FOLDER);
        const studioId = yield* EditorialVideoProject.use((video) => video.resolve(undefined));
        yield* fs.remove(path.join(root, "AGENTS.md"));
        yield* fs.remove(path.join(root, "CLAUDE.md"));
        yield* EditorialVideoProject.use((video) => video.ensureInstructions(studioId));
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "AGENTS.md")),
          STUDIO_AGENTS_MD,
        );
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "CLAUDE.md")),
          STUDIO_CLAUDE_MD,
        );

        yield* fs.writeFileString(path.join(root, "AGENTS.md"), "# Mis reglas\n");
        yield* EditorialVideoProject.use((video) => video.ensureInstructions(studioId));
        assert.strictEqual(
          yield* fs.readFileString(path.join(root, "AGENTS.md")),
          "# Mis reglas\n",
        );

        // Another project, or one that does not exist, gets nothing and fails nothing.
        yield* createProject("project:other", "Otro", path.join(baseDir, "other"));
        yield* EditorialVideoProject.use((video) =>
          video.ensureInstructions(ProjectId.make("project:other")),
        );
        yield* EditorialVideoProject.use((video) =>
          video.ensureInstructions(ProjectId.make("project:missing")),
        );
        assert.isFalse(yield* fs.exists(path.join(baseDir, "other", "AGENTS.md")));
      }),
    ),
  );

  it.effect("writes no instructions into a project the client chose", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* EditorialVideoProject.use((video) =>
          video.resolve(ProjectId.make("project:chosen")),
        );
        assert.isFalse(yield* fs.exists(path.join(baseDir, VIDEO_PROJECT_FOLDER, "AGENTS.md")));
      }),
    ),
  );

  it.effect("registers a studio folder that exists without a project", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const root = path.join(baseDir, VIDEO_PROJECT_FOLDER);
        yield* FileSystem.FileSystem.use((fs) => fs.makeDirectory(root, { recursive: true }));
        const [first] = yield* resolveTwiceAtOnce;
        const projects = yield* activeProjects;
        assert.deepStrictEqual(
          projects.map((project) => [project.id, project.workspaceRoot]),
          [[first, root]],
        );
      }),
    ),
  );

  it.effect("reuses a project already in the studio folder, whatever its title", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* createProject("project:existing", "Otro nombre", path.join(baseDir, "estudio"));
        const [first, second] = yield* resolveTwiceAtOnce;
        assert.strictEqual(first, "project:existing");
        assert.strictEqual(second, "project:existing");
        assert.strictEqual((yield* activeProjects).length, 1);
      }),
    ),
  );

  it.effect("identifies the studio by its folder, not by a project titled Estudio", () =>
    withVideoProject((baseDir) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* createProject("project:elsewhere", VIDEO_PROJECT_TITLE, path.join(baseDir, "other"));
        const [first, second] = yield* resolveTwiceAtOnce;
        assert.strictEqual(first, second);
        assert.notStrictEqual(first, "project:elsewhere");
        const projects = yield* activeProjects;
        assert.deepStrictEqual(projects.map((project) => project.workspaceRoot).toSorted(), [
          path.join(baseDir, "estudio"),
          path.join(baseDir, "other"),
        ]);
      }),
    ),
  );
});
