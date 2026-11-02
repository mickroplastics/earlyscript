import type { EditorialNightlySettings } from "@t3tools/contracts";

/** "03:00, hora de America/Guayaquil"; "03:00 UTC" for the UTC zones. */
export function scheduleText(timeOfDay: string, timezone: string): string {
  if (timezone === "UTC" || timezone === "Etc/UTC" || timezone === "Etc/GMT") {
    return `${timeOfDay} UTC`;
  }
  return `${timeOfDay}, hora de ${timezone.replaceAll("_", " ")}`;
}

/** What the wizard stores as the dated decision of the «Motor y nocturna» step. */
export interface EngineStepAcceptance {
  readonly nightlyEnabled: boolean;
  readonly timeOfDay: string;
  readonly timezone: string;
  /** A job was started from this step, or one was already in flight. */
  readonly firstRunStarted: boolean;
  readonly modelReady: boolean;
}

export function engineStepAcceptance(
  settings: Pick<EditorialNightlySettings, "enabled" | "timeOfDay" | "timezone">,
  state: { readonly firstRunStarted: boolean; readonly modelReady: boolean },
): EngineStepAcceptance {
  return {
    nightlyEnabled: settings.enabled,
    timeOfDay: settings.timeOfDay,
    timezone: settings.timezone,
    firstRunStarted: state.firstRunStarted,
    modelReady: state.modelReady,
  };
}

/** Under the first-run button while the local model is missing. */
export const MODEL_MISSING_TEXT =
  "Primero descarga el modelo local de arriba: el motor lo usa para agrupar las publicaciones.";
