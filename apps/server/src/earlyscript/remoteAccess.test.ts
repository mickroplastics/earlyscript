// Earlyscript-only: the `remoteAccess` hook on the server's environment descriptor. The setup file
// turns every flag on for upstream suites, so this file replaces the flags with their real defaults.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

describe("Earlyscript remote access with the remoteAccess flag at its default", () => {
  it.effect("does not advertise linked environments to clients", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "earlyscript-remote-access-test-",
      });
      const descriptor = yield* Effect.gen(function* () {
        const environment = yield* ServerEnvironment.ServerEnvironment;
        return yield* environment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      expect(descriptor.capabilities.peerLinks).toBe(false);
      // The rest of the descriptor is upstream's.
      expect(descriptor.capabilities.repositoryIdentity).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
