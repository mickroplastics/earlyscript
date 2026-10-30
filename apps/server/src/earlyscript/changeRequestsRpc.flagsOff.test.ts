// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `changeRequests` hooks on the pull request RPCs and HTTP route, with
// `sourceControlHosts` on, so only `changeRequests` stands between a client and the host.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  GitManagerError,
  PullRequestUnavailableError,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { vi } from "vite-plus/test";

import * as EarlyscriptChangeRequests from "./changeRequests.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return {
    ...actual,
    earlyscriptFlags: actual.readEarlyscriptFlags({ EARLYSCRIPT_FLAG_SOURCE_CONTROL_HOSTS: "1" }),
  };
});

const source = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");
const isPullRequestUnavailable = Schema.is(PullRequestUnavailableError);
const isGitManagerError = Schema.is(GitManagerError);

const PULL_REQUEST_METHODS = Object.values(WS_METHODS).filter((method) =>
  method.startsWith("pullRequests."),
);

class PullRequestTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.pullRequests,
) {}

// Lets every request through, as a signed-in session would be.
const layerSignedIn = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  httpEffect.pipe(
    Effect.provideService(
      EnvironmentAuthenticatedPrincipal,
      {} as EnvironmentAuthenticatedPrincipal["Service"],
    ),
  ),
);

describe("Earlyscript change requests with changeRequests off and sourceControlHosts on", () => {
  it.effect("answers every pull request RPC without calling the upstream handler", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const upstream = Object.fromEntries(
        Object.values(WS_METHODS).map((method) => [
          method,
          () => {
            calls.push(method);
            return Effect.succeed("upstream");
          },
        ]),
      ) as Record<string, (input: unknown) => unknown>;
      const handlers = EarlyscriptChangeRequests.wsHandlers(upstream);

      expect(PULL_REQUEST_METHODS.length).toBeGreaterThan(30);
      for (const method of PULL_REQUEST_METHODS) {
        const answer = handlers[method]!({});
        if (method === WS_METHODS.pullRequestsSubscribeRefreshes) {
          expect(yield* Stream.runCollect(answer as Stream.Stream<number>)).toEqual([]);
          continue;
        }
        const error = yield* Effect.flip(
          answer as Effect.Effect<never, PullRequestUnavailableError>,
        );
        expect(isPullRequestUnavailable(error)).toBe(true);
        expect(error.message).toBe(
          "Change requests cannot be browsed for this project's host yet.",
        );
      }
      for (const method of [
        WS_METHODS.gitResolvePullRequest,
        WS_METHODS.gitPreparePullRequestThread,
      ]) {
        const error = yield* Effect.flip(
          handlers[method]!({ cwd: "/repo" }) as Effect.Effect<never, GitManagerError>,
        );
        expect(isGitManagerError(error)).toBe(true);
        expect(error.detail).toBe(EarlyscriptChangeRequests.CHANGE_REQUESTS_DISABLED_MESSAGE);
      }
      expect(calls).toEqual([]);
      // Everything else is upstream's.
      const status = handlers[WS_METHODS.gitRunStackedAction]!({}) as Effect.Effect<string>;
      expect(yield* status).toBe("upstream");
      expect(calls).toEqual([WS_METHODS.gitRunStackedAction]);
    }),
  );

  it("answers POST /api/pull-requests/diff with 503 unavailable", async () => {
    expect(EarlyscriptChangeRequests.layerPullRequestHttp).toBe(
      EarlyscriptChangeRequests.layerPullRequestHttpDisabled,
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      HttpApiBuilder.layer(PullRequestTestApi).pipe(
        Layer.provide(EarlyscriptChangeRequests.layerPullRequestHttpDisabled),
        Layer.provide(layerSignedIn),
        Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
        Layer.provide(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    try {
      const response = await handler(
        new Request("http://server.test/api/pull-requests/diff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: "project-a", repository: "owner/repo", number: 7 }),
        }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        _tag: "PullRequestUnavailableError",
        requirement: EarlyscriptChangeRequests.CHANGE_REQUESTS_DISABLED_MESSAGE,
      });
    } finally {
      await dispose();
    }
  });

  it("is what the WebSocket server and the HTTP routes use", () => {
    const ws = source("../ws.ts");
    expect(ws).toContain(
      "const handlers = EarlyscriptChangeRequests.wsHandlers(upstreamHandlers);",
    );
    const server = source("../server.ts");
    expect(server).toContain("Layer.provide(EarlyscriptChangeRequests.layerPullRequestHttp),");
    expect(server).not.toContain("PullRequestHttp.layer");
  });
});
