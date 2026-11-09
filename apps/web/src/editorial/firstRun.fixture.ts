import {
  EDITORIAL_JOB_PHASES,
  type EditorialJob,
  type EditorialJobPhase,
  type EditorialNightlySettings,
} from "@t3tools/contracts";

/** Jobs of the first run in each state, for the logic and browser tests. */
export const NIGHTLY_OFF: EditorialNightlySettings = {
  enabled: false,
  timeOfDay: "03:00",
  timezone: "America/Guayaquil",
  workers: 2,
  nextRunAt: null,
  engineConfig: "engine.v1.json",
  engineConfigChosenAt: null,
  engineConfigs: ["engine.v1.json", "engine.v2.json", "engine.v3.json"],
};

export const NIGHTLY_ON: EditorialNightlySettings = {
  ...NIGHTLY_OFF,
  enabled: true,
  nextRunAt: "2026-11-03T08:00:00.000Z",
};

export const phasesWith = (
  status: (index: number) => EditorialJobPhase["status"],
): ReadonlyArray<EditorialJobPhase> =>
  EDITORIAL_JOB_PHASES.map((phase, index) => {
    const value = status(index);
    return {
      phase,
      status: value,
      startedAt: value === "pending" ? null : `2026-11-02T23:0${index}:00.000Z`,
      finishedAt:
        value === "pending" || value === "running" ? null : `2026-11-02T23:0${index}:40.000Z`,
      note: null,
      log: null,
    };
  });

export const makeJob = (
  overrides: Partial<Omit<EditorialJob, "artifacts">> & {
    readonly artifacts?: Partial<EditorialJob["artifacts"]>;
  } = {},
): EditorialJob => ({
  jobId: "job-1",
  kind: "daily",
  profileHash: "sha256:profile",
  cutoffAt: "2026-11-02T00:00:00.000Z",
  configHash: "sha256:config",
  timezone: "America/Guayaquil",
  scheduledFor: "2026-11-02T23:00:00.000Z",
  startedAt: "2026-11-02T23:00:00.000Z",
  finishedAt: null,
  attempt: 1,
  status: "running",
  error: null,
  ...overrides,
  artifacts: {
    jobDir: "/state/editorial-jobs/job-1",
    corpusDir: "/data/corpus",
    runsDir: "/data/runs",
    sources: { collect: ["hn", "github"], rank: ["hn", "github"] },
    phases: phasesWith(() => "pending"),
    collect: null,
    runId: null,
    runDir: null,
    dossiers: null,
    presentations: null,
    notes: [],
    notices: [],
    failure: null,
    progress: null,
    ...overrides.artifacts,
  },
});

const COLLECTED = {
  sources: ["hn", "github"],
  fromDay: "2026-10-31",
  toDay: "2026-11-02",
  items: 1284,
  incomplete: 0,
  missedDays: [],
} as const;

/** Capture done, the engine embedding texts. */
export const RUNNING_JOB = makeJob({
  artifacts: {
    phases: phasesWith((index) => (index === 0 ? "done" : index === 1 ? "running" : "pending")),
    collect: COLLECTED,
    progress: { phase: "run", done: 3072, total: 11913 },
  },
});

/** The engine failed; the scheduler gave up after three attempts. */
export const FAILED_JOB = makeJob({
  status: "failed",
  attempt: 3,
  finishedAt: "2026-11-02T23:02:00.000Z",
  error: "engine run exited with 1",
  artifacts: {
    phases: phasesWith((index) => (index === 0 ? "done" : index === 1 ? "failed" : "pending")),
    collect: COLLECTED,
    failure: { code: "engine_failed", phase: "run" },
  },
});

/** Done, with an imported run that formed no trend. */
export const EMPTY_JOB = makeJob({
  status: "done",
  finishedAt: "2026-11-02T23:05:00.000Z",
  artifacts: {
    phases: phasesWith((index) => (index === 4 ? "skipped" : "done")),
    collect: COLLECTED,
    runId: "run_20261102_20261102T230000_abcdef",
    dossiers: 0,
  },
});

/** Done with trends; presentations could not be drafted without a text model. */
export const DONE_JOB = makeJob({
  status: "done",
  finishedAt: "2026-11-02T23:06:00.000Z",
  artifacts: {
    phases: phasesWith((index) => (index === 4 ? "skipped" : "done")),
    collect: COLLECTED,
    runId: "run_20261102_20261102T230000_abcdef",
    dossiers: 15,
    notices: [{ code: "presentations_unavailable" }],
  },
});
