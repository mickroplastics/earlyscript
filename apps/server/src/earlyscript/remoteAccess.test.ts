// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `remoteAccess` hooks on the server. The setup file turns every flag on for
// upstream suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthMcpRegistrationError,
  EnvironmentHttpApi,
  MCP_PEER_LINK_SOFTWARE_ID,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf, layerLinkingEnvironment, servePeer } from "../peer/PeerLinks.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EarlyscriptRemoteAccess from "./remoteAccess.ts";

const isRegistrationError = Schema.is(AuthMcpRegistrationError);

const source = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");

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

  it.effect("refuses to link to another server even when its saved settings turn links on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
        const box = yield* servePeer(descriptorOf("environment-box", "Box"), Layer.empty).pipe(
          Effect.provideContext(server),
        );
        const here = yield* Layer.build(
          layerLinkingEnvironment(descriptorOf("environment-laptop", "Laptop")),
        );
        const links = Context.get(here, PeerLinks.PeerLinks);
        const settings = Context.get(here, ServerSettings.ServerSettingsService);
        expect((yield* settings.getSettings).linkedEnvironmentsEnabled).toBe(true);
        expect(yield* links.enabled).toBe(false);

        const pairing = yield* box.auth.issuePairingCredential();
        const refused = yield* links
          .link({ url: box.url, pairingCode: pairing.credential, access: "auto" })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("disabled");
        // Nothing reached the other server: no probe, no credential, no session.
        expect(yield* Ref.get(box.probes)).toBe(0);
        expect(yield* Ref.get(box.bearers)).toEqual([]);
        expect(yield* box.linkedSessions).toEqual([]);
      }),
    ),
  );

  it.effect("as the other server, refuses peer-link registrations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
        const box = yield* servePeer(descriptorOf("environment-box", "Box"), Layer.empty).pipe(
          Effect.provideContext(server),
        );
        const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: box.url });
        const refused = yield* client.mcpOAuth
          .register({
            payload: {
              client_name: "T3 Code · Laptop",
              redirect_uris: ["http://127.0.0.1/callback"],
              software_id: MCP_PEER_LINK_SOFTWARE_ID,
            },
          })
          .pipe(Effect.flip);
        expect(isRegistrationError(refused)).toBe(true);
        if (isRegistrationError(refused)) {
          expect(refused.error_description).toContain("Linked environments is off");
        }
        expect(yield* box.linkedSessions).toEqual([]);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  );

  it("never configures Tailscale Serve or listens on private networks on its own", () => {
    expect(EarlyscriptRemoteAccess.tailscaleServe(true)).toBe(false);
    expect(EarlyscriptRemoteAccess.serviceListensOnPrivateNetworks).toBe(false);
    expect(
      EarlyscriptRemoteAccess.linkedEnvironmentsEnabled({ linkedEnvironmentsEnabled: true }),
    ).toBe(false);
  });

  it("is what the link service, /mcp, MCP OAuth and the server config read", () => {
    const hook = "Effect.map(EarlyscriptRemoteAccess.linkedEnvironmentsEnabled),";
    for (const file of ["../peer/PeerLinks.ts", "../mcp/McpHttpServer.ts", "../auth/McpOAuth.ts"]) {
      const text = source(file);
      expect(text).toContain(hook);
      expect(text).not.toContain("(settings) => settings.linkedEnvironmentsEnabled");
    }
    const config = source("../cli/config.ts");
    expect(config).toContain(
      "const tailscaleServeEnabled = EarlyscriptRemoteAccess.tailscaleServe(",
    );
    expect(config).toContain("EarlyscriptRemoteAccess.serviceListensOnPrivateNetworks &&");
  });
});
