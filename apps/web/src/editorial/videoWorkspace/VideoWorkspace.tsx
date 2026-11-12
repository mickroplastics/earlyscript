import { useAtomValue } from "@effect/atom-react";
import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialResultsStage,
  type EditorialTrendDossier,
  type EditorialVideoState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, CheckIcon, LockIcon, PencilIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { useProjectFileQuery } from "../../components/files/projectFilesQueryState";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { videoDeveloperToolsHidden } from "../../earlyscript/hiddenFeatures";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { ScriptEditor } from "../ScriptEditor";
import { editorialEnvironment } from "../state";
import { useVideoDecision } from "../useVideoDecision";
import { VideoDecisionPanel } from "../VideoDecisionPanel";
import { VideoResultForm } from "../VideoResultForm";
import {
  placeComposerMessage,
  resolveScriptVersionPath,
  useThreadWorkspaceRoot,
} from "../videoCommands";
import { formatSavedAt, restartStage } from "../videoThread.logic";
import { SourceBrowser } from "./SourceBrowser";
import { SourcesPanel, TopicPanel, sourceDay } from "./ReadingPanels";
import { NoticeBar, ScriptEmpty, ScriptView } from "./ScriptView";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { VideoComposerContext, type VideoComposerOffer } from "./VideoComposerAccessory";
import { ClockPill, NowLine, ResolveIntervalForm, VideoSteps } from "./VideoStepper";
import {
  dateAndTime,
  draftParts,
  numberSources,
  scriptNotices,
  stepperModel,
  uncitedSentences,
  type ScriptNotice,
  scriptSource,
} from "./videoWorkspace.logic";
import "../threadMap.css";

type LeftTab = "topic" | "script" | "sources";
type RightTab = "assistant" | "source" | "decision" | "details";

/**
 * The script on screen: the working file before the decision, the version it names after it,
 * nothing when the decision was recorded without a version.
 */
function useScriptContents(
  threadRef: ScopedThreadRef,
  video: EditorialVideoState,
  workspaceRoot: string | null,
  completedAt: string | null,
) {
  const source = scriptSource(video);
  const decidedHash = source.kind === "decided" ? source.hash : null;
  const live = useProjectFileQuery(
    threadRef.environmentId,
    workspaceRoot ?? "",
    video.script.path,
    workspaceRoot !== null && source.kind === "live",
  );
  const [snapshot, setSnapshot] = useState<{ hash: string; path: string | null } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves the immutable version path through the existing server RPC, ignoring a response after navigation
  useEffect(() => {
    if (decidedHash === null) return;
    let disposed = false;
    void resolveScriptVersionPath(threadRef, decidedHash).then((path) => {
      if (!disposed) setSnapshot({ hash: decidedHash, path });
    });
    return () => {
      disposed = true;
    };
  }, [threadRef, decidedHash]);
  const decidedPath = snapshot?.hash === decidedHash ? snapshot.path : null;
  const decided = useProjectFileQuery(
    threadRef.environmentId,
    workspaceRoot ?? "",
    decidedPath,
    decidedPath !== null && workspaceRoot !== null,
  );
  const refresh = useEffectEvent(() => live.refresh());
  const contentHash = video.script.head?.contentHash ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the agent writes outside the optimistic editor cache; refetch when a run completes or the server announces a version
  useEffect(() => {
    if (completedAt !== null || contentHash !== null) refresh();
  }, [completedAt, contentHash]);
  if (source.kind === "none") return { status: "unsaved" as const, contents: "" };
  if (decidedHash !== null) {
    if (decided.data) return { status: "ready" as const, contents: decided.data.contents };
    const failed = decided.error || (snapshot?.hash === decidedHash && decidedPath === null);
    return { status: failed ? ("error" as const) : ("loading" as const), contents: "" };
  }
  if (live.data) return { status: "ready" as const, contents: live.data.contents };
  return { status: live.error ? ("error" as const) : ("loading" as const), contents: "" };
}

/** Only the first page of evidence: a dossier selects far fewer than the page holds. */
function DossierLoader({
  threadRef,
  runId,
  dossierId,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly runId: string;
  readonly dossierId: string;
  readonly children: (dossier: EditorialTrendDossier | null, failed: boolean) => ReactNode;
}) {
  const result = useAtomValue(
    editorialEnvironment.dossier({
      environmentId: threadRef.environmentId,
      input: {
        runId: EditorialRunId.make(runId),
        dossierId: EditorialDossierId.make(dossierId),
        evidenceLimit: 50,
        evidenceOffset: 0,
      },
    }),
  );
  return children(
    AsyncResult.getOrElse(result, () => null),
    AsyncResult.isFailure(result),
  );
}

/**
 * The assisted video thread: the three steps on top, what to read on the left (topic, script,
 * sources) and the tool of the moment on the right (assistant, a source, the decision,
 * details). `children` is upstream's thread view, the conversation, kept mounted throughout.
 */
export function VideoWorkspace({
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
  const { runId, dossierId } = video.thread;
  const view = (dossier: EditorialTrendDossier | null, failed: boolean) => (
    <WorkspaceView
      threadRef={threadRef}
      video={video}
      receivedAtMs={receivedAtMs}
      dossier={dossier}
      dossierState={runId && dossierId ? (failed ? "failed" : "ready") : "none"}
    >
      {children}
    </WorkspaceView>
  );
  return runId && dossierId ? (
    <DossierLoader threadRef={threadRef} runId={runId} dossierId={dossierId}>
      {view}
    </DossierLoader>
  ) : (
    view(null, false)
  );
}

function TabButton({
  selected,
  onSelect,
  children,
  onClose,
  closeLabel,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly children: ReactNode;
  readonly onClose?: () => void;
  readonly closeLabel?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-md text-sm",
        selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring rounded-md"
      >
        {children}
      </button>
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="-ms-1 me-1 rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

function WorkspaceView({
  threadRef,
  video,
  receivedAtMs,
  dossier,
  dossierState,
  children,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly video: EditorialVideoState;
  readonly receivedAtMs: number;
  readonly dossier: EditorialTrendDossier | null;
  readonly dossierState: "none" | "ready" | "failed";
  readonly children: ReactNode;
}) {
  const workspaceRoot = useThreadWorkspaceRoot(threadRef);
  const shell = useQuietThreadShell(threadRef);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(threadRef.environmentId));
  const [busy, setBusy] = useState(false);
  const run = <A,>(action: () => Promise<A>): Promise<A> => {
    setBusy(true);
    return action().finally(() => setBusy(false));
  };
  const outcome = useVideoDecision({ threadRef, video, workspaceRoot, busy, run });
  const { commands } = outcome;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);

  const completedAt = shell?.latestRun?.completedAt ?? null;
  const snapshotCompletedRun = useEffectEvent(() => {
    if (video.decision === null) void commands.saveScript(null);
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

  const script = useScriptContents(threadRef, video, workspaceRoot, completedAt);
  const contents = script.contents;
  const parts = draftParts(contents);
  const drafted = parts.done > 0;
  const agentWorking = shell?.latestRun?.status === "running";
  const decided = video.decision !== null;
  const model = stepperModel({ video, parts, agentWorking });
  const asked = shell?.latestUserMessageAt != null;

  const evidence = dossier?.evidence ?? [];
  const sources = numberSources(contents, evidence);
  const notices = drafted ? scriptNotices(contents) : [];
  const verifier = drafted ? uncitedSentences(contents) : null;
  const uncited = new Set(verifier?.uncited.map((claim) => `${claim.line}|${claim.text}`) ?? []);

  const phase = decided ? "decided" : model.current === "decide" ? "decide" : "work";
  const [leftChoice, setLeftChoice] = useState<{ phase: string; tab: LeftTab } | null>(null);
  const [rightChoice, setRightChoice] = useState<{ phase: string; tab: RightTab } | null>(null);
  const defaultLeft: LeftTab = drafted || decided ? "script" : "topic";
  const defaultRight: RightTab = phase === "work" ? "assistant" : "decision";
  const leftTab = leftChoice?.phase === phase ? leftChoice.tab : defaultLeft;
  const rightTab = rightChoice?.phase === phase ? rightChoice.tab : defaultRight;
  const showLeft = (tab: LeftTab) => setLeftChoice({ phase, tab });
  const showRight = (tab: RightTab) => setRightChoice({ phase, tab });

  const [openSource, setOpenSource] = useState<string | null>(null);
  const [occurrence, setOccurrence] = useState<number | null>(null);
  const [noticeIndex, setNoticeIndex] = useState<number | null>(null);
  // Editing by hand belongs to Escribir: entering Decidir or deciding closes the editor, whose
  // save session writes what is pending as it unmounts.
  const [editingPhase, setEditingPhase] = useState<string | null>(null);
  const editable = phase === "work";
  // Leaving Escribir ends the edit for good: back from Decidir, the script shows rendered.
  if (!editable && editingPhase !== null) setEditingPhase(null);
  const editing = editable && editingPhase === phase;
  const setEditing = (on: boolean) => setEditingPhase(on ? phase : null);
  const source = sources.find((entry) => entry.id === openSource) ?? null;
  const readingPane = useRef<HTMLDivElement>(null);

  const scrollToLine = (line: number) =>
    // After the tab shows the script, so the paragraph exists to scroll to.
    window.setTimeout(() => {
      readingPane.current
        ?.querySelector<HTMLElement>(`[data-line="${line}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  const scrollToCitation = (key: string, line: number) =>
    window.setTimeout(() => {
      const pane = readingPane.current;
      (
        pane?.querySelector<HTMLElement>(`[data-cite-key="${CSS.escape(key)}"]`) ??
        pane?.querySelector<HTMLElement>(`[data-line="${line}"]`)
      )?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  /** Opens a source; from a number in the script, the walk starts at that citation. */
  const openSourceTab = (id: string, key?: string) => {
    const index =
      key === undefined
        ? -1
        : (sources
            .find((entry) => entry.id === id)
            ?.occurrences.findIndex((occurrence) => occurrence.key === key) ?? -1);
    setOpenSource(id);
    setOccurrence(index >= 0 ? index : null);
    showRight("source");
  };
  const goToOccurrence = (index: number) => {
    const target = source?.occurrences[index];
    if (target === undefined) return;
    setOccurrence(index);
    setEditing(false);
    showLeft("script");
    scrollToCitation(target.key, target.line);
  };
  const goToNotice = (index: number) => {
    const notice: ScriptNotice | undefined = notices[index];
    if (notice === undefined) return;
    setNoticeIndex(index);
    scrollToLine(notice.line);
  };

  const clockStage = (stage: EditorialResultsStage) =>
    void run(() =>
      commands.clock(
        video.clock.state._tag === "idle" ? { _tag: "start", stage } : { _tag: "stage", stage },
        "No se cambió el paso",
      ),
    );

  const send = (text: string) => {
    const store = useComposerDraftStore.getState();
    const existing = store.getComposerDraft(threadRef)?.prompt ?? "";
    if (existing.trim().length > 0 && existing !== text) {
      placeComposerMessage(threadRef, text);
      return;
    }
    store.setPrompt(threadRef, text);
    showRight("assistant");
    // The composer reads its draft from the store on its next render; submit after it.
    window.setTimeout(() => {
      root
        ?.querySelector<HTMLFormElement>("[data-map-conversation] form[data-chat-composer-form]")
        ?.requestSubmit();
    }, 0);
  };
  const composerOffer: VideoComposerOffer | null =
    decided || agentWorking
      ? null
      : {
          phase: !asked ? "welcome" : drafted ? "drafted" : "no-draft",
          evidenceTotal: dossier?.evidenceTotal ?? null,
          send,
        };

  const modelSelection = shell?.modelSelection;
  const provider = providers?.find((entry) => entry.instanceId === modelSelection?.instanceId);
  const modelLabel = modelSelection
    ? (provider?.models.find((entry) => entry.slug === modelSelection.model)?.name ??
      modelSelection.model)
    : null;

  const trendDossierId = video.thread.dossierId;
  const trendLink =
    trendDossierId === null ? null : (
      <Link
        className="text-primary underline-offset-2 hover:underline"
        to="/editorial/$environmentId/trends/$dossierId"
        params={{
          environmentId: threadRef.environmentId,
          dossierId: EditorialDossierId.make(trendDossierId),
        }}
        search={video.thread.runId ? { run: EditorialRunId.make(video.thread.runId) } : {}}
      >
        Abrir la tendencia
      </Link>
    );

  const pending = [
    ...(() => {
      const holes = notices.filter((notice) => notice.kind === "hole").length;
      const notes = notices.filter((notice) => notice.kind === "operator").length;
      return [
        holes > 0
          ? `${holes === 1 ? "1 hueco" : `${holes} huecos`} por rellenar al grabar, como {{${notices.find((notice) => notice.kind === "hole")?.text ?? "…"}}}.`
          : null,
        notes > 0
          ? `${notes === 1 ? "1 nota para ti" : `${notes} notas para ti`} en el guion (OPERATOR).`
          : null,
      ];
    })(),
    verifier && verifier.uncited.length > 0
      ? `${verifier.uncited.length} de ${verifier.claims} frases sin número de fuente, según la revisión de referencias.`
      : null,
  ].filter((line): line is string => line !== null);

  const nowActions: ReactNode =
    model.now.action === "decide" ? (
      <Button size="sm" disabled={busy} onClick={() => clockStage("decide")}>
        Listo, pasar a decidir
      </Button>
    ) : model.now.action === "back-to-write" ? (
      <Button
        size="sm"
        variant="ghost-muted"
        disabled={busy}
        onClick={() => {
          clockStage("write");
          setRightChoice({ phase: "work", tab: "assistant" });
        }}
      >
        <ArrowLeftIcon aria-hidden />
        Volver a revisar · el reloj vuelve al paso 2
      </Button>
    ) : model.now.action === "resume" ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void run(() => commands.clock({ _tag: "resume" }, "No se reanudó"))}
      >
        Reanudar
      </Button>
    ) : model.now.action === "restart" ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          void run(() =>
            commands.clock(
              { _tag: "start", stage: model.current ?? restartStage("assisted", video.clock) },
              "No se reanudó",
            ),
          )
        }
      >
        Reanudar
      </Button>
    ) : model.now.action === "resolve" && video.clock.unresolved[0] ? (
      <ResolveIntervalForm
        key={video.clock.unresolved[0].intervalId}
        interval={video.clock.unresolved[0]}
        busy={busy}
        onResolve={(intervalId, endedAt) =>
          void run(() =>
            commands.clock({ _tag: "resolve", intervalId, endedAt }, "No se guardó la hora"),
          )
        }
      />
    ) : decided ? (
      <Button
        size="sm"
        variant="ghost-muted"
        render={
          <Link
            to="/editorial/$environmentId/results"
            params={{ environmentId: threadRef.environmentId }}
          />
        }
      >
        Ver en Resultados
      </Button>
    ) : null;

  const scriptHint = decided
    ? script.status === "unsaved"
      ? "Sin versión decidida"
      : "Versión decidida"
    : model.current === "decide"
      ? "Solo lectura mientras decides"
      : drafted
        ? "Toca un número para abrir su fuente"
        : "";
  const sourceWide = rightTab === "source" && source !== null;
  const trial = video.thread.cohort === "trial";

  const scriptPane = (() => {
    if (editing && workspaceRoot && video.script.path) {
      return (
        <ScriptEditor
          threadRef={threadRef}
          workspaceRoot={workspaceRoot}
          scriptPath={video.script.path}
          readOnly={false}
        />
      );
    }
    if (script.status === "error") {
      return (
        <p role="alert" className="text-sm">
          {decided ? "No se pudo abrir la versión decidida." : "No se pudo leer el guion."}
        </p>
      );
    }
    if (script.status === "unsaved") {
      return (
        <p className="rounded-lg border bg-card/40 p-4 text-muted-foreground text-sm">
          Esta decisión se registró sin una versión guardada del guion, así que no hay texto
          decidido que mostrar. El archivo de trabajo puede haber cambiado después.
        </p>
      );
    }
    if (script.status === "loading") {
      return <p className="text-muted-foreground text-sm">Cargando el guion…</p>;
    }
    if (!drafted) {
      return (
        <ScriptEmpty
          writing={agentWorking}
          onStart={
            decided || video.clock.state._tag === "paused"
              ? null
              : () =>
                  send(
                    "Escribe el primer borrador del guion con el ángulo que propone la ficha del tema.",
                  )
          }
        />
      );
    }
    return (
      <ScriptView
        contents={contents}
        sources={sources}
        notices={notices}
        uncited={uncited}
        activeNoticeLine={noticeIndex === null ? null : (notices[noticeIndex]?.line ?? null)}
        highlightSource={sourceWide ? openSource : null}
        activeCitationKey={
          sourceWide && occurrence !== null ? (source?.occurrences[occurrence]?.key ?? null) : null
        }
        onOpenSource={openSourceTab}
      />
    );
  })();

  return (
    <VideoComposerContext value={composerOffer}>
      <div
        ref={setRoot}
        className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col bg-background"
        data-testid="thread-map"
        data-map-quiet={videoDeveloperToolsHidden()}
        data-map-welcome={composerOffer?.phase === "welcome" || undefined}
        inert={video.thread.deleted || undefined}
      >
        <style>{`[data-map-quiet="true"] [data-chat-provider-model-picker], [data-map-quiet="true"] [data-composer-shortcut~="composer.effort"] { display: none; }`}</style>
        <header
          className="flex shrink-0 flex-col gap-3 border-b px-5 pt-3 pb-3"
          data-thread-map-script
        >
          <div className={cn("flex min-h-9 items-center gap-3", isElectron && "pe-16")}>
            <h1 className="line-clamp-2 min-w-0 flex-1 font-semibold text-base leading-snug">
              {video.thread.trendTitle ?? shell?.title ?? "Hilo de video"}
              <Badge variant="outline" size="sm" className="ms-2 align-middle">
                Con asistente
              </Badge>
              {trial ? (
                <Badge
                  variant="outline"
                  size="sm"
                  className="ms-1.5 align-middle"
                  data-testid="map-trial-badge"
                >
                  Ensayo
                </Badge>
              ) : null}
            </h1>
            <ClockPill
              video={video}
              busy={busy}
              onPause={() =>
                void run(() => commands.clock({ _tag: "pause" }, "No se pausó el reloj"))
              }
              onResume={() =>
                void run(() =>
                  video.clock.state._tag === "idle"
                    ? commands.clock(
                        {
                          _tag: "start",
                          stage: model.current ?? restartStage("assisted", video.clock),
                        },
                        "No se reanudó",
                      )
                    : commands.clock({ _tag: "resume" }, "No se reanudó"),
                )
              }
              onStage={clockStage}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run(() => commands.setCohort(trial ? "human" : "trial"))}
                  />
                }
              >
                {trial ? "Quitar marca de ensayo" : "Marcar como ensayo"}
              </TooltipTrigger>
              <TooltipPopup side="bottom" className="max-w-64">
                Un ensayo se conserva como evidencia, pero no cuenta en Resultados.
              </TooltipPopup>
            </Tooltip>
          </div>
          <VideoSteps
            model={model}
            video={video}
            receivedAtMs={receivedAtMs}
            parts={parts}
            agentWorking={agentWorking}
          />
          <NowLine model={model} actions={nowActions} />
        </header>

        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns: sourceWide
              ? "minmax(0,1fr) min(42rem,54%)"
              : "minmax(0,1fr) min(30rem,40%)",
          }}
        >
          <section
            className="flex min-h-0 min-w-0 flex-col"
            aria-label="Lectura"
            data-thread-map-script
          >
            <div className="flex h-11 shrink-0 items-center gap-1 border-b px-3" role="tablist">
              <TabButton selected={leftTab === "topic"} onSelect={() => showLeft("topic")}>
                Tema
              </TabButton>
              <TabButton selected={leftTab === "script"} onSelect={() => showLeft("script")}>
                Guion
                {!drafted && !decided ? (
                  <span className="text-muted-foreground text-xs">
                    {agentWorking ? "escribiéndose" : "todavía vacío"}
                  </span>
                ) : notices.length > 0 ? (
                  <span className="rounded-full bg-warning/16 px-1.5 text-warning-foreground text-xs tabular-nums">
                    {notices.length}
                  </span>
                ) : null}
              </TabButton>
              <TabButton selected={leftTab === "sources"} onSelect={() => showLeft("sources")}>
                Fuentes
                {dossier ? (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {dossier.evidenceTotal}
                  </span>
                ) : null}
              </TabButton>
              <span className="ms-auto truncate ps-2 text-muted-foreground text-xs">
                {leftTab === "topic"
                  ? model.current === "read"
                    ? "Lee esto primero"
                    : ""
                  : leftTab === "script"
                    ? scriptHint
                    : ""}
              </span>
            </div>
            <div
              ref={readingPane}
              className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both"
              data-testid="map-reading-panel"
            >
              <div className="mx-auto flex max-w-[44rem] flex-col gap-4 px-7 pt-5 pb-16">
                {leftTab === "topic" ? (
                  dossier ? (
                    <TopicPanel
                      dossier={dossier}
                      sources={sources}
                      onOpenSource={openSourceTab}
                      trendLink={trendLink}
                    />
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {dossierState === "none"
                        ? "Este hilo no tiene expediente."
                        : dossierState === "failed"
                          ? "No se pudo cargar el tema."
                          : "Cargando el tema…"}
                    </p>
                  )
                ) : leftTab === "sources" ? (
                  dossier ? (
                    <SourcesPanel sources={sources} onOpenSource={openSourceTab} />
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {dossierState === "failed"
                        ? "No se pudieron cargar las fuentes."
                        : dossierState === "none"
                          ? "Este hilo no tiene expediente."
                          : "Cargando las fuentes…"}
                    </p>
                  )
                ) : (
                  <>
                    {drafted || decided ? (
                      <div className="sticky top-0 z-10 -mx-7 -mt-5 flex flex-col gap-2 bg-background/95 px-7 pt-4 pb-3 backdrop-blur-sm">
                        <div className="flex min-h-7 items-center gap-2 text-muted-foreground text-xs">
                          {decided || model.current === "decide" ? (
                            <LockIcon aria-hidden className="size-3.5" />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate">
                            {decided && script.status === "unsaved"
                              ? `Decidido el ${dateAndTime(video.decision!.decidedAt)} · sin versión guardada`
                              : decided
                                ? `Versión decidida el ${dateAndTime(video.decision!.decidedAt)} · solo lectura`
                                : model.current === "decide"
                                  ? "Esta es la versión que vas a decidir · solo lectura mientras decides"
                                  : agentWorking && drafted
                                    ? "El asistente trabaja en tu pedido · el guion se actualiza cuando termine"
                                    : video.script.head
                                      ? `Versión ${video.script.versionCount} · guardada ${formatSavedAt(video.script.head.savedAt)}${editing ? " · editando a mano, se guarda solo" : ""}`
                                      : drafted
                                        ? "Sin versión guardada todavía"
                                        : ""}
                          </span>
                          {!decided &&
                          model.current !== "decide" &&
                          drafted &&
                          workspaceRoot &&
                          video.script.path ? (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => setEditing(!editing)}
                            >
                              {editing ? <CheckIcon aria-hidden /> : <PencilIcon aria-hidden />}
                              {editing ? "Ver el guion" : "Editar a mano"}
                            </Button>
                          ) : null}
                        </div>
                        {drafted && !editing ? (
                          <NoticeBar
                            notices={notices}
                            activeIndex={noticeIndex}
                            onGo={goToNotice}
                            verifier={
                              verifier
                                ? { claims: verifier.claims, uncited: verifier.uncited.length }
                                : null
                            }
                          />
                        ) : null}
                      </div>
                    ) : null}
                    {scriptPane}
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="flex min-h-0 min-w-0 flex-col border-s" aria-label="Herramientas">
            <div
              className="flex h-11 shrink-0 items-center gap-1 border-b px-3"
              role="tablist"
              data-thread-map-script
            >
              {phase === "work" ? null : (
                <TabButton
                  selected={rightTab === "decision"}
                  onSelect={() => showRight("decision")}
                >
                  {decided ? "Resumen" : "Decisión"}
                </TabButton>
              )}
              <TabButton
                selected={rightTab === "assistant"}
                onSelect={() => showRight("assistant")}
              >
                Asistente
              </TabButton>
              {source ? (
                <TabButton
                  selected={rightTab === "source"}
                  onSelect={() => showRight("source")}
                  onClose={() => {
                    setOpenSource(null);
                    if (rightTab === "source") showRight(defaultRight);
                  }}
                  closeLabel={`Cerrar la fuente ${source.number}`}
                >
                  Fuente {source.number}
                </TabButton>
              ) : null}
              <TabButton selected={rightTab === "details"} onSelect={() => showRight("details")}>
                Detalles del hilo
              </TabButton>
              <span className="ms-auto truncate ps-2 text-muted-foreground text-xs">
                {rightTab === "assistant" && modelLabel && source === null ? modelLabel : ""}
              </span>
            </div>

            <div
              data-map-conversation
              className={cn(
                "min-h-0 flex-1 flex-col",
                rightTab === "assistant" ? "flex" : "hidden",
              )}
            >
              {composerOffer?.phase === "welcome" || decided ? null : (
                <p
                  className="flex shrink-0 items-center gap-2 border-b bg-card/40 px-4 py-2 text-muted-foreground text-xs"
                  data-thread-map-script
                >
                  <CheckIcon aria-hidden className="size-3.5 shrink-0 text-success" />
                  Ya tiene la ficha y{" "}
                  {dossier ? `sus ${dossier.evidenceTotal} fuentes` : "sus fuentes"}, numeradas como
                  aquí.
                </p>
              )}
              {children}
            </div>

            {rightTab === "source" && source ? (
              <SourceBrowser
                threadRef={threadRef}
                source={source}
                sources={sources}
                visible
                occurrence={occurrence}
                onSource={openSourceTab}
                onOccurrence={goToOccurrence}
                onBack={() => showRight("assistant")}
              />
            ) : null}

            {rightTab === "decision" && phase !== "work" ? (
              <div className="min-h-0 flex-1 overflow-y-auto" data-thread-map-script>
                <div className="flex flex-col gap-5 p-5">
                  <VideoDecisionPanel
                    plainVersion
                    video={video}
                    draft={outcome.decisionDraft}
                    refusedHash={outcome.refusedHash}
                    notice={outcome.decisionNotice}
                    controls={outcome.decision}
                    pending={pending}
                  />
                  {decided ? (
                    <section
                      aria-label="Después de publicar"
                      className="flex flex-col gap-2 rounded-lg border p-3.5"
                    >
                      <h3 className="font-medium text-2xs text-muted-foreground uppercase tracking-wider">
                        Después de publicar
                      </h3>
                      <p className="text-sm">
                        Anota las métricas del video. Puedes volver a anotarlas otro día.
                      </p>
                      <div className="-mx-2.5">
                        <VideoResultForm
                          results={video.results}
                          draft={outcome.resultDraft}
                          controls={outcome.result}
                        />
                      </div>
                    </section>
                  ) : null}
                </div>
              </div>
            ) : null}

            {rightTab === "details" ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="p-5">
                  <ThreadDetailsCard
                    video={video}
                    receivedAtMs={receivedAtMs}
                    trend={
                      <>
                        <span className="block">{video.thread.trendTitle ?? "Sin título"}</span>
                        <span className="text-muted-foreground text-xs">
                          {dossier?.run.cutoffAt
                            ? `Corrida del ${sourceDay(dossier.run.cutoffAt)} · `
                            : ""}
                          {trendLink}
                        </span>
                      </>
                    }
                    modelLabel={modelLabel}
                    sourceCount={dossier?.evidenceTotal ?? null}
                    citedCount={sources.filter((entry) => entry.uses > 0).length}
                    busy={busy}
                    onToggleCohort={() =>
                      void run(() => commands.setCohort(trial ? "human" : "trial"))
                    }
                  />
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </VideoComposerContext>
  );
}
