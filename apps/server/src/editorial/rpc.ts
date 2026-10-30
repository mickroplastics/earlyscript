import { EDITORIAL_WS_METHODS, type EditorialRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import { EditorialReadService } from "./EditorialReadService.ts";

/** Trace and metric aggregate of each editorial method, merged into `RpcInstrumentation`. */
export const EDITORIAL_RPC_AGGREGATES = {
  [EDITORIAL_WS_METHODS.listRuns]: "editorial",
  [EDITORIAL_WS_METHODS.getInbox]: "editorial",
  [EDITORIAL_WS_METHODS.getDossier]: "editorial",
} as const;

/** Handlers for `EditorialRpcGroup`, spread into the WebSocket group's handlers in `ws.ts`. */
export const makeHandlers = Effect.gen(function* () {
  const read = yield* EditorialReadService;
  return {
    [EDITORIAL_WS_METHODS.listRuns]: () => read.listRuns.pipe(Effect.map((runs) => ({ runs }))),
    [EDITORIAL_WS_METHODS.getInbox]: read.getInbox,
    [EDITORIAL_WS_METHODS.getDossier]: read.getDossier,
  } satisfies Record<RpcGroup.Rpcs<typeof EditorialRpcGroup>["_tag"], unknown>;
});
