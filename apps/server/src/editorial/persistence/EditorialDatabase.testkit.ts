// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as EditorialThreadService from "../EditorialThreadService.ts";
import * as EditorialPersistence from "../persistenceLayer.ts";
import * as EditorialDatabase from "./EditorialDatabase.ts";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment:editorial-test");

/** Launches nothing unless a test passes its own double. */
const layerLaunchUnused = Layer.mock(ThreadLaunch.ThreadLaunchService)({});

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
