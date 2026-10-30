// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hook is wired.
// Earlyscript-only: the `sourceControlHosts` hook. The setup file turns every flag on for upstream
// suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import { BUILT_IN_SOURCE_CONTROL_DRIVER_LIST } from "../sourceControl/sourceControlDefinitions.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { sourceControlHostDrivers } from "./sourceControlHosts.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

// The host layer only captures these services; with no drivers nothing calls them.
const layerHostServices = Layer.mergeAll(
  Layer.mock(ServerSettings.ServerSettingsService)({}),
  Layer.mock(VcsProcess.VcsProcess)({}),
  Layer.mock(GitVcsDriver.GitVcsDriver)({}),
  Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
  NodeServices.layer,
  FetchHttpClient.layer,
);

describe("Earlyscript source control hosts with the sourceControlHosts flag at its default", () => {
  it("keeps every hosting driver out of the list", () => {
    expect(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST.length).toBeGreaterThan(0);
    expect(sourceControlHostDrivers(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST)).toEqual([]);
  });

  it.effect("registers no hosting driver, so nothing runs gh or glab", () =>
    Effect.gen(function* () {
      const drivers = yield* BuiltInDrivers.SourceControlDrivers;
      expect(drivers).toEqual([]);
    }).pipe(Effect.provide(BuiltInDrivers.layer.pipe(Layer.provide(layerHostServices)))),
  );

  it("is the list the server reads hosts from", () => {
    const source = NodeFS.readFileSync(
      new URL("../sourceControl/builtInDrivers.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("sourceControlHostDrivers(BUILT_IN_SOURCE_CONTROL_DRIVER_LIST)");
  });
});
