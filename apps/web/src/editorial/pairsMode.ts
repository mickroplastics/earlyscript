import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

// "Modo pares": the setting the operator turns on for the paired comparison (six pairs with
// blind reviewers). While it is on, the app shows no judge opinion and no trace of which arm
// or engine produced a card, so nothing anchors the operator's own utility. Off by default;
// kept in this client's storage, so it survives restarts of the app.

interface PairsModeState {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

const PAIRS_MODE_STORAGE_KEY = "earlyscript:pairs-mode:v1";

export const usePairsModeStore = create<PairsModeState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set((state) => (state.enabled === enabled ? state : { enabled })),
    }),
    {
      name: PAIRS_MODE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);

export const usePairsMode = (): boolean => usePairsModeStore((state) => state.enabled);
