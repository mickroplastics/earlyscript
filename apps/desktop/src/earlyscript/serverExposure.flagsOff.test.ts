// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `remoteAccess` hooks on desktop server exposure. The setup file turns every
// flag on for upstream suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopNetworkInterfaces from "../backend/DesktopNetworkInterfaces.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as UpstreamExposure from "../ipc/methods/serverExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as EarlyscriptExposure from "./serverExposure.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const lanNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
};

const layerExposure = (baseDir: string) => {
  const env = { T3CODE_HOME: baseDir };
  return DesktopServerExposure.layer.pipe(
    Layer.provideMerge(DesktopAppSettings.layer),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
    // Nothing may run `tailscale`; a spawn fails the test.
    Layer.provideMerge(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("spawned a process")),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(DesktopNetworkInterfaces.DesktopNetworkInterfaces, {
        read: Effect.succeed(lanNetworkInterfaces),
      }),
    ),
    Layer.provideMerge(DesktopConfig.layerTest(env)),
    Layer.provideMerge(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "linux",
        processArch: "x64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest(env)))),
    ),
  );
};

describe("Desktop server exposure with the remoteAccess flag at its default", () => {
  it.effect("starts the backend local-only and without Serve whatever the saved settings say", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "earlyscript-desktop-exposure-test-",
      });
      yield* Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        // Settings an earlier build saved with network access and Serve on.
        yield* settings.setServerExposureMode("network-accessible");
        yield* settings.setTailscaleServe({ enabled: true, port: Option.none() });

        const exposure = yield* DesktopServerExposure.DesktopServerExposure;
        const state = yield* exposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "local-only");
        assert.equal(state.endpointUrl, null);
        assert.equal(state.tailscaleServeEnabled, false);
        const backend = yield* exposure.backendConfig;
        assert.equal(backend.bindHost, "127.0.0.1");
        assert.equal(backend.tailscaleServeEnabled, false);
        assert.deepEqual(
          (yield* exposure.getAdvertisedEndpoints).map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/"],
        );
        // The saved preference is left as it was.
        assert.equal((yield* settings.get).serverExposureMode, "network-accessible");
      }).pipe(Effect.provide(layerExposure(baseDir)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("answers the exposure setters with the Earlyscript error", () =>
    Effect.gen(function* () {
      for (const name of ["setServerExposureMode", "setTailscaleServeEnabled"] as const) {
        const method = EarlyscriptExposure[name];
        assert.notStrictEqual(method, UpstreamExposure[name]);
        assert.equal(method.channel, UpstreamExposure[name].channel);
        // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
        const handled = method.handler(undefined) as Effect.Effect<
          never,
          EarlyscriptExposure.ServerExposureDisabledError
        >;
        const error = yield* Effect.flip(handled);
        assert.instanceOf(error, EarlyscriptExposure.ServerExposureDisabledError);
      }
    }),
  );

  it("is what the IPC handlers and the exposure service use", () => {
    const read = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");
    assert.include(
      read("../ipc/DesktopIpcHandlers.ts"),
      'import { setServerExposureMode, setTailscaleServeEnabled } from "../earlyscript/serverExposure.ts";',
    );
    assert.include(
      read("../backend/DesktopServerExposure.ts"),
      "EarlyscriptLocalExposure.localOnlySettings(yield* desktopSettings.get)",
    );
  });
});
