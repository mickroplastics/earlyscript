import {
  EDITORIAL_WS_METHODS,
  EditorialCommandError,
  EditorialReadError,
  type EditorialRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialInboxCommands, type EditorialSession } from "./EditorialInboxCommands.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { subscribeInbox } from "./inboxStream.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";

/** Trace and metric aggregate of each editorial method, merged into `RpcInstrumentation`. */
export const EDITORIAL_RPC_AGGREGATES = {
  [EDITORIAL_WS_METHODS.listRuns]: "editorial",
  [EDITORIAL_WS_METHODS.getInbox]: "editorial",
  [EDITORIAL_WS_METHODS.getDossier]: "editorial",
  [EDITORIAL_WS_METHODS.subscribe]: "editorial",
  [EDITORIAL_WS_METHODS.markRead]: "editorial",
  [EDITORIAL_WS_METHODS.snooze]: "editorial",
  [EDITORIAL_WS_METHODS.unsnooze]: "editorial",
  [EDITORIAL_WS_METHODS.dismiss]: "editorial",
  [EDITORIAL_WS_METHODS.reopen]: "editorial",
} as const;

type EditorialRpcs = RpcGroup.Rpcs<typeof EditorialRpcGroup>;

/** One handler per editorial method, with every service already provided. */
export type EditorialHandlers = {
  readonly [Current in EditorialRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Rpc.Success<Current> extends Stream.Stream<infer A, infer E, infer _R>
    ? Stream.Stream<A, E | Rpc.Error<Current>>
    : Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const unavailableRead = new EditorialReadError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});
const unavailableCommand = new EditorialCommandError({
  reason: "unavailable",
  message: "The editorial services are not mounted on this server.",
});

/** What a server without `editorial/layer.ts` answers, e.g. the WS tests built with doubles. */
const unavailableHandlers: EditorialHandlers = {
  [EDITORIAL_WS_METHODS.listRuns]: () => Effect.fail(unavailableRead),
  [EDITORIAL_WS_METHODS.getInbox]: () => Effect.fail(unavailableRead),
  [EDITORIAL_WS_METHODS.getDossier]: () => Effect.fail(unavailableRead),
  [EDITORIAL_WS_METHODS.subscribe]: () => Stream.fail(unavailableRead),
  [EDITORIAL_WS_METHODS.markRead]: () => Effect.fail(unavailableCommand),
  [EDITORIAL_WS_METHODS.snooze]: () => Effect.fail(unavailableCommand),
  [EDITORIAL_WS_METHODS.unsnooze]: () => Effect.fail(unavailableCommand),
  [EDITORIAL_WS_METHODS.dismiss]: () => Effect.fail(unavailableCommand),
  [EDITORIAL_WS_METHODS.reopen]: () => Effect.fail(unavailableCommand),
};

/**
 * Handlers for `EditorialRpcGroup`, built once with the server's editorial services and bound
 * to each WebSocket session in `ws.ts`. A Reference, not a requirement, so `layerWsRpc`
 * keeps its upstream signature.
 */
export class EditorialRpcHandlers extends Context.Reference<{
  readonly forSession: (session: EditorialSession) => EditorialHandlers;
}>("t3/editorial/EditorialRpcHandlers", {
  defaultValue: () => ({ forSession: () => unavailableHandlers }),
}) {}

const makeHandlers = Effect.gen(function* () {
  const read = yield* EditorialReadService;
  const importer = yield* EditorialImportService;
  const inbox = yield* EditorialInboxCommands;
  const streamContext = yield* Effect.context<EditorialEventLog | EditorialReadService>();

  // A person opening the inbox should see a run written a moment ago, not wait for the poll.
  const imported = importer.sync.pipe(
    Effect.catch((cause) => Effect.logWarning("editorial: import before read failed", { cause })),
  );

  return (session: EditorialSession): EditorialHandlers => ({
    [EDITORIAL_WS_METHODS.listRuns]: () =>
      imported.pipe(
        Effect.andThen(read.listRuns),
        Effect.map((runs) => ({ runs })),
      ),
    [EDITORIAL_WS_METHODS.getInbox]: (input) => imported.pipe(Effect.andThen(read.getInbox(input))),
    [EDITORIAL_WS_METHODS.getDossier]: read.getDossier,
    [EDITORIAL_WS_METHODS.subscribe]: (input) =>
      Stream.unwrap(
        imported.pipe(Effect.andThen(subscribeInbox(input)), Effect.provide(streamContext)),
      ),
    [EDITORIAL_WS_METHODS.markRead]: (input) => inbox.markRead(session, input),
    [EDITORIAL_WS_METHODS.snooze]: (input) => inbox.snooze(session, input),
    [EDITORIAL_WS_METHODS.unsnooze]: (input) => inbox.unsnooze(session, input),
    [EDITORIAL_WS_METHODS.dismiss]: (input) => inbox.dismiss(session, input),
    [EDITORIAL_WS_METHODS.reopen]: (input) => inbox.reopen(session, input),
  });
});

export const layerHandlers = Layer.effect(
  EditorialRpcHandlers,
  makeHandlers.pipe(Effect.map((forSession) => ({ forSession }))),
);
