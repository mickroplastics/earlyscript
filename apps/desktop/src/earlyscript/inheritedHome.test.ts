import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { dropInheritedT3Home } from "./inheritedHome.ts";

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

describe("dropInheritedT3Home", () => {
  it.effect("keeps the packaged app's logs and state out of an inherited T3 Code home", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_HOME: "/Users/alice/.t3", PATH: "/usr/bin" };
      dropInheritedT3Home(env, true);
      const environment = yield* environmentFor(true, env);

      assert.equal(environment.baseDir, "/Users/alice/.earlyscript");
      assert.equal(environment.logDir, "/Users/alice/.earlyscript/userdata/logs");
      assert.equal(env.PATH, "/usr/bin");
    }),
  );

  it.effect("keeps the home the dev runner sets for an unpackaged app", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { T3CODE_HOME: "/repo/.t3" };
      dropInheritedT3Home(env, false);
      const environment = yield* environmentFor(false, env);

      assert.equal(environment.baseDir, "/repo/.t3");
    }),
  );
});
