// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/sql/Migrator";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import { ManualThreadLauncher } from "../ManualThreadLauncher.ts";
import * as EditorialThreadService from "../EditorialThreadService.ts";
import * as EditorialPersistence from "../persistenceLayer.ts";
import { EditorialVideoProject } from "../VideoProject.ts";
import * as EditorialDatabase from "./EditorialDatabase.ts";
import { EDITORIAL_MIGRATIONS_TABLE } from "./Migrations.ts";
import Migration0001 from "./Migrations/001_EditorialFoundation.ts";
import Migration0002 from "./Migrations/002_EditorialOrdering.ts";
import Migration0003 from "./Migrations/003_EditorialScriptHead.ts";
import Migration0004 from "./Migrations/004_EditorialRuns.ts";

export const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment:editorial-test");

/** The project an omitted `projectId` resolves to in tests. */
export const TEST_STUDIO_PROJECT_ID = ProjectId.make("project:editorial-studio");

/** Launches nothing unless a test passes its own double. */
const layerLaunchUnused = Layer.mock(ThreadLaunch.ThreadLaunchService)({});

/**
 * A manual thread goes through the same launch double as an assisted one.
 * `ManualThreadPolicy.integration.test.ts` runs the real manual launcher.
 */
const layerManualFromLaunch = Layer.effect(
  ManualThreadLauncher,
  Effect.gen(function* () {
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    return ManualThreadLauncher.of({ launch: (input) => launches.launch(input) });
  }),
);

export const makeTempDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "earlyscript-editorial-"));

export const removeDir = (dir: string) =>
  Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

/** Storage services plus EditorialThreadService over `launch`, which defaults to none. */
export const layerAt = (
  dbPath: string,
  launch: Layer.Layer<ThreadLaunch.ThreadLaunchService> = layerLaunchUnused,
) =>
  EditorialThreadService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        launch,
        layerManualFromLaunch.pipe(Layer.provide(launch)),
        Layer.mock(EditorialVideoProject)({
          resolve: (projectId) => Effect.succeed(projectId ?? TEST_STUDIO_PROJECT_ID),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(TEST_ENVIRONMENT_ID),
        }),
      ),
    ),
    Layer.provideMerge(
      EditorialPersistence.layerFromDatabase(EditorialDatabase.layerFromPath(dbPath)),
    ),
    Layer.provide(NodeServices.layer),
  );

/** Runs `effect` against the editorial services over a fresh temporary database file. */
export const withEditorialDatabase = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  options: { readonly launch?: Layer.Layer<ThreadLaunch.ThreadLaunchService> } = {},
) => {
  const dir = makeTempDir();
  return effect.pipe(
    Effect.provide(
      layerAt(NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME), options.launch),
    ),
    Effect.ensuring(removeDir(dir)),
  );
};

const MIGRATIONS = {
  1: ["EditorialFoundation", Migration0001],
  2: ["EditorialOrdering", Migration0002],
  3: ["EditorialScriptHead", Migration0003],
  4: ["EditorialRuns", Migration0004],
} as const;

/** Applies only `ids`, in order, to the file at `dbPath`, as an older checkout would have. */
export const applyOnly = (dbPath: string, ids: ReadonlyArray<keyof typeof MIGRATIONS>) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        ids.map((id) => [`${id}_${MIGRATIONS[id][0]}`, MIGRATIONS[id][1]] as const),
      ),
    ),
    table: EDITORIAL_MIGRATIONS_TABLE,
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
