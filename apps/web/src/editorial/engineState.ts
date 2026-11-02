import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  EDITORIAL_ENGINE_WS_METHODS,
  type EditorialModelError,
  type EditorialModelState,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** The local embedding model per environment: its state on disk and the download in flight. */
export const editorialEngineEnvironment = {
  /** Pushed by the server: the state after a fresh look at the disk, then every change. */
  model: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:editorial:engine-model",
    tag: EDITORIAL_ENGINE_WS_METHODS.watchModel,
  }),
  /** The progress arrives through `model`; the answer only says the download started. */
  prepareModel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:engine-prepare-model",
    tag: EDITORIAL_ENGINE_WS_METHODS.prepareModel,
  }),
};

export const MODEL_NAME = "Qwen3-Embedding-0.6B";

const MiB = 1024 * 1024;

/** "596", "213", "8,4": whole MiB from 10 up, one decimal below. */
export function formatMiB(bytes: number): string {
  const value = bytes / MiB;
  return value.toLocaleString("es", { maximumFractionDigits: value < 10 ? 1 : 0 });
}

/** "12,4 MiB/s", "850 KiB/s". */
export function speedText(bytesPerSecond: number): string {
  if (bytesPerSecond < MiB) {
    return `${Math.round(bytesPerSecond / 1024).toLocaleString("es")} KiB/s`;
  }
  const value = bytesPerSecond / MiB;
  return `${value.toLocaleString("es", { maximumFractionDigits: value < 100 ? 1 : 0, minimumFractionDigits: value < 100 ? 1 : 0 })} MiB/s`;
}

/** "quedan 2 min", "quedan 40 s"; null without a speed. */
export function remainingText(bytesLeft: number, bytesPerSecond: number | null): string | null {
  if (bytesPerSecond === null || bytesPerSecond <= 0) return null;
  const seconds = Math.ceil(bytesLeft / bytesPerSecond);
  if (seconds < 60) return `quedan ${Math.max(1, seconds)} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90
    ? `quedan ${minutes} min`
    : `quedan ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The operator's wording of a download failure; the technical detail stays in the server's model.log. */
function modelErrorText(error: EditorialModelError): string {
  switch (error.code) {
    case "network":
      return "se cortó la conexión con Hugging Face.";
    case "http": {
      const status = /HTTP (\d+)/.exec(error.message)?.[1];
      return `Hugging Face respondió con un error${status === undefined ? "" : ` (HTTP ${status})`}.`;
    }
    case "hash":
      return "un archivo descargado no coincide con la revisión fijada y se descartó.";
    case "disk":
      return "no se pudo escribir el modelo en el disco (espacio o permisos).";
    case "engine_missing":
      return "no se encontró el motor de tendencias en esta instalación.";
    case "engine_failed":
      return "el motor terminó sin completar la operación.";
    case "other":
      return "la descarga se detuvo.";
  }
}

/** What the operator can do about it, in a second, quieter line. */
function modelErrorHint(error: EditorialModelError): string | null {
  switch (error.code) {
    case "network":
      return "Lo descargado se conserva; «Reintentar» sigue desde ahí.";
    case "http":
      return "Prueba más tarde.";
    case "hash":
      return "«Reintentar» lo descarga de nuevo.";
    case "disk":
      return "Libera espacio en el disco de esta máquina y reintenta.";
    case "engine_missing":
      return "Reinstala Earlyscript o revisa EARLYSCRIPT_ENGINE_CLI.";
    case "engine_failed":
    case "other":
      return null;
  }
}

export type ModelCardPhase =
  | { readonly _tag: "checking" }
  | { readonly _tag: "missing"; readonly bytesPresent: number; readonly bytesExpected: number }
  | {
      readonly _tag: "downloading";
      readonly bytesDone: number;
      readonly bytesTotal: number;
      readonly bytesPerSecond: number | null;
    }
  | { readonly _tag: "verifying" }
  | {
      readonly _tag: "failed";
      readonly text: string;
      readonly hint: string | null;
    }
  | {
      readonly _tag: "ready";
      readonly revision: string;
      readonly bytes: number;
      readonly location: string;
    };

/**
 * Whether the wizard may go on: on disk by sizes, no download in flight and no failure.
 * A hash error can come with a `ready` status (sizes match, bytes do not).
 */
export function modelIsReady(state: EditorialModelState | null): boolean {
  return (
    state !== null && state.status === "ready" && state.download === null && state.error === null
  );
}

/** What the card shows for a state; `null` while the first state has not arrived. */
export function modelCardPhase(state: EditorialModelState | null): ModelCardPhase {
  if (state === null) return { _tag: "checking" };
  const download = state.download;
  if (download !== null) {
    // Every byte is there and the engine is hashing the files.
    if (download.bytesTotal > 0 && download.bytesDone >= download.bytesTotal) {
      return { _tag: "verifying" };
    }
    return {
      _tag: "downloading",
      bytesDone: download.bytesDone,
      bytesTotal: download.bytesTotal,
      bytesPerSecond: download.bytesPerSecond,
    };
  }
  if (state.error !== null) {
    return {
      _tag: "failed",
      text: modelErrorText(state.error),
      hint: modelErrorHint(state.error),
    };
  }
  switch (state.status) {
    case "unknown":
      return { _tag: "checking" };
    case "ready":
      return {
        _tag: "ready",
        revision: (state.revision ?? "").slice(0, 8),
        bytes: state.bytesExpected,
        location: state.location ?? "",
      };
    case "missing":
    case "partial":
      return {
        _tag: "missing",
        bytesPresent: state.bytesPresent,
        bytesExpected: state.bytesExpected,
      };
  }
}
