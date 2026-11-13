import type { EditorialDossierId, EditorialRunId, EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

/** The lists the sidebar switches between. Results is a page and keeps the list it found. */
export type EditorialSpace = "threads" | "trends";

export interface TrendDestination {
  /** `null` follows the latest run. */
  readonly runId: EditorialRunId | null;
  readonly dossierId: EditorialDossierId;
}

export interface EnvironmentSpaceState {
  readonly space: EditorialSpace;
  /** Last dossier opened in Trends, reopened when switching back to the space. */
  readonly trend: TrendDestination | null;
}

interface SpaceStoreState {
  readonly byEnvironment: Readonly<Record<string, EnvironmentSpaceState>>;
  /** Last thread or draft URL; the Threads tab returns there. Threads span every environment. */
  readonly threadsHref: string | null;
  readonly setSpace: (environmentId: EnvironmentId, space: EditorialSpace) => void;
  readonly openTrend: (environmentId: EnvironmentId, trend: TrendDestination) => void;
  readonly setThreadsHref: (href: string) => void;
}

const SPACE_STORAGE_KEY = "earlyscript:space:v1";
const EMPTY_ENVIRONMENT_STATE: EnvironmentSpaceState = { space: "threads", trend: null };

export function selectEnvironmentSpace(
  state: Pick<SpaceStoreState, "byEnvironment">,
  environmentId: EnvironmentId | null,
): EnvironmentSpaceState {
  return (environmentId && state.byEnvironment[environmentId]) || EMPTY_ENVIRONMENT_STATE;
}

/**
 * Version 1 could store `results`, a space until November 2026: it reopens the Threads list.
 * Anything else unknown does the same, so a stored value never leaves the sidebar empty.
 */
export function migrateSpaceState(
  persisted: unknown,
): Pick<SpaceStoreState, "byEnvironment" | "threadsHref"> {
  const state = (persisted ?? {}) as {
    readonly byEnvironment?: Readonly<
      Record<string, { readonly space?: unknown; readonly trend?: TrendDestination | null }>
    >;
    readonly threadsHref?: unknown;
  };
  const byEnvironment = Object.fromEntries(
    Object.entries(state.byEnvironment ?? {}).map(([environmentId, entry]) => {
      const next: EnvironmentSpaceState = {
        space: entry.space === "trends" ? "trends" : "threads",
        trend: entry.trend ?? null,
      };
      return [environmentId, next];
    }),
  );
  return {
    byEnvironment,
    threadsHref: typeof state.threadsHref === "string" ? state.threadsHref : null,
  };
}

/** UI preference only: the URL wins on a deep link; this decides where a space switch goes. */
export const useSpaceStore = create<SpaceStoreState>()(
  persist(
    (set) => ({
      byEnvironment: {},
      threadsHref: null,
      setSpace: (environmentId, space) =>
        set((state) => {
          const current = selectEnvironmentSpace(state, environmentId);
          if (current.space === space) return state;
          return {
            byEnvironment: { ...state.byEnvironment, [environmentId]: { ...current, space } },
          };
        }),
      openTrend: (environmentId, trend) =>
        set((state) => {
          const current = selectEnvironmentSpace(state, environmentId);
          if (
            current.space === "trends" &&
            current.trend?.runId === trend.runId &&
            current.trend.dossierId === trend.dossierId
          ) {
            return state;
          }
          return {
            byEnvironment: {
              ...state.byEnvironment,
              [environmentId]: { space: "trends", trend },
            },
          };
        }),
      setThreadsHref: (href) =>
        set((state) => (state.threadsHref === href ? state : { threadsHref: href })),
    }),
    {
      name: SPACE_STORAGE_KEY,
      version: 2,
      migrate: migrateSpaceState,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byEnvironment: state.byEnvironment,
        threadsHref: state.threadsHref,
      }),
    },
  ),
);
