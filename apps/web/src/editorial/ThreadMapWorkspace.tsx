import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useVideoThread } from "./videoState";
import { VideoWorkspace } from "./videoWorkspace/VideoWorkspace";

/**
 * Wraps upstream's thread view for an assisted video thread: the steps, the reading panel and
 * the tools around the conversation, which stays mounted as `children`.
 */
export function ThreadMapWorkspace({
  threadRef,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly children: ReactNode;
}) {
  const live = useVideoThread(threadRef);
  return live?.view.video ? (
    <VideoWorkspace
      key={threadRef.threadId}
      threadRef={threadRef}
      video={live.view.video}
      receivedAtMs={live.receivedAtMs}
    >
      {children}
    </VideoWorkspace>
  ) : (
    <div aria-busy>{children}</div>
  );
}
