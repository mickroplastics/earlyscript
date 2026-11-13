import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";

import { openPreviewSession } from "../../components/preview/openPreviewSession";
import { Button } from "../../components/ui/button";
import { readThreadPreviewState, setActivePreviewTab } from "../../previewStateStore";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { sourceLabel } from "../editorial.logic";
import { sourceDay } from "./ReadingPanels";
import { sourceUrl, type NumberedSource } from "./videoWorkspace.logic";

const PreviewPanel = lazy(() =>
  import("../../components/preview/PreviewPanel").then((module) => ({
    default: module.PreviewPanel,
  })),
);

/** The tab already showing `url`, so jumping back to a source reuses its page. */
function tabShowing(threadRef: ScopedThreadRef, url: string): string | null {
  const { sessions } = readThreadPreviewState(threadRef);
  for (const [tabId, session] of Object.entries(sessions)) {
    const status = session.navStatus;
    if (status._tag !== "Idle" && status.url === url) return tabId;
  }
  return null;
}

/**
 * A source of the dossier in the integrated browser (upstream's preview, embedded), with the
 * way to step from source to source and from one citation of it to the next in the script.
 */
export function SourceBrowser({
  threadRef,
  source,
  sources,
  visible,
  occurrence,
  onSource,
  onOccurrence,
  onBack,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly source: NumberedSource;
  readonly sources: ReadonlyArray<NumberedSource>;
  readonly visible: boolean;
  /** Index of the citation lit in the script, or null. */
  readonly occurrence: number | null;
  readonly onSource: (id: string) => void;
  readonly onOccurrence: (index: number) => void;
  readonly onBack: () => void;
}) {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: true });
  const url = sourceUrl(source.evidence);
  const opened = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the external browser runtime to the source the operator picked, once per source
  useEffect(() => {
    if (url === null || opened.current === url) return;
    opened.current = url;
    const existing = tabShowing(threadRef, url);
    if (existing !== null) setActivePreviewTab(threadRef, existing);
    else void openPreviewSession({ openPreview, threadRef, url });
  }, [openPreview, threadRef, url]);

  const index = sources.findIndex((entry) => entry.id === source.id);
  const step = (delta: number) => {
    const next = sources[(index + delta + sources.length) % sources.length];
    if (next) onSource(next.id);
  };
  const evidence = source.evidence;
  const { paragraphs } = source;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="source-browser">
      <div className="flex shrink-0 flex-col gap-1 border-b px-3 py-2" data-thread-map-script>
        <div className="flex items-center gap-2">
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Fuente anterior"
            onClick={() => step(-1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <span className="shrink-0 rounded bg-primary px-1.5 font-semibold text-primary-foreground text-xs tabular-nums">
            {source.number}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            Fuente {source.number} de {sources.length}
          </span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Fuente siguiente"
            onClick={() => step(1)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
          <span className="min-w-0 flex-1 truncate font-medium text-sm" lang="en">
            {evidence?.title ?? source.id}
          </span>
          {url ? (
            <Button
              size="xs"
              variant="ghost-muted"
              render={<a href={url} target="_blank" rel="noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden />
              Abrir fuera
            </Button>
          ) : null}
        </div>
        <p className="truncate ps-8 text-muted-foreground text-xs">
          {evidence
            ? [sourceLabel(evidence.source), sourceDay(evidence.publishedAt), evidence.author]
                .filter(Boolean)
                .join(" · ")
            : "No está en el expediente"}
          {source.uses > 0
            ? ` · citada ${source.uses === 1 ? "1 vez" : `${source.uses} veces`} en ${source.sections.join(", ")}`
            : " · no se cita en el guion"}
        </p>
      </div>
      {url === null ? (
        <p className="p-6 text-muted-foreground text-sm">Esta fuente no tiene enlace.</p>
      ) : (
        <Suspense fallback={null}>
          <PreviewPanel mode="embedded" threadRef={threadRef} visible={visible} />
        </Suspense>
      )}
      <div
        className="flex shrink-0 items-center gap-2 border-t px-3 py-2 text-xs"
        data-thread-map-script
      >
        <p className="min-w-0 flex-1 text-muted-foreground">
          {source.uses > 0
            ? `${source.uses === 1 ? "1 cita" : `${source.uses} citas`} en ${paragraphs === 1 ? "1 párrafo" : `${paragraphs} párrafos`}, resaltados en el guion.`
            : "El guion no la cita."}
        </p>
        {source.uses > 0 ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Cita anterior"
              onClick={() =>
                onOccurrence(
                  occurrence === null || occurrence <= 0 ? source.uses - 1 : occurrence - 1,
                )
              }
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
            <span className="min-w-16 text-center text-primary tabular-nums">
              {occurrence === null
                ? `${source.uses} citas`
                : `cita ${occurrence + 1} de ${source.uses}`}
            </span>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Cita siguiente"
              onClick={() =>
                onOccurrence(
                  occurrence === null || occurrence >= source.uses - 1 ? 0 : occurrence + 1,
                )
              }
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>
        ) : null}
        <Button size="xs" variant="outline" onClick={onBack}>
          Volver al asistente
        </Button>
      </div>
    </div>
  );
}
