import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EditorialVideoClockCommand,
  EditorialVideoDecideInput,
  EditorialVideoSaveResultInput,
  EditorialVideoState,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { flushFileSaveSession, type FileSaveTarget } from "../components/files/fileSaveSessions";
import { toastManager } from "../components/ui/toast";
import { randomUUID } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProject, useQuietThreadShell } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { videoFailureText } from "./videoThread.logic";
import { editorialVideoEnvironment } from "./videoState";

export type VideoCommandOutcome =
  | { readonly ok: true; readonly state: EditorialVideoState }
  | { readonly ok: false; readonly error: unknown };

function outcomeOf(
  result: AtomCommandResult<EditorialVideoState, unknown>,
  failureTitle: string | null,
): VideoCommandOutcome {
  if (result._tag === "Success") return { ok: true, state: result.value };
  if (isAtomCommandInterrupted(result)) return { ok: false, error: null };
  const error = squashAtomCommandFailure(result);
  if (failureTitle !== null) {
    toastManager.add({ type: "error", title: failureTitle, description: videoFailureText(error) });
  }
  return { ok: false, error };
}

/**
 * The human commands of a video thread. Failures become a toast with the given title, except
 * a decision, whose block shows a refused version itself.
 */
export function useVideoCommands(threadRef: ScopedThreadRef) {
  const options = { reportFailure: false } as const;
  const clock = useAtomCommand(editorialVideoEnvironment.clock, options);
  const saveScript = useAtomCommand(editorialVideoEnvironment.saveScript, options);
  const decide = useAtomCommand(editorialVideoEnvironment.decide, options);
  const saveResult = useAtomCommand(editorialVideoEnvironment.saveResult, options);
  const openVersion = useAtomCommand(editorialVideoEnvironment.openVersion, options);
  const { environmentId, threadId } = threadRef;
  return {
    clock: async (command: EditorialVideoClockCommand, failureTitle: string | null) =>
      outcomeOf(
        await clock({
          environmentId,
          input: { threadId, command, operationId: randomUUID() },
        }),
        failureTitle,
      ),
    saveScript: async (failureTitle: string | null) =>
      outcomeOf(await saveScript({ environmentId, input: { threadId } }), failureTitle),
    decide: async (input: Omit<EditorialVideoDecideInput, "threadId" | "operationId">) =>
      outcomeOf(
        await decide({
          environmentId,
          input: { ...input, threadId, operationId: randomUUID() },
        }),
        null,
      ),
    /** Opens the read-only copy of a saved version in the file surface. */
    openVersion: async (contentHash: string) => {
      const result = await openVersion({ environmentId, input: { threadId, contentHash } });
      if (result._tag === "Success") {
        useRightPanelStore.getState().openFile(threadRef, result.value.path);
      } else if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "No se abrió la versión decidida",
          description: videoFailureText(squashAtomCommandFailure(result)),
        });
      }
    },
    saveResult: async (input: Omit<EditorialVideoSaveResultInput, "threadId">) =>
      outcomeOf(
        await saveResult({ environmentId, input: { ...input, threadId } }),
        "No se guardó el resultado",
      ),
  };
}

/** The folder the file surface reads the thread's files from: its worktree, else the project. */
export function useThreadWorkspaceRoot(threadRef: ScopedThreadRef): string | null {
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  return thread?.worktreePath ?? project?.workspaceRoot ?? null;
}

/** Longest wait for the editor's pending write of the script before a decision gives up. */
const SCRIPT_WRITE_TIMEOUT_MS = 15_000;

/**
 * Writes the editor's pending draft of the script now and waits for the server to confirm it,
 * so a decision never snapshots a file behind the text on screen. False when the write failed,
 * was not allowed or did not land in time; the decision must not be sent then.
 */
export function flushScriptWrites(target: FileSaveTarget): Promise<boolean> {
  return Promise.race([
    flushFileSaveSession(target),
    new Promise<boolean>((resolve) =>
      window.setTimeout(() => resolve(false), SCRIPT_WRITE_TIMEOUT_MS),
    ),
  ]);
}

/** Headings `@earlyscript/editorial-script` expects, in order. Scripts are written in English. */
const SCRIPT_TEMPLATE = "# Hook\n\n# Block 1\n\n# Close\n\n# Sources\n";

/**
 * Opens the script in the existing file surface. A script not written yet is created from the
 * template first, after asking the server again, so a file the agent just wrote is never
 * overwritten by a stale view.
 */
export async function openScript(
  threadRef: ScopedThreadRef,
  workspaceRoot: string,
  scriptPath: string,
): Promise<void> {
  const target = { cwd: workspaceRoot, relativePath: scriptPath };
  const read = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId: threadRef.environmentId,
      input: { ...target, allowMissing: true },
    }),
    { refresh: true, reportFailure: false, reportDefect: false },
  );
  if (read._tag === "Success" && read.value.exists === false) {
    const written = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.writeFile,
      { environmentId: threadRef.environmentId, input: { ...target, contents: SCRIPT_TEMPLATE } },
      { reportFailure: false },
    );
    if (written._tag === "Failure" && !isAtomCommandInterrupted(written)) {
      toastManager.add({
        type: "error",
        title: "No se creó el guion",
        description: videoFailureText(squashAtomCommandFailure(written)),
      });
      return;
    }
  }
  useRightPanelStore.getState().openFile(threadRef, scriptPath);
}

/** Quiet time after the editor's last confirmed save before a version is taken. */
const SCRIPT_VERSION_IDLE_MS = 2_000;

/**
 * Takes a script version each time the editor's saves of the script settle. The file surface
 * autosaves every half second while typing; a version per pause in the writing keeps the
 * history readable. Leaving the thread takes the pending version at once. The server hashes
 * the file itself, so a repeated version is a no-op.
 */
export function useScriptAutoVersion(input: {
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string | null;
  readonly scriptPath: string | null;
  readonly enabled: boolean;
  readonly saveScript: () => Promise<unknown>;
}): void {
  const { environmentId } = input.threadRef;
  const { workspaceRoot, scriptPath, enabled } = input;
  const saveScript = useEffectEvent(input.saveScript);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the editor's write confirmations, which live in an atom outside React, and schedules the version RPC
  useEffect(() => {
    if (!enabled || workspaceRoot === null || scriptPath === null) return;
    const atom = projectEnvironment.optimisticFile({
      environmentId,
      cwd: workspaceRoot,
      relativePath: scriptPath,
    });
    let timer: number | undefined;
    let lastConfirmed: string | null = null;
    const take = () => {
      timer = undefined;
      void saveScript();
    };
    const unsubscribe = appAtomRegistry.subscribe(atom, (value) => {
      // Only a write the server confirmed; the draft in between is not on disk yet.
      if (value === null || value.confirmedAgainst === undefined) return;
      if (value.data.contents === lastConfirmed) return;
      lastConfirmed = value.data.contents;
      window.clearTimeout(timer);
      timer = window.setTimeout(take, SCRIPT_VERSION_IDLE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== undefined) {
        window.clearTimeout(timer);
        take();
      }
    };
  }, [enabled, environmentId, workspaceRoot, scriptPath]);
}
