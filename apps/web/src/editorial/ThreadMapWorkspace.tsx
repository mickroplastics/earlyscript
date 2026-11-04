import { useAtomValue } from "@effect/atom-react";
import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialVideoState,
  type EditorialEvidenceItem,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { useProjectFileQuery } from "../components/files/projectFilesQueryState";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { useNowSecond } from "../hooks/useNowSecond";
import { useQuietThreadShell } from "../state/entities";
import { whyHereReasons, sourceLabel } from "./editorial.logic";
import { editorialEnvironment } from "./state";
import { ScriptEditor } from "./ScriptEditor";
import { ThreadMapScript } from "./ThreadMapScript";
import { ThreadMapView } from "./ThreadMapView";
import { activeMapStop } from "./threadMap.logic";
import { useVideoThread } from "./videoState";
import {
  useThreadWorkspaceRoot,
  placeComposerMessage,
  resolveScriptVersionPath,
} from "./videoCommands";
import { useVideoDecision } from "./useVideoDecision";
import { VideoDecisionPanel } from "./VideoDecisionPanel";
import { VideoResultForm } from "./VideoResultForm";
import { UnresolvedInterval } from "./VideoThreadSections";
import { draftRequestPrompt, formatSavedAt } from "./videoThread.logic";

export function ThreadMapWorkspace({
  threadRef,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly children: ReactNode;
}) {
  const live = useVideoThread(threadRef);
  return live?.view.video ? (
    <LiveMap
      key={threadRef.threadId}
      threadRef={threadRef}
      video={live.view.video}
      receivedAtMs={live.receivedAtMs}
    >
      {children}
    </LiveMap>
  ) : (
    <div aria-busy>{children}</div>
  );
}
function MapDossier({
  threadRef,
  video,
  contents,
  topic,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly video: EditorialVideoState;
  readonly contents: string;
  readonly topic: boolean;
}) {
  const { runId, dossierId } = video.thread;
  if (!runId || !dossierId)
    return topic ? (
      <p>No hay expediente disponible.</p>
    ) : (
      <ThreadMapScript contents={contents} evidence={[]} />
    );
  return (
    <LoadedDossier
      threadRef={threadRef}
      runId={EditorialRunId.make(runId)}
      dossierId={EditorialDossierId.make(dossierId)}
      contents={contents}
      topic={topic}
    />
  );
}
function LoadedDossier({
  threadRef,
  runId,
  dossierId,
  contents,
  topic,
  offset = 0,
  previous = [],
}: {
  readonly threadRef: ScopedThreadRef;
  readonly runId: EditorialRunId;
  readonly dossierId: EditorialDossierId;
  readonly contents: string;
  readonly topic: boolean;
  readonly offset?: number;
  readonly previous?: readonly EditorialEvidenceItem[];
}) {
  const result = useAtomValue(
    editorialEnvironment.dossier({
      environmentId: threadRef.environmentId,
      input: { runId, dossierId, evidenceLimit: 50, evidenceOffset: offset },
    }),
  );
  const dossier = AsyncResult.getOrElse(result, () => null);
  if (!topic) {
    if (dossier === null)
      return (
        <p>
          {AsyncResult.isFailure(result)
            ? "No se pudieron cargar las fuentes del guion."
            : "Cargando las fuentes…"}
        </p>
      );
    const evidence = [...previous, ...dossier.evidence];
    const nextOffset = offset + dossier.evidence.length;
    if (nextOffset < dossier.evidenceTotal && dossier.evidence.length > 0) {
      return (
        <LoadedDossier
          threadRef={threadRef}
          runId={runId}
          dossierId={dossierId}
          contents={contents}
          topic={false}
          offset={nextOffset}
          previous={evidence}
        />
      );
    }
    return <ThreadMapScript contents={contents} evidence={evidence} />;
  }
  return (
    <section className="space-y-4">
      <h2 className="font-semibold text-lg">Por qué está aquí</h2>
      <p>
        {dossier?.trend.presentation?.summary.whyItMatters ??
          (dossier
            ? whyHereReasons({
                trend: dossier.trend,
                affinityThreshold: dossier.affinityThreshold,
                coverage: dossier.coverage,
              }).join(" ")
            : "Cargando el tema…")}
      </p>
      {dossier ? (
        <p>
          {dossier.evidenceTotal} evidencias ·{" "}
          {[...new Set(dossier.evidence.map((e) => sourceLabel(e.source)))].join(", ")}
        </p>
      ) : (
        <p>
          {AsyncResult.isFailure(result) ? "No se pudo cargar el expediente." : "Cargando el tema…"}
        </p>
      )}
      <Link
        className="underline"
        to="/editorial/$environmentId/trends/$dossierId"
        params={{ environmentId: threadRef.environmentId, dossierId }}
        search={{ run: runId }}
      >
        Ver el expediente completo
      </Link>
    </section>
  );
}
function DecidedScript({
  threadRef,
  video,
  workspaceRoot,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly video: EditorialVideoState;
  readonly workspaceRoot: string | null;
}) {
  const hash = video.decision?.scriptVersionHash ?? null;
  const [snapshot, setSnapshot] = useState<{ hash: string; path: string | null } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves the immutable version path through the existing server RPC, ignoring a response after navigation
  useEffect(() => {
    if (hash === null) return;
    let disposed = false;
    void resolveScriptVersionPath(threadRef, hash).then((path) => {
      if (!disposed) setSnapshot({ hash, path });
    });
    return () => {
      disposed = true;
    };
  }, [threadRef, hash]);
  const path = snapshot?.hash === hash ? snapshot.path : null;
  const file = useProjectFileQuery(
    threadRef.environmentId,
    workspaceRoot ?? "",
    path,
    path !== null && workspaceRoot !== null,
  );
  if (hash === null) return <p>Sin versión decidida del guion.</p>;
  if (!file.data)
    return (
      <p>
        {file.error || (snapshot?.hash === hash && path === null)
          ? "No se pudo abrir la versión decidida."
          : "Cargando la versión decidida…"}
      </p>
    );
  return (
    <MapDossier threadRef={threadRef} video={video} contents={file.data.contents} topic={false} />
  );
}

function LiveMap({
  threadRef,
  video,
  receivedAtMs,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly children: ReactNode;
}) {
  const workspaceRoot = useThreadWorkspaceRoot(threadRef);
  const file = useProjectFileQuery(
    threadRef.environmentId,
    workspaceRoot ?? "",
    video.script.path,
    workspaceRoot !== null,
  );
  const shell = useQuietThreadShell(threadRef);
  const nowMs = useNowSecond();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const run = <A,>(action: () => Promise<A>): Promise<A> => {
    setBusy(true);
    return action().finally(() => setBusy(false));
  };
  const outcome = useVideoDecision({ threadRef, video, workspaceRoot, busy, run });
  const refreshScript = useEffectEvent(() => {
    file.refresh();
  });
  const completedAt = shell?.latestRun?.completedAt ?? null;
  const snapshotCompletedRun = useEffectEvent(() => {
    if (video.decision === null) void outcome.commands.saveScript(null);
  });
  // The completion seen when the thread opened: a run from an earlier session must not snapshot
  // again, or opening a thread would record the empty template as a version.
  const openedWithCompletedAt = useRef<string | null | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- captures filesystem writes made by a completed agent turn through the existing idempotent snapshot command
  useEffect(() => {
    if (completedAt === null) return;
    if (openedWithCompletedAt.current === undefined) {
      openedWithCompletedAt.current = completedAt;
      return;
    }
    if (completedAt !== openedWithCompletedAt.current) snapshotCompletedRun();
  }, [completedAt]);

  const contentHash = video.script.head?.contentHash ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the agent writes outside the optimistic editor cache; refetch when a run completes or the server announces a version
  useEffect(() => {
    if (completedAt !== null || contentHash !== null) refreshScript();
  }, [completedAt, contentHash]);
  const contents = file.data?.contents ?? "";
  const active = activeMapStop(video, contents, shell?.latestUserMessageAt != null);
  const change = () => {
    window.setTimeout(
      () => root.current?.querySelector<HTMLElement>('[contenteditable="true"],textarea')?.focus(),
      0,
    );
  };
  return (
    <div
      ref={root}
      className="flex h-dvh min-h-0 min-w-0 flex-1"
      inert={video.thread.deleted || undefined}
    >
      <ThreadMapView
        video={video}
        active={active}
        working={shell?.latestRun?.status === "running"}
        receivedAtMs={receivedAtMs}
        nowMs={Math.max(receivedAtMs, nowMs)}
        topic={<MapDossier threadRef={threadRef} video={video} contents={contents} topic />}
        script={
          video.decision !== null ? (
            <DecidedScript threadRef={threadRef} video={video} workspaceRoot={workspaceRoot} />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Guion · versión {video.script.versionCount}
                {video.script.head ? ` · ${formatSavedAt(video.script.head.savedAt)}` : ""}
              </p>
              {video.script.head ? (
                <Tooltip>
                  <TooltipTrigger render={<p className="text-xs" tabIndex={0} />}>
                    {video.script.head.cited} de {video.script.head.claims} frases con fuente
                    marcada
                  </TooltipTrigger>
                  <TooltipPopup>
                    Cuenta marcadores de fuente; no comprueba si la fuente respalda la frase.
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {editing && workspaceRoot && video.script.path ? (
                <>
                  <button onClick={() => setEditing(false)}>Volver al guion</button>
                  <ScriptEditor
                    threadRef={threadRef}
                    workspaceRoot={workspaceRoot}
                    scriptPath={video.script.path}
                    readOnly={video.decision !== null}
                  />
                </>
              ) : file.error ? (
                <p role="alert">No se pudo leer el guion.</p>
              ) : (
                <MapDossier threadRef={threadRef} video={video} contents={contents} topic={false} />
              )}
            </>
          )
        }
        decision={
          <VideoDecisionPanel
            plainVersion
            video={video}
            draft={outcome.decisionDraft}
            refusedHash={outcome.refusedHash}
            notice={outcome.decisionNotice}
            controls={outcome.decision}
          />
        }
        result={
          <section>
            <h2>Resultado del video</h2>
            <VideoResultForm
              results={video.results}
              draft={outcome.resultDraft}
              controls={outcome.result}
            />
          </section>
        }
        unresolved={video.clock.unresolved.map((interval) => (
          <UnresolvedInterval
            key={interval.intervalId}
            interval={interval}
            busy={busy}
            onResolve={(intervalId, endedAt) =>
              void run(() =>
                outcome.commands.clock(
                  { _tag: "resolve", intervalId, endedAt },
                  "No se resolvió el tramo",
                ),
              )
            }
          />
        ))}
        conversation={children}
        onRead={() =>
          void run(() =>
            outcome.commands.clock(
              video.clock.state._tag === "idle"
                ? { _tag: "start", stage: "write" }
                : { _tag: "stage", stage: "write" },
              "No se cambió la etapa",
            ),
          )
        }
        onRequest={() => {
          placeComposerMessage(threadRef, draftRequestPrompt());
          change();
        }}
        onChange={change}
        onEdit={() => setEditing(true)}
        onDecide={outcome.decision.onEngage}
        onToggleCohort={() =>
          void run(() =>
            outcome.commands.setCohort(video.thread.cohort === "trial" ? "human" : "trial"),
          )
        }
      />
    </div>
  );
}
