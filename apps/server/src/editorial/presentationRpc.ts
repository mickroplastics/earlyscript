import {
  EDITORIAL_PRESENTATION_WS_METHODS,
  EditorialPresentationError,
  type EditorialPresentationRpcGroup,
  type EditorialPresentationRunInput,
  type EditorialPresentationTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import {
  EditorialPresentationService,
  type EditorialPresentationServiceShape,
} from "./EditorialPresentationService.ts";

/** Trace and metric aggregate of each method, merged into `RpcInstrumentation`. */
export const EDITORIAL_PRESENTATION_RPC_AGGREGATES = {
  [EDITORIAL_PRESENTATION_WS_METHODS.ensure]: "editorial",
  [EDITORIAL_PRESENTATION_WS_METHODS.regenerate]: "editorial",
  [EDITORIAL_PRESENTATION_WS_METHODS.ensureRun]: "editorial",
  [EDITORIAL_PRESENTATION_WS_METHODS.getRunProgress]: "editorial",
} as const;

const unavailable = Effect.fail(
  new EditorialPresentationError({
    reason: "unavailable",
    message: "Trend presentations are not available on this server.",
  }),
);

/**
 * Handlers for `EditorialPresentationRpcGroup`, spread into the WebSocket handlers in
 * `ws.ts`. The service is optional there, so the upstream WebSocket layer and its test
 * doubles gain no requirement; without it every method answers `unavailable`.
 */
export const makeHandlers = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(EditorialPresentationService);
  const call = <A>(
    use: (
      presentations: EditorialPresentationServiceShape,
    ) => Effect.Effect<A, EditorialPresentationError>,
  ) => (Option.isSome(service) ? use(service.value) : unavailable);
  return {
    [EDITORIAL_PRESENTATION_WS_METHODS.ensure]: (target: EditorialPresentationTarget) =>
      call((presentations) => presentations.ensure(target)),
    [EDITORIAL_PRESENTATION_WS_METHODS.regenerate]: (target: EditorialPresentationTarget) =>
      call((presentations) => presentations.regenerate(target)),
    [EDITORIAL_PRESENTATION_WS_METHODS.ensureRun]: ({ runId }: EditorialPresentationRunInput) =>
      call((presentations) => presentations.startRun(runId)),
    [EDITORIAL_PRESENTATION_WS_METHODS.getRunProgress]: ({
      runId,
    }: EditorialPresentationRunInput) => call((presentations) => presentations.runProgress(runId)),
  } satisfies Record<RpcGroup.Rpcs<typeof EditorialPresentationRpcGroup>["_tag"], unknown>;
});
