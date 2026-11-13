import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EditorialNightlySettings } from "@t3tools/contracts";

// The first-run card and the wizard's last step word the nightly review with these; they are
// re-exported from NightlyRunSettings.tsx, where they lived.

export function nextRunText(settings: EditorialNightlySettings): string {
  if (!settings.enabled || settings.nextRunAt === null) {
    return "Desactivada. «Ejecutar ahora» sigue disponible.";
  }
  const when = new Intl.DateTimeFormat("es", {
    timeZone: settings.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(settings.nextRunAt));
  return `Próxima: ${when} (${settings.timezone}).`;
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  "no-sources": "Ninguna fuente está activada para el motor (Ajustes › Editorial › Fuentes).",
  unavailable: "Los servicios editoriales no están montados en este servidor.",
  storage: "La base editorial no respondió.",
  "invalid-settings": "El ajuste no es válido.",
};

/** Settings' own wording: the pages there no longer speak of the engine. */
const SETTINGS_ERROR_TEXT: Readonly<Record<string, string>> = {
  ...ERROR_TEXT,
  "no-sources": "Ninguna fuente cuenta para tus tendencias (Ajustes › Fuentes).",
};

function errorText(
  result: AtomCommandResult<unknown, unknown>,
  texts: Readonly<Record<string, string>>,
): string {
  if (result._tag === "Success") return "";
  if (isAtomCommandInterrupted(result)) return "Se canceló.";
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "reason" in error) {
    const text = texts[String(error.reason)];
    if (text) return text;
  }
  return error instanceof Error ? error.message : "Error desconocido.";
}

export const failureText = (result: AtomCommandResult<unknown, unknown>) =>
  errorText(result, ERROR_TEXT);

export const settingsFailureText = (result: AtomCommandResult<unknown, unknown>) =>
  errorText(result, SETTINGS_ERROR_TEXT);
