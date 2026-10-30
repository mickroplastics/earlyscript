// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hook is wired.
// Earlyscript-only: the `telemetry` hook on the browser trace upload route. The setup file turns
// every flag on for upstream suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vite-plus/test";

import * as ServerHttp from "../http.ts";
import * as EarlyscriptObservability from "./observability.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

describe("Earlyscript observability with the telemetry flag at its default", () => {
  it("does not register POST /api/observability/v1/traces", async () => {
    expect(EarlyscriptObservability.layerOtlpTracesProxyRoute).not.toBe(
      ServerHttp.layerOtlpTracesProxyRoute,
    );
    expect(EarlyscriptObservability.layerOtlpTracesProxyRoute).toBe(
      EarlyscriptObservability.layerOtlpTracesProxyRouteDisabled,
    );
    const layerProbe = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/probe", HttpServerResponse.empty({ status: 204 }));
      }),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.merge(layerProbe, EarlyscriptObservability.layerOtlpTracesProxyRouteDisabled),
      { disableLogger: true },
    );
    try {
      const probe = await handler(new Request("http://server.test/probe"));
      expect(probe.status).toBe(204);
      const traces = await handler(
        new Request("http://server.test/api/observability/v1/traces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(traces.status).toBe(404);
    } finally {
      await dispose();
    }
  });

  it("is what the server routes use", () => {
    const server = NodeFS.readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    expect(server).toContain("EarlyscriptObservability.layerOtlpTracesProxyRoute,");
    expect(server).not.toContain("ServerHttp.layerOtlpTracesProxyRoute");
  });
});
