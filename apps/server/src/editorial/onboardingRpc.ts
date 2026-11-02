import {
  EDITORIAL_ONBOARDING_WS_METHODS,
  EditorialOnboardingError,
  type EditorialOnboardingRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import * as EditorialOnboardingService from "./EditorialOnboardingService.ts";

/** Trace and metric aggregate of each Onboarding method, merged into `RpcInstrumentation`. */
export const EDITORIAL_ONBOARDING_RPC_AGGREGATES = {
  [EDITORIAL_ONBOARDING_WS_METHODS.record]: "editorial",
  [EDITORIAL_ONBOARDING_WS_METHODS.list]: "editorial",
  [EDITORIAL_ONBOARDING_WS_METHODS.status]: "editorial",
  [EDITORIAL_ONBOARDING_WS_METHODS.complete]: "editorial",
} as const;

type OnboardingRpcs = RpcGroup.Rpcs<typeof EditorialOnboardingRpcGroup>;

export type EditorialOnboardingHandlers = {
  readonly [Current in OnboardingRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const unavailable = new EditorialOnboardingError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});

/** Spread into the WebSocket group in `ws.ts`; a Reference, as in `sourcesRpc.ts`. */
export class EditorialOnboardingRpcHandlers extends Context.Reference<EditorialOnboardingHandlers>(
  "t3/editorial/EditorialOnboardingRpcHandlers",
  {
    defaultValue: () => ({
      [EDITORIAL_ONBOARDING_WS_METHODS.record]: () => Effect.fail(unavailable),
      [EDITORIAL_ONBOARDING_WS_METHODS.list]: () => Effect.fail(unavailable),
      [EDITORIAL_ONBOARDING_WS_METHODS.status]: () => Effect.fail(unavailable),
      [EDITORIAL_ONBOARDING_WS_METHODS.complete]: () => Effect.fail(unavailable),
    }),
  },
) {}

export const makeHandlers = Effect.gen(function* () {
  const onboarding = yield* EditorialOnboardingService.EditorialOnboardingService;
  return {
    [EDITORIAL_ONBOARDING_WS_METHODS.record]: onboarding.record,
    [EDITORIAL_ONBOARDING_WS_METHODS.list]: () => onboarding.list,
    [EDITORIAL_ONBOARDING_WS_METHODS.status]: () => onboarding.status,
    [EDITORIAL_ONBOARDING_WS_METHODS.complete]: () => onboarding.complete,
  } satisfies EditorialOnboardingHandlers;
});

/** Mounted once in `server.ts`, over the editorial storage. */
export const layer = Layer.effect(EditorialOnboardingRpcHandlers, makeHandlers).pipe(
  Layer.provideMerge(EditorialOnboardingService.layer),
);
