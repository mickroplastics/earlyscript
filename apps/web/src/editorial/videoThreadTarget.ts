import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShells } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";

export interface VideoThreadTarget {
  /** Absent while the environment has no project: the server opens its studio project. */
  readonly projectId?: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
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

/**
 * Where a video thread opens: the environment's most recently used project, as the root page
 * picks it for a new draft, with the model and runtime mode a new thread there would get; with
 * no project yet, the server's studio project with the global defaults. Null only for an
 * assisted thread no provider can run.
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
  const { selection } = resolveNewThreadModelSelection({
    defaultSelection:
      projectSettings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(providers, settings, projectId),
    fallbackSelection: settings.fallbackModelSelection ?? null,
    providers,
    settings,
    projectId,
    now: input.now,
  });
  const modelSelection = selection ?? (input.mode === "manual" ? MANUAL_THREAD_MODEL : null);
  if (modelSelection === null) return null;
  return {
    ...(projectId === null ? {} : { projectId }),
    modelSelection,
    runtimeMode: projectSettings.defaultRuntimeMode,
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
