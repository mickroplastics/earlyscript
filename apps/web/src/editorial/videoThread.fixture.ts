import type { EditorialVideoState } from "@t3tools/contracts";

const MINUTE = 60_000;

/**
 * An assisted video thread four minutes into writing, after five minutes reading the quantum
 * computing dossier of the 19 October run, with its script saved once.
 */
export const WRITING: EditorialVideoState = {
  thread: {
    threadId: "thread-video",
    mode: "assisted",
    launchState: "launched",
    createdAt: "2026-10-31T13:00:00.000Z",
    trendKey: "sig_69a4b83dd577",
    runId: "run_20261019_20261027T003754_2263f7",
    dossierId: "dos_bbb80d57481e",
    trendTitle: "Computación cuántica: Google, IBM y hardware abierto",
  },
  clock: {
    state: { _tag: "running", stage: "write", since: "2026-10-31T13:05:00.000Z" },
    stages: [
      { stage: "read", activeMs: 5 * MINUTE, segments: 1 },
      { stage: "write", activeMs: 4 * MINUTE, segments: 1 },
    ],
    activeMs: 9 * MINUTE,
    pausedMs: 0,
    unresolved: [],
    definitive: true,
    asOf: "2026-10-31T13:09:00.000Z",
  },
  script: {
    path: "videos/computacion-cuantica-threadvi.md",
    exists: true,
    head: {
      versionId: "version-1",
      contentHash: "9f2c1ab07d3e4c55aa10",
      savedAt: "2026-10-31T13:08:00.000Z",
      claims: 11,
      cited: 10,
    },
    versionCount: 1,
  },
  decision: null,
  results: [],
};

export const DECIDED: EditorialVideoState = {
  ...WRITING,
  clock: { ...WRITING.clock, state: { _tag: "idle" } },
  decision: {
    decisionId: "decision-1",
    action: "edit",
    utility: 4,
    reason: "Evidencia fuerte, falta una voz crítica.",
    scriptVersionHash: "9f2c1ab07d3e4c55aa10",
    durations: {
      exploreMs: null,
      readMs: 5 * MINUTE,
      writeMs: 20 * MINUTE,
      decideMs: 3 * MINUTE,
      totalMs: 28 * MINUTE,
    },
    clockDefinitive: true,
    decidedAt: "2026-10-31T13:28:14.000Z",
  },
};
