import type { EditorialNightlySettings } from "@t3tools/contracts";

/** What the wizard stores as the dated decision of the «Revisión nocturna» step. */
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
