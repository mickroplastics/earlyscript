// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EditorialPersistence from "../persistenceLayer.ts";
import * as EditorialDatabase from "./EditorialDatabase.ts";

export const makeTempDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "earlyscript-editorial-"));

export const removeDir = (dir: string) =>
  Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

export const layerAt = (dbPath: string) =>
  EditorialPersistence.layerFromDatabase(EditorialDatabase.layerFromPath(dbPath)).pipe(
    Layer.provide(NodeServices.layer),
  );

/** Runs `effect` against the editorial services over a fresh temporary database file. */
export const withEditorialDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  const dir = makeTempDir();
  return effect.pipe(
    Effect.provide(layerAt(NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME))),
    Effect.ensuring(removeDir(dir)),
  );
};
