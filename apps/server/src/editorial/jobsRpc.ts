import {
  EDITORIAL_JOBS_WS_METHODS,
  EditorialJobsError,
  type EditorialJobsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as EditorialJobsService from "./EditorialJobsService.ts";
import * as EditorialPresentation from "./EditorialPresentationService.ts";
import * as EditorialScheduler from "./EditorialScheduler.ts";

/** Trace and metric aggregate of each Jobs method, merged into `RpcInstrumentation`. */
export const EDITORIAL_JOBS_RPC_AGGREGATES = {
  [EDITORIAL_JOBS_WS_METHODS.list]: "editorial",
  [EDITORIAL_JOBS_WS_METHODS.runNow]: "editorial",
  [EDITORIAL_JOBS_WS_METHODS.getSettings]: "editorial",
  [EDITORIAL_JOBS_WS_METHODS.updateSettings]: "editorial",
  [EDITORIAL_JOBS_WS_METHODS.watch]: "editorial",
} as const;

type JobsRpcs = RpcGroup.Rpcs<typeof EditorialJobsRpcGroup>;

/** One handler per Jobs method; `watch` answers a stream, the others an effect. */
export type EditorialJobsHandlers = {
  readonly [Current in JobsRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Rpc.Success<Current> extends Stream.Stream<infer A, infer E, infer _R>
    ? Stream.Stream<A, E | Rpc.Error<Current>>
    : Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const unavailable = new EditorialJobsError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});

/** Spread into the WebSocket group in `ws.ts`; a Reference, as in `resultsRpc.ts`. */
export class EditorialJobsRpcHandlers extends Context.Reference<EditorialJobsHandlers>(
  "t3/editorial/EditorialJobsRpcHandlers",
  {
    defaultValue: () => ({
      [EDITORIAL_JOBS_WS_METHODS.list]: () => Effect.fail(unavailable),
      [EDITORIAL_JOBS_WS_METHODS.runNow]: () => Effect.fail(unavailable),
      [EDITORIAL_JOBS_WS_METHODS.getSettings]: () => Effect.fail(unavailable),
      [EDITORIAL_JOBS_WS_METHODS.updateSettings]: () => Effect.fail(unavailable),
      [EDITORIAL_JOBS_WS_METHODS.watch]: () => Stream.fail(unavailable),
    }),
  },
) {}

const makeHandlers = Effect.gen(function* () {
  const jobs = yield* EditorialJobsService.EditorialJobsService;
  return {
    [EDITORIAL_JOBS_WS_METHODS.list]: () => jobs.list,
    [EDITORIAL_JOBS_WS_METHODS.runNow]: () => jobs.runNow,
    [EDITORIAL_JOBS_WS_METHODS.getSettings]: () => jobs.getSettings,
    [EDITORIAL_JOBS_WS_METHODS.updateSettings]: jobs.updateSettings,
    [EDITORIAL_JOBS_WS_METHODS.watch]: () => jobs.watch,
  } satisfies EditorialJobsHandlers;
});

/**
 * Mounted once in `server.ts`, beside `EditorialPresentationService.layer`, whose instance it
 * shares (layers are memoized); the Scheduler is the one the orchestration runtime builds.
 */
export const layer = Layer.merge(
  Layer.effect(EditorialJobsRpcHandlers, makeHandlers),
  EditorialScheduler.layer,
).pipe(
  Layer.provide(EditorialJobsService.layer),
  Layer.provide(Layer.merge(EditorialPresentation.layer, Scheduler.layer)),
);
