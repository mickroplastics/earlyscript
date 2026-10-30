// @effect-diagnostics nodeBuiltinImport:off - reads upstream sources to check the hooks are wired.
// Earlyscript-only: the `thirdPartyAnalytics` hooks. The setup file turns every flag on for
// upstream suites, so this file replaces the flags with their real defaults.
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as Identify from "../telemetry/Identify.ts";
import * as EarlyscriptAnalytics from "./analytics.ts";

vi.mock("@t3tools/shared/earlyscriptFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/earlyscriptFlags")>();
  return { ...actual, earlyscriptFlags: actual.readEarlyscriptFlags({}) };
});

const source = (file: string) => NodeFS.readFileSync(new URL(file, import.meta.url), "utf8");

describe("Earlyscript analytics with the thirdPartyAnalytics flag at its default", () => {
  it.effect("never builds the PostHog layer and serves a no-op service without dependencies", () =>
    Effect.gen(function* () {
      expect(EarlyscriptAnalytics.layer).not.toBe(AnalyticsService.layer);
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("server.boot.heartbeat", {});
      yield* analytics.recordOwners([], "server");
      yield* analytics.flush;
    }).pipe(Effect.provide(EarlyscriptAnalytics.layer)),
  );

  it.effect("reads no provider login or Connect account for startup owners", () =>
    Effect.gen(function* () {
      expect(EarlyscriptAnalytics.getServerOwners).not.toBe(Identify.getServerOwners);
      // Upstream's reader needs the home directory and secret store; this one needs nothing.
      const owners = yield* EarlyscriptAnalytics.getServerOwners as Effect.Effect<
        ReadonlyArray<Identify.TelemetryOwner>
      >;
      expect(owners).toEqual([]);
    }),
  );

  it("is what the server and its startup use", () => {
    const server = source("../server.ts");
    expect(server).toContain("Layer.provideMerge(EarlyscriptAnalytics.layer)");
    expect(server).not.toContain("AnalyticsService.layer");
    const startup = source("../serverRuntimeStartup.ts");
    expect(startup).toContain('import { getServerOwners } from "./earlyscript/analytics.ts";');
    expect(startup).not.toContain('from "./telemetry/Identify.ts"');
  });
});
