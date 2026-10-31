// @effect-diagnostics nodeBuiltinImport:off - lays out a stand-in app resources directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_CONFIG_PATH } from "@earlyscript/trend-engine/run";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { locateEngine } from "./engineProcess.ts";

const WORKSPACE_CLI = NodePath.join(NodePath.dirname(DEFAULT_CONFIG_PATH), "..", "src", "cli.ts");

/** A resources directory as the packaged app lays it out, with the bundled engine. */
const packagedResources = () => {
  const resources = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-resources-"));
  NodeFS.mkdirSync(NodePath.join(resources, "trend-engine", "dist"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(resources, "trend-engine", "dist", "cli.mjs"), "");
  return resources;
};

describe("locateEngine", () => {
  it.effect("prefers the engine bundled in the packaged app's resources", () =>
    Effect.gen(function* () {
      const resources = packagedResources();
      const engine = yield* locateEngine({
        configured: Option.none(),
        resourcesPath: resources,
        workspaceCli: WORKSPACE_CLI,
      });
      assert.deepStrictEqual(engine, {
        cli: NodePath.join(resources, "trend-engine", "dist", "cli.mjs"),
        defaultConfig: NodePath.join(resources, "trend-engine", "config", "engine.v1.json"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("runs this workspace's sources in development, Electron resources or not", () =>
    Effect.gen(function* () {
      const electronDevResources = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "electron-"));
      for (const resourcesPath of [undefined, electronDevResources]) {
        const engine = yield* locateEngine({
          configured: Option.none(),
          resourcesPath,
          workspaceCli: WORKSPACE_CLI,
        });
        assert.strictEqual(engine.cli, WORKSPACE_CLI);
        assert.strictEqual(NodePath.resolve(engine.defaultConfig), DEFAULT_CONFIG_PATH);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails with the paths it tried, and never falls back from a configured CLI", () =>
    Effect.gen(function* () {
      const missing = yield* locateEngine({
        configured: Option.some("/nowhere/cli.mjs"),
        resourcesPath: packagedResources(),
        workspaceCli: WORKSPACE_CLI,
      }).pipe(Effect.flip);
      assert.strictEqual(missing._tag, "EngineNotFound");
      assert.strictEqual(missing.message, "No trend engine CLI at /nowhere/cli.mjs");

      const bundledServer = yield* locateEngine({
        configured: Option.none(),
        resourcesPath: "/Applications/Earlyscript.app/Contents/Resources",
        workspaceCli: undefined,
      }).pipe(Effect.flip);
      assert.include(bundledServer.message, "Contents/Resources/trend-engine/dist/cli.mjs");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
