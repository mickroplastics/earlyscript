import type {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  EditorialTrendSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { editorialEnvironment } from "./state";
import { resolveVideoThreadTarget } from "./videoThreadTarget";

/** What an inbox action needs of a trend; `trendKey` is absent only from older servers. */
export type ActionableTrend = Pick<EditorialTrendSummary, "trendKey" | "runId" | "dossierId">;

function failureMessage(result: AtomCommandResult<unknown, unknown>): string {
  if (AsyncResult.isSuccess(result)) return "";
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Ocurrió un error.";
}

/**
 * The three exits of a trend and their way back, shared by the inbox rows and the dossier.
 * Each returns whether the server accepted it and reports a failure as a toast.
 */
export function useTrendActions(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  const options = { reportFailure: false } as const;
  const markRead = useOrchestrationCommand(editorialEnvironment.markRead, options);
  const snooze = useOrchestrationCommand(editorialEnvironment.snooze, options);
  const unsnooze = useOrchestrationCommand(editorialEnvironment.unsnooze, options);
  const dismiss = useOrchestrationCommand(editorialEnvironment.dismiss, options);
  const reopen = useOrchestrationCommand(editorialEnvironment.reopen, options);
  const createVideo = useOrchestrationCommand(editorialEnvironment.createVideo, options);

  const settle = (result: AtomCommandResult<unknown, unknown>, failureTitle: string) => {
    if (AsyncResult.isSuccess(result)) return true;
    if (!Cause.hasInterruptsOnly(result.cause)) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: failureMessage(result),
      });
    }
    return false;
  };

  return {
    /** Opening a dossier; silent, as visiting a thread is. */
    markRead: async (input: {
      readonly trendKey: EditorialTrendKey;
      readonly runId: EditorialRunId;
      readonly dossierId: EditorialDossierId;
    }) => AsyncResult.isSuccess(await markRead({ environmentId, input })),

    /** Without `until` the server waits for growth; with it, for that time. */
    keepWatching: async (
      trendKey: EditorialTrendKey,
      until?: { readonly snoozedUntil: string; readonly whenLabel?: string },
    ) => {
      const accepted = settle(
        await snooze({
          environmentId,
          input: until === undefined ? { trendKey } : { trendKey, until: until.snoozedUntil },
        }),
        "No se pudo dejar en observación",
      );
      if (accepted) {
        toastManager.add({
          type: "success",
          title: "En observación",
          description:
            until === undefined
              ? "Vuelve si crece."
              : `Vuelve ${until.whenLabel ?? "en el plazo elegido"}.`,
        });
      }
      return accepted;
    },

    returnToInbox: async (trendKey: EditorialTrendKey) =>
      settle(
        await unsnooze({ environmentId, input: { trendKey } }),
        "No se pudo volver a la bandeja",
      ),

    dismiss: async (trendKey: EditorialTrendKey, reason: string) => {
      const accepted = settle(
        await dismiss({ environmentId, input: { trendKey, reason } }),
        "No se pudo descartar",
      );
      if (accepted) toastManager.add({ type: "success", title: "Descartada", description: reason });
      return accepted;
    },

    reopen: async (trendKey: EditorialTrendKey) =>
      settle(await reopen({ environmentId, input: { trendKey } }), "No se pudo reabrir"),

    /** Creates the trend's video thread, or finds the one it has, and opens it. */
    createVideo: async (trend: ActionableTrend & { readonly trendKey: EditorialTrendKey }) => {
      const target = resolveVideoThreadTarget(environmentId);
      if (target === null) {
        toastManager.add({
          type: "error",
          title: "No se pudo crear el hilo de video",
          description: "Hace falta un proyecto con un modelo disponible en el espacio Hilos.",
        });
        return false;
      }
      const result = await createVideo({
        environmentId,
        input: {
          trendKey: trend.trendKey,
          runId: trend.runId,
          dossierId: trend.dossierId,
          ...target,
        },
      });
      if (!settle(result, "No se pudo crear el hilo de video") || !AsyncResult.isSuccess(result)) {
        return false;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
      return true;
    },
  };
}

export type TrendActions = ReturnType<typeof useTrendActions>;
