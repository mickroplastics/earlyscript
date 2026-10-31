import {
  EDITORIAL_SOURCES_WS_METHODS,
  EditorialSourcesError,
  type EditorialSourcesRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as EditorialSourcesService from "./EditorialSourcesService.ts";

/** Trace and metric aggregate of each Sources method, merged into `RpcInstrumentation`. */
export const EDITORIAL_SOURCES_RPC_AGGREGATES = {
  [EDITORIAL_SOURCES_WS_METHODS.list]: "editorial",
  [EDITORIAL_SOURCES_WS_METHODS.update]: "editorial",
  [EDITORIAL_SOURCES_WS_METHODS.validateFeed]: "editorial",
  [EDITORIAL_SOURCES_WS_METHODS.addFeed]: "editorial",
  [EDITORIAL_SOURCES_WS_METHODS.removeFeed]: "editorial",
  [EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded]: "editorial",
} as const;

type SourcesRpcs = RpcGroup.Rpcs<typeof EditorialSourcesRpcGroup>;

export type EditorialSourcesHandlers = {
  readonly [Current in SourcesRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const unavailable = new EditorialSourcesError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});

/** Spread into the WebSocket group in `ws.ts`; a Reference, as in `resultsRpc.ts`. */
export class EditorialSourcesRpcHandlers extends Context.Reference<EditorialSourcesHandlers>(
  "t3/editorial/EditorialSourcesRpcHandlers",
  {
    defaultValue: () => ({
      [EDITORIAL_SOURCES_WS_METHODS.list]: () => Effect.fail(unavailable),
      [EDITORIAL_SOURCES_WS_METHODS.update]: () => Effect.fail(unavailable),
      [EDITORIAL_SOURCES_WS_METHODS.validateFeed]: () => Effect.fail(unavailable),
      [EDITORIAL_SOURCES_WS_METHODS.addFeed]: () => Effect.fail(unavailable),
      [EDITORIAL_SOURCES_WS_METHODS.removeFeed]: () => Effect.fail(unavailable),
      [EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded]: () => Effect.fail(unavailable),
    }),
  },
) {}

export const makeHandlers = Effect.gen(function* () {
  const sources = yield* EditorialSourcesService.EditorialSourcesService;
  return {
    [EDITORIAL_SOURCES_WS_METHODS.list]: () => sources.list,
    [EDITORIAL_SOURCES_WS_METHODS.update]: sources.update,
    [EDITORIAL_SOURCES_WS_METHODS.validateFeed]: ({ feedUrl }) => sources.validateFeed(feedUrl),
    [EDITORIAL_SOURCES_WS_METHODS.addFeed]: sources.addFeed,
    [EDITORIAL_SOURCES_WS_METHODS.removeFeed]: ({ feedUrl }) => sources.removeFeed(feedUrl),
    [EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded]: sources.setDefaultFeedExcluded,
  } satisfies EditorialSourcesHandlers;
});

/** Mounted once in `server.ts`; publishes the service too, for the capture and run launchers. */
export const layer = Layer.effect(EditorialSourcesRpcHandlers, makeHandlers).pipe(
  Layer.provideMerge(EditorialSourcesService.layer),
);
