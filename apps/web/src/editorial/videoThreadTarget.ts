import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { resolveAppModelSelectionForInstance } from "../modelSelection";
import {
  getDefaultProviderInstanceModel,
  type ProviderInstanceEntry,
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
  resolveSelectableProviderInstanceEntry,
} from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShells } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";

export interface VideoThreadTarget {
  /** Absent while the environment has no project: the server opens its studio project. */
  readonly projectId?: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  /**
   * Set when an assisted thread takes another provider than the configured default, because
   * that one is disabled, unavailable or out of usage: the toast that says so. Not sent to the
   * server.
   */
  readonly providerNotice?: string;
}

/**
 * The model a manual thread records when no provider offers one. A manual thread never runs
 * its model, so it needs none available; this is the one the server's own first thread gets.
 */
export const MANUAL_THREAD_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
};

/** Why an assisted thread cannot be created, and what to do about it. */
export const NO_MODEL_DESCRIPTION =
  "Ningún proveedor de modelos está disponible. Conecta Codex o Claude en Ajustes › Proveedores; mientras tanto, «Crear hilo manual» funciona sin modelo.";

/** "GPT-6-Astra (Codex)": the catalog's names, or the ids when the catalog has none. */
function describeSelection(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): string {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === selection.model);
  return `${model?.name ?? selection.model} (${provider?.displayName ?? selection.instanceId})`;
}

/**
 * Replaces a default that cannot run: the provider a new thread's composer offers first, and the
 * model the composer picks on switching to it (catalog default after Miguel's order and hidden
 * models, else the first listed). Not the cheapest: the composer shows it before anything is sent.
 */
function replacementSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettings,
  projectId: ProjectId | null,
): ModelSelection | null {
  const fallback = resolveProjectDefaultProviderModelSelection(providers, settings, projectId);
  const entry =
    fallback === null
      ? undefined
      : entries.find((candidate) => candidate.instanceId === fallback.instanceId);
  if (fallback === null || entry === undefined) return fallback;
  const modelSettings: UnifiedSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    ...settings,
    ...resolveModelPreferences(settings),
  };
  const model =
    resolveAppModelSelectionForInstance(entry.instanceId, modelSettings, providers, null) ??
    getDefaultProviderInstanceModel(providers, entry.instanceId);
  return model === undefined ? fallback : { instanceId: entry.instanceId, model };
}

/**
 * The most recent project (none: the server's studio) with a new thread's model and runtime
 * mode. A default whose provider is disabled or unavailable gives way to one that is not, as in
 * the composer (`replacementSelection`), and an assisted target then carries the notice that
 * says so; null only for an assisted thread no provider can run.
 */
export function videoThreadTargetFor(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threadShells: ReadonlyArray<EnvironmentThreadShell>;
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly mode: "assisted" | "manual";
  readonly now: number;
}): VideoThreadTarget | null {
  const { settings, providers } = input;
  const project = sortScopedProjectsForSidebar(input.projects, input.threadShells, "updated_at")[0];
  const projectId = project?.id ?? null;
  const projectSettings = resolveProjectSettings(settings, projectId, project).settings;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  const usable = (selection: ModelSelection | null): selection is ModelSelection =>
    selection !== null &&
    resolveSelectableProviderInstanceEntry(entries, selection.instanceId)?.instanceId ===
      selection.instanceId;
  const configured = projectSettings.defaultModelSelection;
  const { selection } = resolveNewThreadModelSelection({
    defaultSelection: usable(configured)
      ? configured
      : replacementSelection(entries, providers, settings, projectId),
    fallbackSelection: settings.fallbackModelSelection ?? null,
    providers,
    settings,
    projectId,
    now: input.now,
  });
  const modelSelection = usable(selection)
    ? selection
    : input.mode === "manual"
      ? MANUAL_THREAD_MODEL
      : null;
  if (modelSelection === null) return null;
  // A manual thread never runs its model, so the change does not matter there.
  const providerNotice =
    input.mode === "assisted" &&
    configured !== null &&
    configured.instanceId !== modelSelection.instanceId
      ? `Se usará ${describeSelection(providers, modelSelection)} porque ${describeSelection(providers, configured)} no está disponible. Puedes cambiarlo antes de enviar.`
      : undefined;
  return {
    ...(projectId === null ? {} : { projectId }),
    modelSelection,
    runtimeMode: projectSettings.defaultRuntimeMode,
    ...(providerNotice === undefined ? {} : { providerNotice }),
  };
}

/** `videoThreadTargetFor` over the environment's projects and server config. */
export function resolveVideoThreadTarget(
  environmentId: EnvironmentId,
  mode: "manual",
): VideoThreadTarget;
export function resolveVideoThreadTarget(
  environmentId: EnvironmentId,
  mode?: "assisted" | "manual",
): VideoThreadTarget | null;
export function resolveVideoThreadTarget(
  environmentId: EnvironmentId,
  mode: "assisted" | "manual" = "assisted",
): VideoThreadTarget | null {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  return videoThreadTargetFor({
    projects: readProjects().filter((project) => project.environmentId === environmentId),
    threadShells: readThreadShells(),
    settings: config?.settings ?? DEFAULT_SERVER_SETTINGS,
    providers: config?.providers ?? [],
    mode,
    now: Date.now(),
  });
}
