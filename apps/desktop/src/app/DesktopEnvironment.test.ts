import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { T3CodeDataDirectoryError } from "@t3tools/shared/earlyscriptHome";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const layerEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        overrides.platform === "win32" && overrides.homeDirectory?.includes("\\")
          ? NodePath.layerWin32
          : NodePath.layerPosix,
        DesktopConfig.layerTest(env),
      ),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) => DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(layerEnvironment(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("uses the packaged Windows server sidecar as the backend root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        platform: "win32",
        isPackaged: true,
        appPath: "/install/resources/app.asar",
        resourcesPath: "/install/resources",
      });

      assert.equal(environment.appRoot, "/install/resources/app.asar");
      assert.equal(environment.serverRoot, "/install/resources/server.asar");
      assert.equal(
        environment.backendEntryPath,
        "/install/resources/server.asar/apps/server/dist/bin.mjs",
      );
      assert.equal(
        environment.clientAssetsDir,
        "/install/resources/server.asar/apps/server/dist/client",
      );
    }),
  );

  it.effect("refuses T3 Code's userData under a redirected %APPDATA% or XDG_CONFIG_HOME", () =>
    Effect.gen(function* () {
      const refused = (
        overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>,
        env: Record<string, string>,
      ) =>
        makeEnvironment(overrides, env).pipe(
          Effect.as("accepted"),
          Effect.catchDefect((defect) =>
            Effect.succeed(defect instanceof T3CodeDataDirectoryError ? "refused" : "other"),
          ),
        );
      const windows = { platform: "win32", homeDirectory: "C:\\Users\\Miguel" } as const;
      assert.equal(
        yield* refused(windows, { APPDATA: "D:\\Roaming", T3CODE_HOME: "D:\\Roaming\\t3code" }),
        "refused",
      );
      assert.equal(
        yield* refused(windows, {
          APPDATA: "D:\\Roaming",
          T3CODE_HOME: "D:\\Roaming\\t3code-dev\\x",
        }),
        "refused",
      );
      const linux = { platform: "linux", homeDirectory: "/home/miguel" } as const;
      assert.equal(
        yield* refused(linux, {
          XDG_CONFIG_HOME: "/data/config",
          T3CODE_HOME: "/data/config/t3code",
        }),
        "refused",
      );
      // The default folder stays protected when the variable points elsewhere.
      assert.equal(
        yield* refused(linux, {
          XDG_CONFIG_HOME: "/data/config",
          T3CODE_HOME: "/home/miguel/.config/t3code",
        }),
        "refused",
      );
      assert.equal(
        yield* refused(windows, {
          APPDATA: "D:\\Roaming",
          T3CODE_HOME: "D:\\Roaming\\earlyscript",
        }),
        "accepted",
      );
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.earlyscript/dev");
      assert.equal(production.stateDir, "/Users/alice/.earlyscript/userdata");
    }),
  );
});
