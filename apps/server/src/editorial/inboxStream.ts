import {
  EditorialReadError,
  EditorialTrendKey,
  type EditorialStreamItem,
  type EditorialSubscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { EditorialReadService } from "./EditorialReadService.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import type { EditorialEvent } from "./persistence/EditorialModel.ts";

/** Reconnects missing more events than this get a new snapshot instead of a replay. */
export const SUBSCRIBE_MAX_REPLAY = 500;

const unreadable = (cause: { readonly message: string }) =>
  new EditorialReadError({ reason: "unreadable", message: cause.message });

/**
 * Snapshot with its sequence, then one item per trend event and a new snapshot per run
 * import. `since` replays the gap, or snapshots when it is too large, has a run import or is
 * ahead of the log. Subscribed before any read, so no commit is lost; items are idempotent.
 */
export const subscribeInbox = Effect.fn("EditorialInbox.subscribe")(function* (
  input: EditorialSubscribeInput,
) {
  const log = yield* EditorialEventLog;
  const read = yield* EditorialReadService;
  const subscription = yield* log.subscribe;
  const sort = input.sort ?? "new-first-growth";

  const snapshot = Effect.gen(function* () {
    const seq = yield* log.latestSeq.pipe(Effect.mapError(unreadable));
    const inbox = yield* read.getInbox({ sort });
    return { _tag: "snapshot", seq, inbox } satisfies EditorialStreamItem;
  });

  const trendItem = (trendKey: string, seq: number) =>
    read.getTrendState(trendKey).pipe(
      Effect.map(
        ({ state, newCount }) =>
          ({
            _tag: "trend",
            seq,
            trendKey: EditorialTrendKey.make(trendKey),
            state,
            newCount,
          }) satisfies EditorialStreamItem,
      ),
    );

  const toItems = (
    event: EditorialEvent,
  ): Effect.Effect<ReadonlyArray<EditorialStreamItem>, EditorialReadError> => {
    switch (event.aggregateKind) {
      case "run":
        return snapshot.pipe(Effect.map((item) => [item]));
      case "trend":
        return trendItem(event.aggregateId, event.seq).pipe(Effect.map((item) => [item]));
      default:
        return Effect.succeed([]);
    }
  };

  const highWater = yield* log.latestSeq.pipe(Effect.mapError(unreadable));
  const since = input.since;
  const replayable =
    since !== undefined && since <= highWater && highWater - since <= SUBSCRIBE_MAX_REPLAY;
  const missed = replayable
    ? (yield* log.readSince(since, SUBSCRIBE_MAX_REPLAY).pipe(Effect.mapError(unreadable))).filter(
        (event) => event.seq <= highWater,
      )
    : [];

  let initial: ReadonlyArray<EditorialStreamItem>;
  let tailFrom: number;
  if (!replayable || missed.some((event) => event.aggregateKind === "run")) {
    const first = yield* snapshot;
    initial = [first];
    tailFrom = first.seq;
  } else {
    // One item per trend, at the last sequence that touched it.
    const lastSeqByTrend = new Map<string, number>();
    for (const event of missed) {
      if (event.aggregateKind === "trend") lastSeqByTrend.set(event.aggregateId, event.seq);
    }
    initial = yield* Effect.forEach(
      [...lastSeqByTrend].toSorted((a, b) => a[1] - b[1]),
      ([trendKey, seq]) => trendItem(trendKey, seq),
    );
    tailFrom = highWater;
  }

  const live = Stream.fromSubscription(subscription).pipe(
    Stream.filter((event) => event.seq > tailFrom),
    Stream.mapEffect(toItems),
    Stream.flatMap(Stream.fromIterable),
  );
  return Stream.concat(Stream.fromIterable(initial), live);
});
