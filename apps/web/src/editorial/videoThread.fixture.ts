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
    deleted: false,
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
  captures: [],
  visits: [],
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

/**
 * A manual thread fourteen minutes into Explorar, with two captures and three pages loaded in
 * the integrated browser; the script does not exist yet.
 */
export const MANUAL_EXPLORING: EditorialVideoState = {
  thread: {
    threadId: "thread-manual",
    mode: "manual",
    launchState: "launched",
    createdAt: "2026-10-31T09:00:00.000Z",
    trendKey: null,
    runId: null,
    dossierId: null,
    trendTitle: null,
    deleted: false,
  },
  clock: {
    state: { _tag: "running", stage: "explore", since: "2026-10-31T09:00:00.000Z" },
    stages: [{ stage: "explore", activeMs: 14 * MINUTE, segments: 1 }],
    activeMs: 14 * MINUTE,
    pausedMs: 0,
    unresolved: [],
    definitive: true,
    asOf: "2026-10-31T09:14:00.000Z",
  },
  script: { path: "videos/manual-31-oct-threadma.md", exists: false, head: null, versionCount: 0 },
  decision: null,
  results: [],
  captures: [
    {
      captureId: "capture-1",
      url: "https://news.ycombinator.com/item?id=50061",
      title: "Google breaks open a bottleneck in quantum computing",
      note: "mucho debate sobre si es real",
      capturedAt: "2026-10-31T09:06:00.000Z",
    },
    {
      captureId: "capture-2",
      url: "https://github.com/trending",
      title: null,
      note: null,
      capturedAt: "2026-10-31T09:11:00.000Z",
    },
  ],
  visits: [
    {
      visitId: "visit-3",
      tabId: "tab-1",
      url: "https://github.com/trending",
      title: "Trending repositories on GitHub today",
      origin: "server",
      visitedAt: "2026-10-31T09:10:00.000Z",
    },
    {
      visitId: "visit-2",
      tabId: "tab-1",
      url: "https://news.ycombinator.com/item?id=50061",
      title: "Google breaks open a bottleneck in quantum computing",
      origin: "server",
      visitedAt: "2026-10-31T09:04:00.000Z",
    },
    {
      visitId: "visit-1",
      tabId: "tab-1",
      url: "https://news.ycombinator.com/",
      title: "Hacker News",
      origin: "server",
      visitedAt: "2026-10-31T09:01:00.000Z",
    },
  ],
};

/** The same thread nine minutes into Escribir, its script saved once. */
export const MANUAL_WRITING: EditorialVideoState = {
  ...MANUAL_EXPLORING,
  clock: {
    ...MANUAL_EXPLORING.clock,
    state: { _tag: "running", stage: "write", since: "2026-10-31T09:22:00.000Z" },
    stages: [
      { stage: "explore", activeMs: 22 * MINUTE, segments: 1 },
      { stage: "write", activeMs: 9 * MINUTE, segments: 1 },
    ],
    activeMs: 31 * MINUTE,
    asOf: "2026-10-31T09:31:00.000Z",
  },
  script: {
    path: "videos/manual-31-oct-threadma.md",
    exists: true,
    head: {
      versionId: "version-m1",
      contentHash: "c0ffee00aa11bb22cc33",
      savedAt: "2026-10-31T09:30:00.000Z",
      claims: 4,
      cited: 3,
    },
    versionCount: 1,
  },
};
