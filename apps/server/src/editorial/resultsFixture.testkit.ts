import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { WorkClockService } from "./WorkClockService.ts";
import type { DecisionAction, VideoThreadMode, WorkStage } from "./persistence/EditorialModel.ts";
import { nowIso } from "./persistence/support.ts";

// Six closed video threads, three assisted and three manual, written through the editorial
// services under the TestClock: the same commands the app runs, never SQL by hand.

/** Four claims, all cited (the validator's own `valid` fixture). */
export const FULLY_CITED_SCRIPT = `# Hook

Developers now discuss local models [itm_hn_50061234].

# Block 1 · Evidence

The repository contains reproducible examples. The examples include installation commands [itm_github_987].

# Close

Review the evidence before choosing [itm_hn_50061234, itm_github_987].

# Sources

[itm_hn_50061234]
[itm_github_987]
`;

/** Five claims, three cited: the second block has no citation. */
export const PARTLY_CITED_SCRIPT = `# Hook

Agent harnesses now ship with evaluation suites [itm_hn_50061234].

# Block 1 · Evidence

The benchmark repository gained a new leaderboard [itm_github_987].

# Block 2 · Practice

Most teams still grade agents by hand. Manual grading takes most of a week.

# Close

Compare both suites before adopting one [itm_hn_50061234].
`;

type Step = { readonly stage: WorkStage; readonly minutes: number } | { readonly pause: number };

export interface FixtureThread {
  readonly threadId: string;
  readonly mode: VideoThreadMode;
  readonly trendKey?: string;
  readonly steps: ReadonlyArray<Step>;
  readonly script: string;
  readonly action: DecisionAction;
  readonly utility: number;
  readonly reason?: string;
  readonly views?: number;
  /** Minutes between threads, before this one starts. */
  readonly gapMinutes: number;
}

export const FIXTURE_START = Date.parse("2026-10-20T13:00:00.000Z");

const FIXTURE_THREADS: ReadonlyArray<FixtureThread> = [
  {
    threadId: "thread-assisted-1",
    mode: "assisted",
    trendKey: "trend:local-models",
    steps: [
      { stage: "read", minutes: 8 },
      { stage: "write", minutes: 12 },
      { pause: 5 },
      { stage: "write", minutes: 10 },
      { stage: "decide", minutes: 3 },
    ],
    script: FULLY_CITED_SCRIPT,
    action: "accept",
    utility: 4,
    views: 1240,
    gapMinutes: 0,
  },
  {
    threadId: "thread-manual-1",
    mode: "manual",
    steps: [
      { stage: "explore", minutes: 30 },
      { pause: 10 },
      { stage: "explore", minutes: 15 },
      { stage: "write", minutes: 50 },
      { stage: "decide", minutes: 5 },
    ],
    script: PARTLY_CITED_SCRIPT,
    action: "accept",
    utility: 3,
    gapMinutes: 24 * 60,
  },
  {
    threadId: "thread-assisted-2",
    mode: "assisted",
    trendKey: "trend:agent-evals",
    steps: [
      { stage: "read", minutes: 10 },
      { stage: "write", minutes: 30 },
      { stage: "decide", minutes: 2 },
    ],
    script: PARTLY_CITED_SCRIPT,
    action: "edit",
    utility: 5,
    reason: "Reescribí el gancho.",
    gapMinutes: 24 * 60,
  },
  {
    threadId: "thread-manual-2",
    mode: "manual",
    steps: [
      { stage: "explore", minutes: 60 },
      { stage: "write", minutes: 40 },
      { stage: "decide", minutes: 3 },
    ],
    script: FULLY_CITED_SCRIPT,
    action: "edit",
    utility: 2,
    reason: "Faltaban fuentes del segundo bloque.",
    gapMinutes: 24 * 60,
  },
  {
    threadId: "thread-assisted-3",
    mode: "assisted",
    trendKey: "trend:wasm-runtimes",
    steps: [
      { stage: "explore", minutes: 4 },
      { stage: "read", minutes: 6 },
      { stage: "write", minutes: 26 },
      { stage: "decide", minutes: 4 },
    ],
    script: FULLY_CITED_SCRIPT,
    action: "reject",
    utility: 3,
    reason: "El canal ya cubrió el tema.",
    gapMinutes: 24 * 60,
  },
  {
    threadId: "thread-manual-3",
    mode: "manual",
    steps: [
      { stage: "explore", minutes: 38 },
      { stage: "write", minutes: 55 },
      { stage: "decide", minutes: 4 },
    ],
    script: FULLY_CITED_SCRIPT,
    action: "accept",
    utility: 4,
    views: 860,
    gapMinutes: 24 * 60,
  },
];

const advance = (minutes: number) => TestClock.adjust(Duration.minutes(minutes));

/** Runs one thread from registration to decision; leaves the clock where it ended. */
export const runFixtureThread = Effect.fn("runFixtureThread")(function* (thread: FixtureThread) {
  const threads = yield* EditorialThreadService;
  const clock = yield* WorkClockService;
  const commands = yield* EditorialCommandService;

  yield* threads.registerVideoThread({
    operationId: `op-${thread.threadId}`,
    environmentId: "env-fixture",
    threadId: thread.threadId,
    mode: thread.mode,
    trendKey: thread.trendKey,
  });
  let current: WorkStage | undefined;
  let paused = false;
  for (const step of thread.steps) {
    if ("pause" in step) {
      yield* clock.pause(thread.threadId, { reason: "fixture" });
      paused = true;
      yield* advance(step.pause);
      continue;
    }
    if (current === undefined) yield* clock.start(thread.threadId, step.stage);
    else if (paused && current === step.stage) yield* clock.resume(thread.threadId);
    else if (current !== step.stage) yield* clock.changeStage(thread.threadId, step.stage);
    paused = false;
    current = step.stage;
    yield* advance(step.minutes);
  }
  const version = yield* commands.saveScriptVersion({
    threadId: thread.threadId,
    content: thread.script,
  });
  const decision = yield* commands.recordDecision({
    threadId: thread.threadId,
    action: thread.action,
    utility: thread.utility,
    reason: thread.reason,
    scriptVersionHash: version.contentHash,
  });
  if (thread.views !== undefined) {
    // Observed three days after the decision, then recorded by hand.
    yield* advance(3 * 24 * 60);
    yield* commands.saveResult({
      threadId: thread.threadId,
      views: thread.views,
      observedAt: yield* nowIso,
    });
  }
  return decision;
});

/** The six threads plus inbox state: read, snoozed, dismissed and linked trends. */
export const seedResultsFixture = Effect.gen(function* () {
  const commands = yield* EditorialCommandService;
  yield* TestClock.setTime(FIXTURE_START);
  for (const thread of FIXTURE_THREADS) {
    yield* advance(thread.gapMinutes);
    yield* runFixtureThread(thread);
  }
  const cutoff = "2026-10-19T00:00:00.000Z";
  const read = [
    "trend:local-models",
    "trend:agent-evals",
    "trend:wasm-runtimes",
    "trend:rust-gui",
    "trend:edge-databases",
    "trend:ai-pair-review",
  ];
  for (const trendKey of read) {
    yield* commands.markRead({ trendKey, runId: "run-fixture", runCutoffAt: cutoff });
  }
  yield* commands.snooze({ trendKey: "trend:rust-gui", until: "2026-11-15T00:00:00.000Z" });
  yield* commands.dismiss({ trendKey: "trend:edge-databases", reason: "Fuera del perfil." });
  yield* commands.dismiss({ trendKey: "trend:ai-pair-review", reason: "Repetido." });
  for (const thread of FIXTURE_THREADS) {
    if (thread.trendKey !== undefined) {
      yield* commands.linkProduction({ trendKey: thread.trendKey, threadId: thread.threadId });
    }
  }
});
