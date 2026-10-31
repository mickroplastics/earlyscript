import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_VIDEO_WS_METHODS,
  type EditorialVideoView,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { Atom, AsyncResult } from "effect/reactivity";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

/** Stands in for the subscription of a route with no server thread. */
const NO_VIDEO_VIEW_ATOM = Atom.make(AsyncResult.initial<LiveVideoView, never>());

/** The server's view with the client time it arrived, which the clock interpolates from. */
export interface LiveVideoView {
  readonly view: EditorialVideoView;
  readonly receivedAtMs: number;
}

/**
 * The editorial side of a thread, per environment. One subscription per open thread, shared by
 * the header clock and the details sections; a reconnect subscribes again and starts from a
 * fresh view, so the clock never runs on a stale summary. Commands answer with the new state,
 * and the subscription delivers it too.
 */
export const editorialVideoEnvironment = {
  live: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:video",
    tag: EDITORIAL_VIDEO_WS_METHODS.subscribe,
    transform: (stream) =>
      stream.pipe(
        Stream.mapEffect((view) =>
          Clock.currentTimeMillis.pipe(Effect.map((receivedAtMs) => ({ view, receivedAtMs }))),
        ),
      ),
  }),
  clock: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-clock",
    tag: EDITORIAL_VIDEO_WS_METHODS.clock,
  }),
  saveScript: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-save-script",
    tag: EDITORIAL_VIDEO_WS_METHODS.saveScript,
  }),
  decide: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-decide",
    tag: EDITORIAL_VIDEO_WS_METHODS.decide,
  }),
  openVersion: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-open-version",
    tag: EDITORIAL_VIDEO_WS_METHODS.openVersion,
  }),
  saveResult: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-save-result",
    tag: EDITORIAL_VIDEO_WS_METHODS.saveResult,
  }),
  createManual: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-create-manual",
    tag: EDITORIAL_VIDEO_WS_METHODS.createManual,
  }),
  capture: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-capture",
    tag: EDITORIAL_VIDEO_WS_METHODS.capture,
  }),
  removeCapture: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-remove-capture",
    tag: EDITORIAL_VIDEO_WS_METHODS.removeCapture,
  }),
};

/**
 * Whether a thread is a manual video thread: `unknown` until the server's first view arrives,
 * so the route never shows a composer for a moment before it learns there is no chat. A
 * failed read counts as not manual: the server refuses agent work in a manual thread anyway.
 */
export type VideoThreadModeState = "unknown" | "manual" | "other";

export function useVideoThreadMode(threadRef: ScopedThreadRef | null): VideoThreadModeState {
  const result = useAtomValue(
    threadRef === null
      ? NO_VIDEO_VIEW_ATOM
      : editorialVideoEnvironment.live({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  if (threadRef === null) return "other";
  const live = AsyncResult.getOrElse(result, () => null);
  // A view of another thread, kept while the next one loads, says nothing about this one.
  if (live !== null && live.view.threadId === threadRef.threadId) {
    return live.view.video?.thread.mode === "manual" ? "manual" : "other";
  }
  return AsyncResult.isFailure(result) ? "other" : "unknown";
}

/** Null until the first view arrives, on failure, and for a thread with no editorial side. */
export function useVideoThread(threadRef: ScopedThreadRef): LiveVideoView | null {
  const result = useAtomValue(
    editorialVideoEnvironment.live({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const live = AsyncResult.getOrElse(result, () => null);
  return live?.view.video ? live : null;
}
