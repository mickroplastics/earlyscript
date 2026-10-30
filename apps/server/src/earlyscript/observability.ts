import { earlyscriptFlags } from "@t3tools/shared/earlyscriptFlags";
import * as Layer from "effect/Layer";

import * as ServerHttp from "../http.ts";

export const layerOtlpTracesProxyRouteDisabled = Layer.empty;

/** Without `telemetry` the browser trace upload route `/api/observability/v1/traces` is not registered. */
export const layerOtlpTracesProxyRoute = earlyscriptFlags.telemetry
  ? ServerHttp.layerOtlpTracesProxyRoute
  : layerOtlpTracesProxyRouteDisabled;
