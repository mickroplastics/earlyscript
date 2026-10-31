import type { EditorialVideoState, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { SaveIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useNowSecond } from "../hooks/useNowSecond";
import { useQuietThreadShell } from "../state/entities";
import { ManualBrowser, useCapturablePage } from "./ManualBrowser";
import { ManualCaptureList, type ManualCaptureControls } from "./ManualCaptureList";
import {
  MANUAL_STAGES,
  MANUAL_STAGE_LABEL,
  manualStageOf,
  type CapturablePage,
  type ManualStage,
} from "./manualMode.logic";
import { ScriptEditor } from "./ScriptEditor";
import { useVideoDecision } from "./useVideoDecision";
import { VideoDecisionPanel, type VideoDecisionControls } from "./VideoDecisionPanel";
import { VideoResultForm, type VideoResultControls } from "./VideoResultForm";
import { UnresolvedInterval } from "./VideoThreadSections";
import { WorkClock } from "./WorkClock";
import { ensureScriptFile, useThreadWorkspaceRoot } from "./videoCommands";
import {
  claimsLabel,
  formatClock,
  formatSavedAt,
  shortHash,
  stageClockMs,
  type DecisionDraft,
  type ResultDraft,
} from "./videoThread.logic";
import { useVideoThread } from "./videoState";

interface ManualWorkspaceControls {
  readonly busy: boolean;
  /** Moves the clock: closes the running stage and opens `stage` in one server transaction. */
  readonly onStage: (stage: ManualStage) => void;
  readonly onSaveVersion: () => void;
  readonly onResolve: (intervalId: string, endedAt: string) => void;
  readonly capture: ManualCaptureControls;
  readonly decision: VideoDecisionControls;
  readonly result: VideoResultControls;
}

/** The integrated browser and the script editor, built by the caller (read-only once decided). */
interface ManualWorkspaceSlots {
  readonly browser: ReactNode;
  readonly editor: ReactNode;
}

function StageSelector({
  video,
  stage,
  receivedAtMs,
  nowMs,
  busy,
  onStage,
}: {
  readonly video: EditorialVideoState;
  readonly stage: ManualStage;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly busy: boolean;
  readonly onStage: (stage: ManualStage) => void;
}) {
  const decided = video.decision !== null;
  return (
    <ToggleGroup
      aria-label="Etapa"
      variant="segmented"
      className="w-full max-w-xl"
      value={[stage]}
      onValueChange={(values) => {
        const next = MANUAL_STAGES.find((candidate) => candidate === values[0]);
        if (next !== undefined && next !== stage) onStage(next);
      }}
    >
      {MANUAL_STAGES.map((entry, index) => {
        const recorded = video.clock.stages.some((record) => record.stage === entry);
        const time =
          entry === "decide" || !recorded
            ? null
            : formatClock(stageClockMs(video.clock, entry, receivedAtMs, nowMs));
        return (
          <Toggle
            key={entry}
            value={entry}
            className="flex-1"
            disabled={busy || decided}
            aria-label={`${index + 1} · ${MANUAL_STAGE_LABEL[entry]}`}
          >
            <span>
              {index + 1} · {MANUAL_STAGE_LABEL[entry]}
            </span>
            {time === null ? null : (
              <span className="text-muted-foreground tabular-nums">{time}</span>
            )}
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}

function VersionBar({
  video,
  busy,
  onSaveVersion,
}: {
  readonly video: EditorialVideoState;
  readonly busy: boolean;
  readonly onSaveVersion: () => void;
}) {
  const head = video.script.head;
  const claims = head ? claimsLabel(head.claims, head.cited) : null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-1.5 text-xs">
      <p className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="manual-version">
        {head === null
          ? "Sin versiones guardadas. Se guarda una cada vez que dejas de escribir."
          : `Versión ${video.script.versionCount} · ${shortHash(head.contentHash)} · ${formatSavedAt(head.savedAt)}${claims ? ` · ${claims}` : ""}`}
      </p>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={busy || !video.script.exists || video.decision !== null}
        onClick={onSaveVersion}
      >
        <SaveIcon aria-hidden />
        Guardar versión
      </Button>
    </div>
  );
}

function SideTabs({
  tab,
  onTab,
}: {
  readonly tab: "captures" | "browser";
  readonly onTab: (tab: "captures" | "browser") => void;
}) {
  return (
    <ToggleGroup
      aria-label="Panel lateral"
      variant="segmented"
      value={[tab]}
      onValueChange={(values) => {
        const next = values[0];
        if (next === "captures" || next === "browser") onTab(next);
      }}
    >
      <Toggle value="captures" className="flex-1">
        Capturas
      </Toggle>
      <Toggle value="browser" className="flex-1">
        Navegador
      </Toggle>
    </ToggleGroup>
  );
}

/** The manual workspace as plain props and slots. */
function ManualVideoWorkspaceView({
  environmentId,
  title,
  video,
  receivedAtMs,
  nowMs,
  page,
  clock,
  decisionDraft,
  refusedHash,
  decisionNotice,
  resultDraft,
  slots,
  controls,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly page: CapturablePage | null;
  /** The two stage clocks with pause and resume. */
  readonly clock: ReactNode;
  readonly decisionDraft: DecisionDraft;
  readonly refusedHash: string | null | undefined;
  readonly decisionNotice: string | null;
  readonly resultDraft: ResultDraft;
  readonly slots: ManualWorkspaceSlots;
  readonly controls: ManualWorkspaceControls;
}) {
  const stage = manualStageOf(video);
  const decided = video.decision !== null;
  const [sideTab, setSideTab] = useState<"captures" | "browser">("captures");
  const captures = (
    <ManualCaptureList
      captures={video.captures}
      visits={video.visits}
      page={page}
      readOnly={decided}
      controls={controls.capture}
    />
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="manual-video-workspace"
      data-environment-id={environmentId}
      data-stage={stage}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <h1 className="min-w-0 truncate font-medium text-sm">{title}</h1>
        <Badge variant="outline" size="sm">
          manual
        </Badge>
        {video.thread.trendKey !== null ? (
          <span className="text-muted-foreground text-xs">
            mismo tema que una tendencia (comparación por pares)
          </span>
        ) : null}
        <div className="ms-auto">{clock}</div>
      </header>
      <div className="flex shrink-0 flex-col gap-2 px-4 py-2">
        <StageSelector
          video={video}
          stage={stage}
          receivedAtMs={receivedAtMs}
          nowMs={nowMs}
          busy={controls.busy}
          onStage={controls.onStage}
        />
        {video.clock.unresolved.map((interval) => (
          <UnresolvedInterval
            key={interval.intervalId}
            interval={interval}
            busy={controls.busy}
            onResolve={controls.onResolve}
          />
        ))}
      </div>

      {stage === "explore" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(16rem,22rem)_1fr] border-t">
          <div className="min-h-0 overflow-y-auto border-e p-3">{captures}</div>
          <div className="flex min-h-0 flex-col">{slots.browser}</div>
        </div>
      ) : stage === "write" ? (
        <div className="grid min-h-0 flex-1 grid-cols-[1.4fr_1fr] border-t">
          <div className="flex min-h-0 flex-col border-e">
            {slots.editor}
            <VersionBar video={video} busy={controls.busy} onSaveVersion={controls.onSaveVersion} />
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="shrink-0 p-2">
              <SideTabs tab={sideTab} onTab={setSideTab} />
            </div>
            {sideTab === "captures" ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">{captures}</div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">{slots.browser}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[1.4fr_1fr] border-t">
          <div className="flex min-h-0 flex-col border-e">
            {slots.editor}
            <VersionBar video={video} busy={controls.busy} onSaveVersion={controls.onSaveVersion} />
          </div>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto py-3">
            <section aria-label="Decidir" className="flex flex-col gap-2">
              <h2 className="px-2.5 font-medium text-sm">Decisión</h2>
              <VideoDecisionPanel
                video={video}
                draft={decisionDraft}
                refusedHash={refusedHash}
                notice={decisionNotice}
                controls={controls.decision}
              />
            </section>
            {decided ? (
              <section aria-label="Resultado" className="flex flex-col gap-2">
                <h2 className="px-2.5 font-medium text-sm">Resultado</h2>
                <VideoResultForm
                  results={video.results}
                  draft={resultDraft}
                  controls={controls.result}
                />
              </section>
            ) : null}
            <div className="px-2.5">{captures}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Takes ChatView's place for a manual video thread (see `EditorialThreadRouteView`): no chat,
 * no composer, no engine. Explorar with captures and the integrated browser, Escribir with the
 * script editor, Decidir with the same recording as an assisted thread. The two stage clocks
 * come from the server's intervals; changing stage is one clock command.
 */
export function ManualVideoWorkspace({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const live = useVideoThread(threadRef);
  const video = live?.view.video ?? null;
  if (live === null || video === null) {
    return <div className="flex-1" aria-busy data-testid="manual-video-workspace-loading" />;
  }
  return (
    <LiveManualWorkspace threadRef={threadRef} video={video} receivedAtMs={live.receivedAtMs} />
  );
}

function LiveManualWorkspace({
  threadRef,
  video,
  receivedAtMs,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
}) {
  const nowMs = useNowSecond();
  const shell = useQuietThreadShell(threadRef);
  const workspaceRoot = useThreadWorkspaceRoot(threadRef);
  const page = useCapturablePage(threadRef);
  const [busy, setBusy] = useState(false);
  const run = <A,>(action: () => Promise<A>): Promise<A> => {
    setBusy(true);
    return action().finally(() => setBusy(false));
  };
  const outcome = useVideoDecision({ threadRef, video, workspaceRoot, busy, run });
  const { commands } = outcome;
  const scriptPath = video.script.path;

  const onStage = (stage: ManualStage) =>
    void run(async () => {
      if (stage !== "explore" && workspaceRoot !== null && scriptPath !== null) {
        // Escribir opens on the script: create it from the template the first time.
        if (!(await ensureScriptFile(threadRef, workspaceRoot, scriptPath))) return;
      }
      await commands.clock(
        video.clock.state._tag === "idle" ? { _tag: "start", stage } : { _tag: "stage", stage },
        "No se cambió la etapa",
      );
    });

  return (
    <ManualVideoWorkspaceView
      environmentId={threadRef.environmentId}
      title={shell?.title ?? "Hilo manual"}
      video={video}
      receivedAtMs={receivedAtMs}
      nowMs={Math.max(nowMs, receivedAtMs)}
      page={page}
      clock={<WorkClock threadRef={threadRef} variant="stages" />}
      decisionDraft={outcome.decisionDraft}
      refusedHash={outcome.refusedHash}
      decisionNotice={outcome.decisionNotice}
      resultDraft={outcome.resultDraft}
      slots={{
        browser: <ManualBrowser threadRef={threadRef} visible />,
        editor:
          workspaceRoot === null || scriptPath === null ? (
            <p className="p-4 text-muted-foreground text-sm">
              No se sabe dónde está el guion de este hilo.
            </p>
          ) : (
            <ScriptEditor
              threadRef={threadRef}
              workspaceRoot={workspaceRoot}
              scriptPath={scriptPath}
              readOnly={video.decision !== null}
            />
          ),
      }}
      controls={{
        busy,
        onStage,
        onSaveVersion: () =>
          void run(() => commands.saveScript("No se guardó la versión del guion")),
        onResolve: (intervalId, endedAt) =>
          void run(() =>
            commands.clock({ _tag: "resolve", intervalId, endedAt }, "No se resolvió el tramo"),
          ),
        capture: {
          busy,
          onCapture: (capture) =>
            run(async () => {
              const saved = await commands.capture({
                url: capture.url,
                ...(capture.title ? { title: capture.title } : {}),
                ...(capture.note ? { note: capture.note } : {}),
              });
              return saved.ok;
            }),
          onRemove: (captureId) => void run(() => commands.removeCapture(captureId)),
        },
        decision: outcome.decision,
        result: outcome.result,
      }}
    />
  );
}
