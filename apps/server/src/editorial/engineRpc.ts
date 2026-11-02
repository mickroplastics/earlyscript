import {
  EDITORIAL_ENGINE_WS_METHODS,
  EditorialEngineError,
  type EditorialEngineRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import * as EditorialEngineService from "./EditorialEngineService.ts";

/** Trace and metric aggregate of each Engine method, merged into `RpcInstrumentation`. */
export const EDITORIAL_ENGINE_RPC_AGGREGATES = {
  [EDITORIAL_ENGINE_WS_METHODS.modelStatus]: "editorial",
  [EDITORIAL_ENGINE_WS_METHODS.prepareModel]: "editorial",
  [EDITORIAL_ENGINE_WS_METHODS.watchModel]: "editorial",
} as const;

type EngineRpcs = RpcGroup.Rpcs<typeof EditorialEngineRpcGroup>;

/** One handler per Engine method; `watchModel` answers a stream, the others an effect. */
export type EditorialEngineHandlers = {
  readonly [Current in EngineRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Rpc.Success<Current> extends Stream.Stream<infer A, infer E, infer _R>
    ? Stream.Stream<A, E | Rpc.Error<Current>>
    : Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const unavailable = new EditorialEngineError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});

/** Spread into the WebSocket group in `ws.ts`; a Reference, as in `jobsRpc.ts`. */
export class EditorialEngineRpcHandlers extends Context.Reference<EditorialEngineHandlers>(
  "t3/editorial/EditorialEngineRpcHandlers",
  {
    defaultValue: () => ({
      [EDITORIAL_ENGINE_WS_METHODS.modelStatus]: () => Effect.fail(unavailable),
      [EDITORIAL_ENGINE_WS_METHODS.prepareModel]: () => Effect.fail(unavailable),
      [EDITORIAL_ENGINE_WS_METHODS.watchModel]: () => Stream.fail(unavailable),
    }),
  },
) {}

const makeHandlers = Effect.gen(function* () {
  const engine = yield* EditorialEngineService.EditorialEngineService;
  return {
    [EDITORIAL_ENGINE_WS_METHODS.modelStatus]: () => engine.modelStatus,
    [EDITORIAL_ENGINE_WS_METHODS.prepareModel]: () => engine.prepareModel,
    [EDITORIAL_ENGINE_WS_METHODS.watchModel]: () => engine.watchModel,
  } satisfies EditorialEngineHandlers;
});

/** Mounted once in `server.ts`, after `EditorialJobsRpc.layer`. */
export const layer = Layer.effect(EditorialEngineRpcHandlers, makeHandlers).pipe(
  Layer.provide(EditorialEngineService.layer),
);
