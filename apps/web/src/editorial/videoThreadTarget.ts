import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";

import { sortScopedProjectsForSidebar } from "../components/Sidebar.logic";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProjects, readThreadShells } from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";

export interface VideoThreadTarget {
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}

/**
 * Where "Crear hilo de video" opens the thread: the environment's most recently used project,
 * as the root page picks it for a new draft, with the model and runtime mode a new thread
 * there would get. `null` when the environment has no project or no usable model.
 */
export function resolveVideoThreadTarget(environmentId: EnvironmentId): VideoThreadTarget | null {
  const projects = readProjects().filter((project) => project.environmentId === environmentId);
  const project = sortScopedProjectsForSidebar(projects, readThreadShells(), "updated_at")[0];
  if (project === undefined) return null;
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const settings = config?.settings ?? DEFAULT_SERVER_SETTINGS;
  const providers = config?.providers ?? [];
  const projectSettings = resolveProjectSettings(settings, project.id, project).settings;
  const { selection } = resolveNewThreadModelSelection({
    defaultSelection:
      projectSettings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(providers, settings, project.id),
    fallbackSelection: settings.fallbackModelSelection ?? null,
    providers,
    settings,
    projectId: project.id,
    now: Date.now(),
  });
  if (selection === null) return null;
  return {
    projectId: project.id,
    modelSelection: selection,
    runtimeMode: projectSettings.defaultRuntimeMode,
  };
}
