import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as CloudHttp from "../cloud/http.ts";
import { t3ConnectEnabled } from "./t3Connect.ts";

const notFound = () => Effect.succeed(HttpServerResponse.empty({ status: 404 }));

/** Every `/api/connect/*` and `/api/t3-connect/*` route answers 404 without reading its payload. */
export const layerConnectHttpDisabled = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  (handlers) =>
    handlers
      .handleRaw("linkProof", notFound)
      .handleRaw("relayConfig", notFound)
      .handleRaw("linkState", notFound)
      .handleRaw("checkReachability", notFound)
      .handleRaw("unlink", notFound)
      .handleRaw("preferences", notFound)
      .handleRaw("health", notFound)
      .handleRaw("t3MintCredential", notFound),
);

/** Without `t3Connect` nothing can link this server to T3 Connect or push it a relay config. */
export const layerConnectHttp = t3ConnectEnabled ? CloudHttp.layer : layerConnectHttpDisabled;
