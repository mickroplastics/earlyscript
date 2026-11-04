import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialVideoState,
  type EditorialVideoUnresolvedInterval,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  FileSearchIcon,
  FileTextIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  SaveIcon,
} from "lucide-react";
import { useState } from "react";

import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useNowSecond } from "../hooks/useNowSecond";
import { useQuietThreadShell } from "../state/entities";
import { VideoDecisionPanel, type VideoDecisionControls } from "./VideoDecisionPanel";
import { VideoResultForm, type VideoResultControls } from "./VideoResultForm";
import {
  openDossier,
  openScript,
  placeComposerMessage,
  useThreadWorkspaceRoot,
} from "./videoCommands";
import { useVideoDecision } from "./useVideoDecision";
import {
  MODE_LABEL,
  STAGE_LABEL,
  claimsLabel,
  draftRequestPaths,
  draftRequestPrompt,
  formatClock,
  formatSavedAt,
  interpolateClock,
  isoToLocalInput,
  resolvedEndIso,
  shortHash,
  type DecisionDraft,
  type ResultDraft,
} from "./videoThread.logic";
import { useVideoThread } from "./videoState";

interface VideoThreadSectionsControls {
  readonly busy: boolean;
  /** Null when the client cannot tell where the thread's files are. */
  readonly onOpenScript: (() => void) | null;
  /** Null without a dossier file or a known workspace. */
  readonly onOpenDossier: (() => void) | null;
  /** Fills the composer with the first request to the agent; null once it is not the start. */
  readonly onRequestDraft: (() => void) | null;
  /** Opens the read-only copy of the version the decision names. */
  readonly onOpenDecidedVersion: (contentHash: string) => void;
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

/** Asks when a segment recovered after a restart ended; the manual workspace shows it too. */
export function UnresolvedInterval({
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
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          id={inputId}
          className="min-w-0 flex-1"
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
  decisionNotice,
  resultDraft,
  controls,
}: {
  readonly environmentId: EnvironmentId;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly nowMs: number;
  readonly decisionDraft: DecisionDraft;
  readonly refusedHash: string | null | undefined;
  readonly decisionNotice: string | null;
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
          {controls.onRequestDraft !== null ? (
            <div className="mt-1 flex flex-col items-start gap-1">
              <Button size="xs" onClick={() => controls.onRequestDraft?.()}>
                <MessageSquarePlusIcon aria-hidden />
                Pedir un borrador del guion
              </Button>
              <p className="text-muted-foreground text-xs">
                Deja la petición escrita en el mensaje. El agente empieza cuando la envías.
              </p>
            </div>
          ) : null}
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="video-script-heading" title="Guion">
        <div className="flex flex-col gap-1 px-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-1">
            {video.decision === null ? (
              <Button
                size="xs"
                variant="outline"
                disabled={controls.onOpenScript === null || script.path === null}
                onClick={() => controls.onOpenScript?.()}
              >
                <PencilIcon aria-hidden />
                Editar guion
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                disabled={video.decision.scriptVersionHash === null}
                onClick={() => {
                  const hash = video.decision?.scriptVersionHash;
                  if (hash) controls.onOpenDecidedVersion(hash);
                }}
              >
                <FileTextIcon aria-hidden />
                Abrir versión decidida
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={controls.busy || !script.exists || video.decision !== null}
              onClick={controls.onSaveVersion}
            >
              <SaveIcon aria-hidden />
              Guardar versión
            </Button>
          </div>
          {/* Cut from the start: the end of the path names the file. */}
          <code className="truncate text-left text-muted-foreground [direction:rtl]">
            <bdi>{script.path ?? "Sin ruta de guion"}</bdi>
          </code>
          {video.decision === null ? (
            <p className="text-muted-foreground">
              Se abre a la derecha en texto: escribe ahí. Cada pausa al escribir guarda una versión.
            </p>
          ) : null}
          {head === null ? (
            <p className="text-muted-foreground">
              {script.exists
                ? "Sin versiones guardadas."
                : "Aún no existe: «Editar guion» lo crea."}
            </p>
          ) : (
            <p className="text-muted-foreground" data-testid="video-script-version">
              Versión {script.versionCount} ·{" "}
              <code className="text-foreground">{shortHash(head.contentHash)}</code> ·{" "}
              {formatSavedAt(head.savedAt)}
              {claims ? ` · ${claims}` : ""}
            </p>
          )}
          {script.dossierPath ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                disabled={controls.onOpenDossier === null}
                onClick={() => controls.onOpenDossier?.()}
              >
                <FileSearchIcon aria-hidden />
                Abrir expediente
              </Button>
              <span className="text-muted-foreground">Solo lectura</span>
            </div>
          ) : null}
        </div>
      </ThreadDetailsSection>

      <ThreadDetailsSection headingId="video-decision-heading" title="Decisión">
        <VideoDecisionPanel
          video={video}
          draft={decisionDraft}
          refusedHash={refusedHash}
          notice={decisionNotice}
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
  const video = live?.view.video ?? null;
  if (live === null || video === null) return null;
  return (
    <LiveVideoThreadSections threadRef={threadRef} video={video} receivedAtMs={live.receivedAtMs} />
  );
}

function LiveVideoThreadSections({
  threadRef,
  video,
  receivedAtMs,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
}) {
  const nowMs = useNowSecond();
  const workspaceRoot = useThreadWorkspaceRoot(threadRef);
  const [busy, setBusy] = useState(false);
  const run = <A,>(action: () => Promise<A>): Promise<A> => {
    setBusy(true);
    return action().finally(() => setBusy(false));
  };
  const outcome = useVideoDecision({ threadRef, video, workspaceRoot, busy, run });
  const { commands } = outcome;
  const scriptPath = video.script.path;
  const dossierPath = video.script.dossierPath ?? null;
  const draftPaths = draftRequestPaths(video, useQuietThreadShell(threadRef));

  return (
    <VideoThreadSectionsView
      environmentId={threadRef.environmentId}
      video={video}
      receivedAtMs={receivedAtMs}
      nowMs={Math.max(nowMs, receivedAtMs)}
      decisionDraft={outcome.decisionDraft}
      refusedHash={outcome.refusedHash}
      decisionNotice={outcome.decisionNotice}
      resultDraft={outcome.resultDraft}
      controls={{
        busy,
        onOpenScript:
          workspaceRoot === null || scriptPath === null
            ? null
            : () => void openScript(threadRef, workspaceRoot, scriptPath),
        onOpenDossier:
          workspaceRoot === null || dossierPath === null
            ? null
            : () => openDossier(threadRef, workspaceRoot, dossierPath),
        onRequestDraft:
          draftPaths === null
            ? null
            : () => placeComposerMessage(threadRef, draftRequestPrompt(draftPaths)),
        onOpenDecidedVersion: (contentHash) => void commands.openVersion(contentHash),
        onSaveVersion: () =>
          void run(() => commands.saveScript("No se guardó la versión del guion")),
        onResolve: (intervalId, endedAt) =>
          void run(() =>
            commands.clock({ _tag: "resolve", intervalId, endedAt }, "No se resolvió el tramo"),
          ),
        decision: outcome.decision,
        result: outcome.result,
      }}
    />
  );
}
