// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as EditorialLayer from "./layer.ts";
import * as EditorialPersistence from "./persistenceLayer.ts";
import * as RunDirectory from "./RunDirectory.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";
import { makeTempDir, removeDir } from "./persistence/EditorialDatabase.testkit.ts";

export const FIXTURE_RUN_ID = "run_20261019_20261027T003754_2263f7";

const fixtureRunsDir = NodePath.join(import.meta.dirname, "fixtures", "runs");

/** Editorial storage, read side, importer and handlers over `runsDir`, without the poll loop. */
const layerAt = (dbPath: string, runsDir: string, options: { readonly watch?: boolean } = {}) =>
  EditorialLayer.layerFromRunDirectory(RunDirectory.layerWithRunsDir(runsDir), {
    watch: options.watch ?? false,
  }).pipe(
    Layer.provideMerge(
      EditorialPersistence.layerFromDatabase(EditorialDatabase.layerFromPath(dbPath)),
    ),
  );

/** A writable copy of the fixture runs directory, removed with the scope. */
const copyFixtureRuns = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "editorial-runs-" });
  yield* fs.copy(fixtureRunsDir, dir);
  return { dir, runDir: path.join(dir, FIXTURE_RUN_ID) };
});

/**
 * Runs `use(runsDir)` against a fresh database and a copy of the fixture runs. The copy is
 * made first, so `use` can add or edit runs before and after the first import.
 */
export const withEditorial = <A, E, R>(
  use: (runs: { readonly dir: string; readonly runDir: string }) => Effect.Effect<A, E, R>,
  options: { readonly watch?: boolean; readonly fs?: Layer.Layer<FileSystem.FileSystem> } = {},
) => {
  const dbDir = makeTempDir();
  return Effect.gen(function* () {
    const runs = yield* copyFixtureRuns;
    const services = layerAt(
      NodePath.join(dbDir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME),
      runs.dir,
      options,
    );
    return yield* use(runs).pipe(
      Effect.provide(
        options.fs === undefined
          ? services
          : services.pipe(Layer.provide(options.fs), Layer.provide(NodeServices.layer)),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.ensuring(removeDir(dbDir)));
};
