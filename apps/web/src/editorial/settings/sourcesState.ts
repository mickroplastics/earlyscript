import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { EDITORIAL_SOURCES_WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:editorial:sources",
  tag: EDITORIAL_SOURCES_WS_METHODS.list,
  staleTimeMs: 60_000,
});

const refreshList = (
  { environmentId }: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.refresh(list({ environmentId, input: {} })));

/** Source switches, feeds and last captures per environment. A write refreshes the list. */
export const editorialSourcesEnvironment = {
  list,
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:sources-update",
    tag: EDITORIAL_SOURCES_WS_METHODS.update,
    onSuccess: refreshList,
  }),
  validateFeed: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:sources-validate-feed",
    tag: EDITORIAL_SOURCES_WS_METHODS.validateFeed,
  }),
  addFeed: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:sources-add-feed",
    tag: EDITORIAL_SOURCES_WS_METHODS.addFeed,
    onSuccess: refreshList,
  }),
  removeFeed: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:sources-remove-feed",
    tag: EDITORIAL_SOURCES_WS_METHODS.removeFeed,
    onSuccess: refreshList,
  }),
  setDefaultFeedExcluded: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:editorial:sources-default-feed",
    tag: EDITORIAL_SOURCES_WS_METHODS.setDefaultFeedExcluded,
    onSuccess: refreshList,
  }),
};
