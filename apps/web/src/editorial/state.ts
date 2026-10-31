import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_WS_METHODS,
  type EditorialInbox,
  type EditorialStreamItem,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

/** Bumped after an inbox command succeeds, so open inbox and dossier reads refetch. */
const inboxRevision = Atom.family((_environmentId: EnvironmentId) => Atom.make(0));

export const bumpInbox = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.update(inboxRevision(environmentId), (value) => value + 1));

/** The inbox as the subscription last left it, with the sequence it reflects. */
export interface EditorialInboxView {
  readonly seq: number;
  readonly inbox: EditorialInbox | null;
}

export const EMPTY_INBOX_VIEW: EditorialInboxView = { seq: 0, inbox: null };

/**
 * Folds one subscription item into the view. A snapshot replaces it; a trend item replaces
 * that trend's state in place, without reordering rows the operator may be reading.
 */
export function applyEditorialStreamItem(
  view: EditorialInboxView,
  item: EditorialStreamItem,
): EditorialInboxView {
  if (item._tag === "snapshot") return { seq: item.seq, inbox: item.inbox };
  const seq = Math.max(view.seq, item.seq);
  if (view.inbox === null) return { seq, inbox: null };
  const trends = view.inbox.trends.map((trend) =>
    trend.trendKey === item.trendKey
      ? { ...trend, isNew: item.state.isNew, inbox: item.state }
      : trend,
  );
  return {
    seq,
    inbox: {
      ...view.inbox,
      trends,
      newCount: item.newCount,
      snoozedCount: trends.filter((trend) => trend.inbox?.snoozed != null).length,
      dismissedCount: trends.filter((trend) => trend.inbox?.dismissed != null).length,
    },
  };
}

/**
 * The inbox read with each trend's state as the subscription last left it. The read keeps
 * what the subscription does not carry (titles drafted after it started); the subscription
 * keeps the states current. A view of another run leaves the read as it is.
 */
export function withLiveInboxState(
  inbox: EditorialInbox,
  live: EditorialInbox | null,
): EditorialInbox {
  if (live === null || live.run?.runId !== inbox.run?.runId) return inbox;
  const liveByKey = new Map(live.trends.map((trend) => [trend.trendKey, trend]));
  return {
    ...inbox,
    trends: inbox.trends.map((trend) => {
      const current = trend.trendKey === undefined ? undefined : liveByKey.get(trend.trendKey);
      return current?.inbox === undefined
        ? trend
        : { ...trend, isNew: current.isNew, inbox: current.inbox };
    }),
    newCount: live.newCount,
    snoozedCount: live.snoozedCount,
    dismissedCount: live.dismissedCount,
  };
}

/**
 * Editorial reads, the live inbox and the human inbox commands, per environment. The
 * server takes the actor from the session; commands carry only what the operator chose.
 */
export const editorialEnvironment = {
  /** The server imports a new run before answering, so a refetch shows it. */
  inbox: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:inbox",
    tag: EDITORIAL_WS_METHODS.getInbox,
    staleTimeMs: 60_000,
    refreshTrigger: (target) => inboxRevision(target.environmentId),
  }),
  dossier: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:dossier",
    tag: EDITORIAL_WS_METHODS.getDossier,
    staleTimeMs: 5 * 60_000,
    refreshTrigger: (target) => inboxRevision(target.environmentId),
  }),
  /** Snapshot, then deltas; a reconnect starts again from a snapshot. */
  liveInbox: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:live-inbox",
    tag: EDITORIAL_WS_METHODS.subscribe,
    transform: (stream) =>
      stream.pipe(Stream.scan(() => EMPTY_INBOX_VIEW, applyEditorialStreamItem)),
  }),
  /**
   * Opening a dossier confirms it read on the server. No refetch: the subscription updates the
   * row in place, so the trend just opened keeps its place in the list, as a visited thread does.
   */
  markRead: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:mark-read",
    tag: EDITORIAL_WS_METHODS.markRead,
  }),
  /** "Seguir observando": without `until` or `returnWhen` the server applies its growth default. */
  snooze: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:snooze",
    tag: EDITORIAL_WS_METHODS.snooze,
    onSuccess: bumpInbox,
  }),
  unsnooze: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:unsnooze",
    tag: EDITORIAL_WS_METHODS.unsnooze,
    onSuccess: bumpInbox,
  }),
  /** "Descartar" needs a reason; reopening keeps it in the history. */
  dismiss: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:dismiss",
    tag: EDITORIAL_WS_METHODS.dismiss,
    onSuccess: bumpInbox,
  }),
  reopen: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:reopen",
    tag: EDITORIAL_WS_METHODS.reopen,
    onSuccess: bumpInbox,
  }),
  /** "Crear hilo de video": answers with the trend's thread when it already has one. */
  createVideo: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:create-video",
    tag: EDITORIAL_WS_METHODS.createVideo,
    onSuccess: bumpInbox,
  }),
};
