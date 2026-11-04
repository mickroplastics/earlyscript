// @effect-diagnostics nodeBuiltinImport:off - lays out T3 Code's userData on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePlatformPath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "../app/DesktopLegacyLocalStorage.ts";

describe("DesktopLegacyLocalStorage (Earlyscript)", () => {
  it.effect("never imports T3 Code's Local Storage", () =>
    Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "es-legacy-"));
      try {
        const appData = NodePath.join(home, "Library", "Application Support");
        for (const profile of ["t3code", "T3 Code (Alpha)"]) {
          const leveldb = NodePath.join(appData, profile, "Local Storage", "leveldb");
          NodeFS.mkdirSync(leveldb, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(leveldb, "000003.log"), "not leveldb");
        }
        const userData = NodePath.join(appData, "earlyscript");
        NodeFS.mkdirSync(userData, { recursive: true });

        const legacy = yield* DesktopLegacyLocalStorage.DesktopLegacyLocalStorage.pipe(
          Effect.provide(
            DesktopLegacyLocalStorage.layer.pipe(
              Layer.provideMerge(
                DesktopEnvironment.layer({
                  dirname: "/app/Contents/Resources/app.asar/apps/desktop/dist-electron",
                  homeDirectory: home,
                  platform: "darwin",
                  processArch: "arm64",
                  appVersion: "0.1.5",
                  appPath: "/app/Contents/Resources/app.asar",
                  isPackaged: true,
                  resourcesPath: "/app/Contents/Resources",
                  runningUnderArm64Translation: false,
                }).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      NodeServices.layer,
                      NodePlatformPath.layerPosix,
                      DesktopConfig.layerTest({}),
                    ),
                  ),
                ),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        yield* legacy.load(userData);

        assert.isTrue(Option.isNone(yield* legacy.take));
        // Nothing to import: the marker is written at once, so later launches skip the search.
        assert.isTrue(NodeFS.existsSync(NodePath.join(userData, "v1-local-storage-imported")));
      } finally {
        NodeFS.rmSync(home, { recursive: true, force: true });
      }
    }),
  );
});
