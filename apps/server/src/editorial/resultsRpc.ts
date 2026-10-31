import {
  EDITORIAL_RESULTS_WS_METHODS,
  EditorialResultsError,
  type EditorialResultsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as EditorialResultsService from "./EditorialResultsService.ts";

/** Trace and metric aggregate of each Results method, merged into `RpcInstrumentation`. */
export const EDITORIAL_RESULTS_RPC_AGGREGATES = {
  [EDITORIAL_RESULTS_WS_METHODS.summary]: "editorial",
  [EDITORIAL_RESULTS_WS_METHODS.decisions]: "editorial",
} as const;

type ResultsRpcs = RpcGroup.Rpcs<typeof EditorialResultsRpcGroup>;

/** One handler per Results method, with its services already provided. */
export type EditorialResultsHandlers = {
  readonly [Current in ResultsRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const unavailable = new EditorialResultsError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});

/**
 * Handlers spread into the WebSocket group in `ws.ts`. A Reference, not a requirement, so
 * `layerWsRpc` keeps its upstream signature; a server built without `layer` (the WS tests
 * with doubles) answers `unavailable`.
 */
export class EditorialResultsRpcHandlers extends Context.Reference<EditorialResultsHandlers>(
  "t3/editorial/EditorialResultsRpcHandlers",
  {
    defaultValue: () => ({
      [EDITORIAL_RESULTS_WS_METHODS.summary]: () => Effect.fail(unavailable),
      [EDITORIAL_RESULTS_WS_METHODS.decisions]: () => Effect.fail(unavailable),
    }),
  },
) {}

const makeHandlers = Effect.gen(function* () {
  const results = yield* EditorialResultsService.EditorialResultsService;
  return {
    [EDITORIAL_RESULTS_WS_METHODS.summary]: () => results.summary,
    [EDITORIAL_RESULTS_WS_METHODS.decisions]: results.decisions,
  } satisfies EditorialResultsHandlers;
});

/** Mounted once in `server.ts`, over the `EditorialSql` that `persistenceLayer.ts` publishes. */
export const layer = Layer.effect(EditorialResultsRpcHandlers, makeHandlers).pipe(
  Layer.provide(EditorialResultsService.layer),
);
