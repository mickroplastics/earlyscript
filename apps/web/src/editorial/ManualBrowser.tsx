import type { ScopedThreadRef } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { openPreviewSession } from "../components/preview/openPreviewSession";
import { Button } from "../components/ui/button";
import { readThreadPreviewState, useThreadPreviewState } from "../previewStateStore";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { USUAL_SITES, capturablePageOf, hostOf, type CapturablePage } from "./manualMode.logic";

const PreviewPanel = lazy(() =>
  import("../components/preview/PreviewPanel").then((module) => ({
    default: module.PreviewPanel,
  })),
);

/** The page open in the thread's active browser tab, for "Capturar". */
export function useCapturablePage(threadRef: ScopedThreadRef): CapturablePage | null {
  const state = useThreadPreviewState(threadRef);
  const tabId = state.activeTabId;
  return capturablePageOf(tabId === null ? null : (state.sessions[tabId] ?? null));
}

/**
 * The integrated browser of a manual thread: upstream's preview, embedded, with its own
 * address bar, tabs and runtimes. No annotations: nothing here is sent to a chat. While no
 * page is open, the sites the operator usually goes through open with one click.
 */
export function ManualBrowser({
  threadRef,
  visible,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly visible: boolean;
}) {
  const hasTab = useThreadPreviewState(threadRef).activeTabId !== null;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const open = (url: string) => {
    // A tab another client opened meanwhile takes the page instead of a second tab.
    if (readThreadPreviewState(threadRef).activeTabId !== null) return;
    void openPreviewSession({ openPreview, threadRef, url });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="manual-browser">
      {hasTab ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1.5 text-xs">
          <span className="text-muted-foreground">Sitios que sueles recorrer:</span>
          {USUAL_SITES.map((url) => (
            <Button key={url} size="xs" variant="ghost" onClick={() => open(url)}>
              <GlobeIcon aria-hidden />
              {hostOf(url)}
            </Button>
          ))}
        </div>
      )}
      <Suspense fallback={null}>
        <PreviewPanel mode="embedded" threadRef={threadRef} visible={visible} />
      </Suspense>
    </div>
  );
}
