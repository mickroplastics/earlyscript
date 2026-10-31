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
import { AsyncResult } from "effect/reactivity";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";

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
  saveResult: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:video-save-result",
    tag: EDITORIAL_VIDEO_WS_METHODS.saveResult,
  }),
};

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
