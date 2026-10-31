import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialVideoState,
  type EditorialVideoUnresolvedInterval,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { FileTextIcon, SaveIcon } from "lucide-react";
import { useState } from "react";

import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useNowSecond } from "../hooks/useNowSecond";
import { VideoDecisionPanel, type VideoDecisionControls } from "./VideoDecisionPanel";
import { VideoResultForm, type VideoResultControls } from "./VideoResultForm";
import { openScript, useThreadWorkspaceRoot, useVideoCommands } from "./videoCommands";
import {
  EMPTY_DECISION_DRAFT,
  MODE_LABEL,
  STAGE_LABEL,
  claimsLabel,
  emptyResultDraft,
  formatClock,
  formatSavedAt,
  interpolateClock,
  isoToLocalInput,
  resolvedEndIso,
  shortHash,
  videoFailureReason,
  videoFailureText,
  type DecisionDraft,
  type ResultDraft,
} from "./videoThread.logic";
import { toastManager } from "../components/ui/toast";
import { useVideoThread } from "./videoState";

interface VideoThreadSectionsControls {
  readonly busy: boolean;
  /** Null when the client cannot tell where the thread's files are. */
  readonly onOpenScript: (() => void) | null;
  readonly onSaveVersion: () => void;
  readonly onResolve: (intervalId: string, endedAt: string) => void;
  readonly decision: VideoDecisionControls;
  readonly result: VideoResultControls;
}

function TrendLink({
  environmentId,
  video,
}: {
  readonly environmentId: EnvironmentId;
  readonly video: EditorialVideoState;
}) {
  const { dossierId, runId, trendTitle } = video.thread;
  if (dossierId === null) {
    return <span className="text-muted-foreground text-xs">Sin expediente</span>;
  }
  const label = trendTitle ?? `Expediente ${dossierId}`;
  return (
    <Link
      to="/editorial/$environmentId/trends/$dossierId"
      params={{ environmentId, dossierId: EditorialDossierId.make(dossierId) }}
      search={runId === null ? {} : { run: EditorialRunId.make(runId) }}
      className="min-w-0 truncate text-foreground text-sm underline-offset-2 hover:underline"
      title="Abrir el expediente en Tendencias"
    >
      {label}
    </Link>
  );
}

function UnresolvedInterval({
  interval,
  busy,
  onResolve,
}: {
  readonly interval: EditorialVideoUnresolvedInterval;
  readonly busy: boolean;
  readonly onResolve: (intervalId: string, endedAt: string) => void;
}) {
  const [value, setValue] = useState("");
  const endedAt = value === "" ? null : resolvedEndIso(value, interval);
  const inputId = `video-resolve-${interval.intervalId}`;
  return (
    <form
      role="alert"
      className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-warning/8 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (endedAt !== null) onResolve(interval.intervalId, endedAt);
      }}
    >
      <p className="text-foreground text-xs">
        Un tramo de {STAGE_LABEL[interval.stage]} empezado a las {formatSavedAt(interval.startedAt)}{" "}
        quedó abierto al reiniciarse el servidor
        {interval.recoveredAt ? ` (${formatSavedAt(interval.recoveredAt)})` : ""}. No cuenta hasta
        que indiques cuándo dejaste de trabajar.
      </p>
      <label className="text-muted-foreground text-xs" htmlFor={inputId}>
        Dejé de trabajar a las
      </label>
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          size="compact"
          type="datetime-local"
          min={isoToLocalInput(interval.startedAt)}
          {...(interval.recoveredAt ? { max: isoToLocalInput(interval.recoveredAt) } : {})}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <Button type="submit" size="xs" variant="outline" disabled={endedAt === null || busy}>
          Resolver
        </Button>
      </div>
    </form>
  );
}

/** The editorial sections of a video thread, as plain props, so tests render them directly. */
function VideoThreadSectionsView({
  environmentId,
  video,
  receivedAtMs,
  nowMs,
  decisionDraft,
  refusedHash,
  resultDraft,
  controls,
}: {
  readonly environmentId: EnvironmentId;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly decisionDraft: DecisionDraft;
  readonly refusedHash: string | null | undefined;
  readonly resultDraft: ResultDraft;
  readonly controls: VideoThreadSectionsControls;
}) {
  const { clock, script } = video;
  const interpolated = interpolateClock(clock, receivedAtMs, nowMs);
  const clockLine =
    video.decision !== null
      ? `Detenido en la decisión · ${formatClock(interpolated.activeMs)}`
      : clock.state._tag === "idle"
        ? `Detenido · ${formatClock(interpolated.activeMs)}`
        : `${clock.state._tag === "paused" ? "En pausa · " : ""}${STAGE_LABEL[clock.state.stage]} ${formatClock(interpolated.stageMs ?? 0)} · total ${formatClock(interpolated.activeMs)}`;
  const head = script.head;
  const claims = head ? claimsLabel(head.claims, head.cited) : null;
  return (
    <>
      <ThreadDetailsSection
        headingId="video-thread-heading"
        title="Hilo de video"
        separated={false}
      >
        <div className="flex flex-col gap-1.5 px-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Badge variant="outline" size="sm">
              {MODE_LABEL[video.thread.mode]}
            </Badge>
            <TrendLink environmentId={environmentId} video={video} />
          </div>
          <p className="text-muted-foreground text-xs tabular-nums" aria-label="Reloj">
            {clockLine}
          </p>
          {clock.unresolved.map((interval) => (
            <UnresolvedInterval
              key={interval.intervalId}
              interval={interval}
              busy={controls.busy}
              onResolve={controls.onResolve}
            />
          ))}
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection
        headingId="video-script-heading"
        title="Guion"
        actions={
          <>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={controls.busy || !script.exists || video.decision !== null}
              onClick={controls.onSaveVersion}
            >
              <SaveIcon aria-hidden />
              Guardar versión
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={controls.onOpenScript === null || script.path === null}
              onClick={() => controls.onOpenScript?.()}
            >
              <FileTextIcon aria-hidden />
              Abrir guion
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-1 px-2.5 text-xs">
          <code className="truncate text-muted-foreground">
            {script.path ?? "Sin ruta de guion"}
          </code>
          {head === null ? (
            <p className="text-muted-foreground">
              {script.exists ? "Sin versiones guardadas." : "Aún no existe: «Abrir guion» lo crea."}
            </p>
          ) : (
            <p className="text-muted-foreground" data-testid="video-script-version">
              Versión {script.versionCount} ·{" "}
              <code className="text-foreground">{shortHash(head.contentHash)}</code> ·{" "}
              {formatSavedAt(head.savedAt)}
              {claims ? ` · ${claims}` : ""}
            </p>
          )}
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="video-decision-heading" title="Decisión">
        <VideoDecisionPanel
          video={video}
          draft={decisionDraft}
          refusedHash={refusedHash}
          controls={controls.decision}
        />
      </ThreadDetailsSection>

      {video.decision !== null ? (
        <ThreadDetailsSection headingId="video-result-heading" title="Resultado">
          <VideoResultForm results={video.results} draft={resultDraft} controls={controls.result} />
        </ThreadDetailsSection>
      ) : null}
    </>
  );
}

/**
 * Mounted once in `ThreadDetailsPanel.tsx` with the thread reference. Renders nothing for a
 * thread with no editorial side, so ordinary T3 threads keep their details card unchanged.
 */
export function VideoThreadSections({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const live = useVideoThread(threadRef);
  const nowMs = useNowSecond();
  const commands = useVideoCommands(threadRef);
  const workspaceRoot = useThreadWorkspaceRoot(threadRef);
  const [busy, setBusy] = useState(false);
  const [decisionDraft, setDecisionDraft] = useState<DecisionDraft>(EMPTY_DECISION_DRAFT);
  const [refusedHash, setRefusedHash] = useState<string | null | undefined>(undefined);
  const [resultDraft, setResultDraft] = useState<ResultDraft>(() => emptyResultDraft());
  const video = live?.view.video ?? null;
  if (live === null || video === null) return null;

  const run = async <A,>(action: () => Promise<A>): Promise<A> => {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  };
  const scriptPath = video.script.path;

  return (
    <VideoThreadSectionsView
      environmentId={threadRef.environmentId}
      video={video}
      receivedAtMs={live.receivedAtMs}
      nowMs={Math.max(nowMs, live.receivedAtMs)}
      decisionDraft={decisionDraft}
      refusedHash={refusedHash}
      resultDraft={resultDraft}
      controls={{
        busy,
        onOpenScript:
          workspaceRoot === null || scriptPath === null
            ? null
            : () => void openScript(threadRef, workspaceRoot, scriptPath),
        onSaveVersion: () =>
          void run(() => commands.saveScript("No se guardó la versión del guion")),
        onResolve: (intervalId, endedAt) =>
          void run(() =>
            commands.clock({ _tag: "resolve", intervalId, endedAt }, "No se resolvió el tramo"),
          ),
        decision: {
          busy,
          onDraftChange: setDecisionDraft,
          onStartDeciding: () =>
            void run(() =>
              commands.clock({ _tag: "stage", stage: "decide" }, "No se cambió la etapa"),
            ),
          onReviewNewVersion: () => setRefusedHash(undefined),
          onSubmit: (versionHash) =>
            void run(async () => {
              const { action, utility, reason } = decisionDraft;
              if (action === null || utility === null) return;
              const outcome = await commands.decide({
                action,
                utility,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
                scriptVersionHash: versionHash,
              });
              if (outcome.ok) {
                setDecisionDraft(EMPTY_DECISION_DRAFT);
                setRefusedHash(undefined);
                return;
              }
              if (videoFailureReason(outcome.error) === "version-changed") {
                setRefusedHash(versionHash);
              } else if (outcome.error !== null) {
                toastManager.add({
                  type: "error",
                  title: "No se registró la decisión",
                  description: videoFailureText(outcome.error),
                });
              }
            }),
        },
        result: {
          busy,
          onDraftChange: setResultDraft,
          onSubmit: (input) =>
            void run(async () => {
              const outcome = await commands.saveResult(input);
              if (outcome.ok) setResultDraft(emptyResultDraft());
            }),
        },
      }}
    />
  );
}
