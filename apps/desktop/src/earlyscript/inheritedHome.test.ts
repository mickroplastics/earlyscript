import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { adoptInheritedEnvironment } from "./inheritedHome.ts";

const environmentFor = (isPackaged: boolean, env: NodeJS.ProcessEnv) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer({
        dirname: "/app/Contents/Resources/app.asar/apps/desktop/dist-electron",
        homeDirectory: "/Users/alice",
        platform: "darwin",
        processArch: "arm64",
        appVersion: "0.1.5",
        appPath: "/app/Contents/Resources/app.asar",
        isPackaged,
        resourcesPath: "/app/Contents/Resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
        ),
      ),
    ),
  );

/** What a terminal or agent started by T3 Code exports. */
const fromT3Code = (): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin",
  T3CODE_HOME: "/Users/alice/.t3",
  T3CODE_THREAD_ID: "thread:1",
  T3_BOOT_SERVICE_UNIT: "t3code.service",
  T3_SERVICE_LAUNCHER_CONTEXT: "{}",
  ELECTRON_RUN_AS_NODE: "1",
});

describe("adoptInheritedEnvironment", () => {
  it.effect("keeps the packaged app's logs and state out of an inherited T3 Code home", () =>
    Effect.gen(function* () {
      const env = fromT3Code();
      adoptInheritedEnvironment(env, true);
      const environment = yield* environmentFor(true, env);

      assert.equal(environment.baseDir, "/Users/alice/.earlyscript");
      assert.equal(environment.logDir, "/Users/alice/.earlyscript/userdata/logs");
      assert.deepStrictEqual(env, { PATH: "/usr/bin" });
    }),
  );

  it.effect("takes the home from EARLYSCRIPT_HOME", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { ...fromT3Code(), EARLYSCRIPT_HOME: "/Users/alice/es-home" };
      adoptInheritedEnvironment(env, true);
      const environment = yield* environmentFor(true, env);

      assert.equal(environment.baseDir, "/Users/alice/es-home");
    }),
  );

  it.effect("keeps the home the dev runner passes to an unpackaged app", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_HOME: "/repo/.t3", EARLYSCRIPT_HOME: "/repo/.t3" };
      adoptInheritedEnvironment(env, false);
      const environment = yield* environmentFor(false, env);

      assert.equal(environment.baseDir, "/repo/.t3");
    }),
  );

  it.effect("ignores T3 Code's home in development too", () =>
    Effect.gen(function* () {
      const env = fromT3Code();
      adoptInheritedEnvironment(env, false);
      const environment = yield* environmentFor(false, env);

      assert.equal(environment.baseDir, "/Users/alice/.earlyscript");
    }),
  );
});
