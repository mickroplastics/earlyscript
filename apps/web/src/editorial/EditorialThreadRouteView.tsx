import { ThreadRouteView } from "../components/ThreadRouteView";
import { SidebarInset } from "../components/ui/sidebar";
import type { ThreadRouteTarget } from "../threadRoutes";
import { DeletedManualThread } from "./ManualThreadData";
import { ManualVideoWorkspace } from "./ManualVideoWorkspace";
import { useVideoThreadMode } from "./videoState";

/**
 * Wraps upstream's thread route from `_chat.tsx`: a manual video thread gets the manual
 * workspace in ChatView's place. Until the kind is known the upstream view stays mounted but
 * hidden and inert, so no composer flashes and an ordinary thread keeps its single ChatView.
 * A deleted manual thread, reached by URL, shows what remains of it instead of the workspace.
 */
export function EditorialThreadRouteView({
  target,
  background,
}: {
  readonly target: ThreadRouteTarget;
  readonly background: boolean;
}) {
  const threadRef = target.kind === "server" ? target.threadRef : null;
  const mode = useVideoThreadMode(threadRef);
  if ((mode === "manual" || mode === "manual-deleted") && threadRef !== null) {
    return (
      <SidebarInset
        className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
        inert={background}
      >
        {mode === "manual" ? (
          <ManualVideoWorkspace threadRef={threadRef} />
        ) : (
          <DeletedManualThread threadRef={threadRef} />
        )}
      </SidebarInset>
    );
  }
  const pending = mode === "unknown";
  return (
    <div
      className="contents"
      // Inline, not a utility class: hidden even before the stylesheet applies.
      style={pending ? { visibility: "hidden" } : undefined}
      inert={pending || undefined}
      aria-busy={pending || undefined}
      data-editorial-thread-mode={mode}
    >
      <ThreadRouteView target={target} background={background} />
    </div>
  );
}
