import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Effect from "effect/Effect";
import { constant } from "effect/Function";
import * as Layer from "effect/Layer";

import * as AnalyticsService from "../telemetry/AnalyticsService.ts";

// Without `thirdPartyAnalytics` the PostHog client is never built: no identity read, no flush loop.
const layerDisabled = Layer.succeed(
  AnalyticsService.AnalyticsService,
  AnalyticsService.AnalyticsService.of({
    record: constant(Effect.void),
    flush: Effect.void,
    recordOwners: constant(Effect.void),
  }),
);

export const layer = earlyscriptFlags.thirdPartyAnalytics ? AnalyticsService.layer : layerDisabled;
