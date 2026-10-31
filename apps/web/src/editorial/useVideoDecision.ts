import type { EditorialVideoState, ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import type { VideoDecisionControls } from "./VideoDecisionPanel";
import type { VideoResultControls } from "./VideoResultForm";
import { flushScriptWrites, useVideoCommands } from "./videoCommands";
import {
  EMPTY_DECISION_DRAFT,
  emptyResultDraft,
  videoFailureReason,
  videoFailureText,
  type DecisionDraft,
  type ResultDraft,
} from "./videoThread.logic";

/**
 * The decision and result blocks of a video thread, the same recording in both modes: drafts,
 * the refused version, and the commands behind them. `run` marks the caller busy while a
 * command is in flight.
 */
export function useVideoDecision(input: {
  readonly threadRef: ScopedThreadRef;
  readonly video: EditorialVideoState;
  readonly workspaceRoot: string | null;
  readonly busy: boolean;
  readonly run: <A>(action: () => Promise<A>) => Promise<A>;
}) {
  const { threadRef, video, workspaceRoot, busy, run } = input;
  const commands = useVideoCommands(threadRef);
  const [decisionDraft, setDecisionDraft] = useState<DecisionDraft>(EMPTY_DECISION_DRAFT);
  const [refusedHash, setRefusedHash] = useState<string | null | undefined>(undefined);
  const [resultDraft, setResultDraft] = useState<ResultDraft>(() => emptyResultDraft());
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  /** The clock state the block already asked to leave, so focus and pointer ask once. */
  const engagedSince = useRef<string | null>(null);
  const scriptPath = video.script.path;

  const decision: VideoDecisionControls = {
    busy,
    onDraftChange: setDecisionDraft,
    // Deciding starts when the operator turns to the block, not when the form is sent;
    // the server still opens Decidir on submission if this never ran.
    onEngage: () => {
      const state = video.clock.state;
      if (state._tag !== "idle" && state.stage === "decide") return;
      // A stopped clock (after a recovery is resolved) has no `since`; the view's time
      // stands in, so focus and pointer still ask once per view.
      const key = state._tag === "idle" ? `idle:${video.clock.asOf}` : state.since;
      if (engagedSince.current === key) return;
      engagedSince.current = key;
      void commands
        .clock(
          state._tag === "idle"
            ? { _tag: "start", stage: "decide" }
            : { _tag: "stage", stage: "decide" },
          null,
        )
        .then((outcome) => {
          if (!outcome.ok) engagedSince.current = null;
        });
    },
    onGoToResolution: (intervalId) =>
      document.getElementById(`video-resolve-${intervalId}`)?.focus(),
    onReviewNewVersion: () => setRefusedHash(undefined),
    onSubmit: (versionHash) =>
      void run(async () => {
        const { action, utility, reason } = decisionDraft;
        if (action === null || utility === null) return;
        setDecisionNotice(null);
        // The editor autosaves after a pause: what is on screen may not be on disk yet.
        // Write it, wait for the server, and decide only if the version is still the one
        // the operator read.
        if (workspaceRoot !== null && scriptPath !== null) {
          const written = await flushScriptWrites({
            environmentId: threadRef.environmentId,
            cwd: workspaceRoot,
            relativePath: scriptPath,
          });
          if (!written) {
            setDecisionNotice(
              "No se pudo guardar el guion con tus últimos cambios. No se registró la decisión; revisa el editor y vuelve a intentarlo.",
            );
            return;
          }
        }
        if (video.script.exists || video.script.head !== null) {
          const snapshot = await commands.saveScript(null);
          if (!snapshot.ok) {
            if (snapshot.error !== null) setDecisionNotice(videoFailureText(snapshot.error));
            return;
          }
          if ((snapshot.state.script.head?.contentHash ?? null) !== versionHash) {
            setRefusedHash(versionHash);
            return;
          }
        }
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
  };

  const result: VideoResultControls = {
    busy,
    onDraftChange: setResultDraft,
    onSubmit: (metrics) =>
      void run(async () => {
        const outcome = await commands.saveResult(metrics);
        if (outcome.ok) setResultDraft(emptyResultDraft());
      }),
  };

  return { commands, decisionDraft, refusedHash, decisionNotice, resultDraft, decision, result };
}
