import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Effect from "effect/Effect";
import { constant } from "effect/Function";
import * as Layer from "effect/Layer";

import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as Identify from "../telemetry/Identify.ts";

// Without `thirdPartyAnalytics` the PostHog client is never built: no identity read, no flush loop.
export const layerDisabled = Layer.succeed(
  AnalyticsService.AnalyticsService,
  AnalyticsService.AnalyticsService.of({
    record: constant(Effect.void),
    flush: Effect.void,
    recordOwners: constant(Effect.void),
  }),
);

export const layer = earlyscriptFlags.thirdPartyAnalytics ? AnalyticsService.layer : layerDisabled;

/** Startup owners for analytics; without `thirdPartyAnalytics` no provider login or Connect account is read. */
export const noServerOwners = Effect.succeed<ReadonlyArray<Identify.TelemetryOwner>>([]);

export const getServerOwners = earlyscriptFlags.thirdPartyAnalytics
  ? Identify.getServerOwners
  : noServerOwners;
