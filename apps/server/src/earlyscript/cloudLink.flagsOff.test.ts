// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `relay` and `t3Connect` hooks on the link service. The setup file turns
// every flag on for upstream suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer, type HttpClientRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { vi } from "vite-plus/test";

import { EnvironmentId } from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import * as CloudLink from "../cloud/CloudLink.ts";
import * as ConnectReachability from "../cloud/ConnectReachability.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ManagedEndpointRuntime from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as EarlyscriptCloudLink from "./cloudLink.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const source = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");

const LOCAL_ORIGIN = "http://127.0.0.1:3773";
const TUNNEL_CONFIG = {
  providerKind: "cloudflare_tunnel",
  connectorToken: "stored-token",
  tunnelId: "stored-tunnel",
} as const;

// What an earlier T3 Connect link leaves in the secret store.
const persistedLinkSecrets = (): Map<string, Uint8Array> =>
  new Map(
    (
      [
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, JSON.stringify(TUNNEL_CONFIG)],
        [
          CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
          JSON.stringify({
            config: TUNNEL_CONFIG,
            origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
          }),
        ],
        [RELAY_URL_SECRET, "https://relay.example.test"],
        [CLOUD_LINKED_USER_ID, "user-123"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
        [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
        [PUBLISH_AGENT_ACTIVITY_SECRET, "true"],
      ] as const
    ).map(([name, value]) => [name, new TextEncoder().encode(value)] as const),
  );

interface Recorder {
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
  readonly appliedConfigs: Array<unknown>;
}

const makeRecorder = (): Recorder => ({ requests: [], appliedConfigs: [] });

// Everything upstream's link service needs, with stored link secrets, a recording HTTP client and
// a connector runtime that records every config it is asked to run.
const layerLinkDependencies = (recorder: Recorder) => {
  const values = persistedLinkSecrets();
  return Layer.mergeAll(
    Layer.succeed(ServerSecretStore.ServerSecretStore, {
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) => Effect.sync(() => void values.set(name, value)),
      create: (name, value) => Effect.sync(() => void values.set(name, value)),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: (name) => Effect.sync(() => void values.delete(name)),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          recorder.requests.push(request);
          return HttpClientResponse.fromWeb(request, Response.json({ status: "ready" }));
        }),
      ),
    ),
    Layer.succeed(
      ManagedEndpointRuntime.CloudManagedEndpointRuntime,
      ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
        applyConfig: (config) =>
          Effect.sync(() => {
            recorder.appliedConfigs.push(config);
            return config === null
              ? ({ status: "disabled" } as const)
              : ({ status: "running", providerKind: "cloudflare_tunnel", pid: 123 } as const);
          }),
        recoveryRequests: Stream.empty,
        requestRecovery: () => Effect.void,
        tunnelConnected: Stream.empty,
        inspectConnector: Effect.succeed(null),
        readinessChanged: Stream.empty,
        withLinkStateLock: (effect) => effect,
      }),
    ),
    Layer.succeed(
      ConnectReachability.ConnectReachability,
      ConnectReachability.ConnectReachability.of({
        check: Effect.die("unused"),
        latest: Effect.succeedNone,
      }),
    ),
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
    EarlyscriptCloudLink.layerAgentAwarenessRelayDisabled,
    Layer.succeed(
      ServerEnvironment.ServerEnvironment,
      ServerEnvironment.ServerEnvironment.of({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("env_123")),
        getDescriptor: Effect.die("unused"),
      }),
    ),
    Layer.succeed(
      EnvironmentAuth.EnvironmentAuth,
      EnvironmentAuth.EnvironmentAuth.of({} as EnvironmentAuth.EnvironmentAuth["Service"]),
    ),
    Layer.succeed(
      CliTokenManager.CloudCliTokenManager,
      CliTokenManager.CloudCliTokenManager.of({
        get: Effect.die("unused"),
        getExisting: Effect.succeedSome({
          accessToken: "cli-access-token",
          refreshToken: "cli-refresh-token",
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        }),
        hasCredential: Effect.die("unused"),
        store: () => Effect.die("unused"),
        clear: Effect.die("unused"),
      }),
    ),
    ServerConfig.layerTest("/", { prefix: "earlyscript-cloud-link-test-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  );
};

// What the server's startup fiber and shutdown finalizer ask the link service to do.
const startupAndShutdown = Effect.gen(function* () {
  const link = yield* CloudLink.CloudLink;
  const confirmed = yield* link.startManagedTunnelIfOriginConfirmed(LOCAL_ORIGIN);
  const stored = yield* link.startManagedTunnelIfOriginConfirmed(LOCAL_ORIGIN, {
    requireConfirmedOrigin: false,
  });
  const registration = yield* link.registerManagedTunnelRecovery(LOCAL_ORIGIN);
  const recovered = yield* link.recoverManagedTunnel(LOCAL_ORIGIN, TUNNEL_CONFIG);
  const released = yield* link.releaseManagedTunnelOnShutdown();
  return { confirmed, stored, registration: registration.status, recovered, released };
});

const runWith = <E>(layerLink: Layer.Layer<CloudLink.CloudLink, E>) =>
  startupAndShutdown.pipe(Effect.provide(layerLink), Effect.scoped);

describe("Earlyscript link service with the relay and t3Connect flags at their defaults", () => {
  it.effect("upstream's service would start the stored tunnel and call the relay", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const layerUpstream = CloudLink.layer.pipe(Layer.provide(layerLinkDependencies(recorder)));
      // Control case: the same stored secrets wake upstream's service.
      yield* runWith(layerUpstream).pipe(Effect.ignore);
      expect(recorder.appliedConfigs.length).toBeGreaterThan(0);
      expect(recorder.requests.length).toBeGreaterThan(0);
      expect(recorder.requests[0]?.url).toContain("https://relay.example.test/");
    }),
  );

  it.effect("starts no connector and sends no HTTP request from stored link secrets", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const layerServer = EarlyscriptCloudLink.cloudLinkLayer(
        CloudLink.layer.pipe(Layer.provide(layerLinkDependencies(recorder))),
      );
      expect(layerServer).not.toBe(CloudLink.layer);
      const result = yield* runWith(layerServer);
      expect(result).toEqual({
        confirmed: false,
        stored: false,
        registration: "not_linked",
        recovered: false,
        released: false,
      });
      const reconciled = yield* Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        return yield* link.reconcileDesiredLinkIfStillDesired(LOCAL_ORIGIN);
      }).pipe(Effect.provide(layerServer));
      expect(reconciled).toBeNull();
      expect(recorder.requests).toEqual([]);
      expect(recorder.appliedConfigs).toEqual([]);
    }),
  );

  it.effect("publishes no agent activity and wakes no held webhook", () =>
    Effect.gen(function* () {
      expect(EarlyscriptCloudLink.agentAwarenessRelayLayer).toBe(
        EarlyscriptCloudLink.layerAgentAwarenessRelayDisabled,
      );
      expect(EarlyscriptCloudLink.agentAwarenessRelayLayer).not.toBe(AgentAwarenessRelay.layer);
      expect(EarlyscriptCloudLink.heldHooksWakerLayer).toBe(Layer.empty);
      const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
      yield* relay.start();
      yield* relay.requestCatchUp();
      yield* relay.drain;
    }).pipe(Effect.provide(EarlyscriptCloudLink.layerAgentAwarenessRelayDisabled), Effect.scoped),
  );

  it("is what the server provides", () => {
    const server = source("../server.ts");
    expect(server).toContain("EarlyscriptCloudLink.cloudLinkLayer(\n");
    expect(server).toContain("EarlyscriptCloudLink.agentAwarenessRelayLayer,");
    expect(server).toContain("EarlyscriptCloudLink.heldHooksWakerLayer,");
    expect(server).not.toMatch(/^ {2}AgentAwarenessRelay\.layer,$/m);
    expect(server).not.toMatch(/^ {2}HeldHooksWaker\.layer,$/m);
  });
});
