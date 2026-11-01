// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type Project, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { makeTempDir, removeDir } from "./persistence/EditorialDatabase.testkit.ts";
import {
  EditorialVideoProject,
  layer as videoProjectLayer,
  VIDEO_PROJECT_FOLDER,
  VIDEO_PROJECT_TITLE,
} from "./VideoProject.ts";

/** Bootstraps by folder as ProjectService does, failing on a folder that does not exist. */
const makeProjectsDouble = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<ProjectService.ProjectBootstrapInput>>([]);
  const byRoot = new Map<string, Project>();
  const layer = Layer.mock(ProjectService.ProjectService)({
    bootstrap: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (current) => [...current, input]);
        if (!NodeFS.existsSync(input.workspaceRoot)) {
          return yield* new ProjectService.ProjectOperationError({
            operation: "normalize-workspace",
            workspaceRoot: input.workspaceRoot,
            cause: "workspace root does not exist",
          });
        }
        const existing = byRoot.get(input.workspaceRoot);
        if (existing !== undefined) return { project: existing, created: false };
        const project = { id: input.projectId, title: input.title } as unknown as Project;
        byRoot.set(input.workspaceRoot, project);
        return { project, created: true };
      }),
  });
  return { calls, layer };
});

const withVideoProject = <A, E>(
  body: (
    baseDir: string,
    projects: Effect.Success<typeof makeProjectsDouble>,
  ) => Effect.Effect<A, E, EditorialVideoProject>,
) =>
  Effect.gen(function* () {
    const baseDir = makeTempDir();
    const projects = yield* makeProjectsDouble;
    return yield* body(baseDir, projects).pipe(
      Effect.provide(
        videoProjectLayer.pipe(
          Layer.provide(
            Layer.mergeAll(projects.layer, ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.ensuring(removeDir(baseDir)),
    );
  });

describe("EditorialVideoProject", () => {
  it.effect("keeps the project the client chose", () =>
    withVideoProject((_baseDir, projects) =>
      Effect.gen(function* () {
        const video = yield* EditorialVideoProject;
        const chosen = ProjectId.make("project:chosen");
        assert.strictEqual(yield* video.resolve(chosen), chosen);
        assert.deepStrictEqual(yield* Ref.get(projects.calls), []);
      }),
    ),
  );

  it.effect("creates the studio folder and project once, then finds it", () =>
    withVideoProject((baseDir, projects) =>
      Effect.gen(function* () {
        const video = yield* EditorialVideoProject;
        const [first, second] = yield* Effect.all(
          [video.resolve(undefined), video.resolve(undefined)],
          { concurrency: "unbounded" },
        );
        assert.strictEqual(first, second);

        const root = NodePath.join(baseDir, VIDEO_PROJECT_FOLDER);
        assert.isTrue(NodeFS.statSync(root).isDirectory());
        const calls = yield* Ref.get(projects.calls);
        assert.deepStrictEqual(
          calls.map((call) => [call.title, call.workspaceRoot]),
          [
            [VIDEO_PROJECT_TITLE, root],
            [VIDEO_PROJECT_TITLE, root],
          ],
        );
        assert.strictEqual(calls[0]?.projectId, first);
      }),
    ),
  );
});
