import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EDITORIAL_PROFILE_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { bumpInbox } from "../state";

const get = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:profile",
  tag: EDITORIAL_PROFILE_WS_METHODS.get,
  staleTimeMs: 60_000,
});

const history = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:profile-history",
  tag: EDITORIAL_PROFILE_WS_METHODS.history,
  staleTimeMs: 60_000,
});

const refresh = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) =>
  Effect.sync(() => {
    registry.refresh(get({ environmentId, input: {} }));
    registry.refresh(history({ environmentId, input: {} }));
  }).pipe(
    // The profile enters every presentation's input identity: the inbox and dossiers read
    // again so drafts written for the previous version show as out of date.
    Effect.andThen(bumpInbox({ environmentId }, registry)),
  );

/**
 * The studio profile per environment. Saving refreshes the active version, the history and
 * the inbox and dossier reads.
 */
export const editorialProfileEnvironment = {
  get,
  history,
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:profile-update",
    tag: EDITORIAL_PROFILE_WS_METHODS.update,
    onSuccess: refresh,
  }),
};
