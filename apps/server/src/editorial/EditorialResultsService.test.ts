import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { checkScript } from "@earlyscript/editorial-script";
import type { EditorialDurationStats, EditorialResultsSummary } from "@t3tools/contracts";

import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialCommandService } from "./EditorialCommandService.ts";
import * as EditorialResultsService from "./EditorialResultsService.ts";
import { WorkClockService } from "./WorkClockService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { withEditorialDatabase } from "./persistence/EditorialDatabase.testkit.ts";
import {
  FIXTURE_START,
  FULLY_CITED_SCRIPT,
  PARTLY_CITED_SCRIPT,
  runFixtureThread,
  seedResultsFixture,
} from "./resultsFixture.testkit.ts";

const minutes = (value: number) => Duration.toMillis(Duration.minutes(value));

const withResults = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withEditorialDatabase(effect.pipe(Effect.provide(EditorialResultsService.layer)));

const modeOf = (summary: EditorialResultsSummary, mode: "assisted" | "manual") =>
  summary.modes.find((entry) => entry.mode === mode)!;

const stageOf = (
  summary: EditorialResultsSummary,
  mode: "assisted" | "manual",
  stage: "explore" | "read" | "write" | "decide",
) => modeOf(summary, mode).stages.find((entry) => entry.stage === stage)!.stats;

const inMinutes = (stats: EditorialDurationStats) => ({
  n: stats.n,
  median: stats.medianMs === null ? null : stats.medianMs / minutes(1),
  q1: stats.q1Ms === null ? null : stats.q1Ms / minutes(1),
  q3: stats.q3Ms === null ? null : stats.q3Ms / minutes(1),
});

describe("quantiles", () => {
  it("interpolates between order statistics", () => {
    assert.deepStrictEqual(EditorialResultsService.durationStats([42, 33, 40]), {
      n: 3,
      medianMs: 40,
      q1Ms: 36.5,
      q3Ms: 41,
      minMs: 33,
      maxMs: 42,
    });
    assert.strictEqual(EditorialResultsService.quantile([10, 20, 30, 40], 0.5), 25);
    assert.strictEqual(EditorialResultsService.quantile([7], 0.25), 7);
    assert.deepStrictEqual(EditorialResultsService.durationStats([]), {
      n: 0,
      medianMs: null,
      q1Ms: null,
      q3Ms: null,
      minMs: null,
      maxMs: null,
    });
  });
});

describe("EditorialResultsService", () => {
  it.effect("excludes trials from every human aggregate but keeps decisions, reversibly", () =>
    withResults(
      Effect.gen(function* () {
        yield* seedResultsFixture;
        const service = yield* EditorialResultsService.EditorialResultsService;
        const threads = yield* EditorialThreadService;
        const before = yield* service.summary;
        yield* threads.setCohort("thread-assisted-1", "trial");
        const after = yield* service.summary;
        assert.strictEqual(modeOf(after, "assisted").threads, 2);
        assert.strictEqual(modeOf(after, "assisted").utility.n, 2);
        assert.strictEqual(modeOf(after, "assisted").citations.threads, 2);
        assert.strictEqual(modeOf(after, "assisted").total.n, 2);
        assert.strictEqual(after.trials?.length, 1);
        assert.strictEqual(after.decisionCount, before.decisionCount - 1);
        // The trend linked to the trial thread no longer counts as "en producción".
        assert.strictEqual(after.inbox.production, before.inbox.production - 1);
        const decisions = yield* service.allDecisions;
        assert.strictEqual(decisions.at(-1)?.cohort, "trial");
        yield* threads.setCohort("thread-assisted-1", "human");
        assert.deepStrictEqual((yield* service.summary).modes, before.modes);
      }),
    ),
  );

  it("counts the fixture scripts as the validator does", () => {
    assert.deepStrictEqual(checkScript(FULLY_CITED_SCRIPT).counts, {
      claims: 4,
      cited: 4,
      uncited: 0,
    });
    assert.deepStrictEqual(checkScript(PARTLY_CITED_SCRIPT).counts, {
      claims: 5,
      cited: 3,
      uncited: 2,
    });
  });

  it.effect("is empty and honest without decisions", () =>
    withResults(
      Effect.gen(function* () {
        const results = yield* EditorialResultsService.EditorialResultsService;
        const summary = yield* results.summary;
        assert.strictEqual(summary.decisionCount, 0);
        assert.isNull(summary.firstDecidedAt);
        assert.deepStrictEqual(summary.inbox, {
          read: 0,
          observing: 0,
          dismissed: 0,
          production: 0,
        });
        for (const mode of summary.modes) {
          assert.strictEqual(mode.threads, 0);
          assert.isNull(mode.total.medianMs);
          assert.isNull(mode.utility.mean);
          assert.isNull(mode.citations.ratio);
        }
        assert.deepStrictEqual((yield* results.decisions({})).total, 0);
      }),
    ),
  );

  it.effect("aggregates active time per stage and mode, without pauses", () =>
    withResults(
      Effect.gen(function* () {
        yield* seedResultsFixture;
        const summary = yield* (yield* EditorialResultsService.EditorialResultsService).summary;

        assert.strictEqual(modeOf(summary, "assisted").threads, 3);
        assert.strictEqual(modeOf(summary, "manual").threads, 3);
        assert.strictEqual(summary.decisionCount, 6);

        // Assisted: read 8/10/6, write 22 (a 5 minute pause excluded)/30/26, explore only once.
        assert.deepStrictEqual(inMinutes(stageOf(summary, "assisted", "explore")), {
          n: 1,
          median: 4,
          q1: 4,
          q3: 4,
        });
        assert.deepStrictEqual(inMinutes(stageOf(summary, "assisted", "read")), {
          n: 3,
          median: 8,
          q1: 7,
          q3: 9,
        });
        assert.deepStrictEqual(inMinutes(stageOf(summary, "assisted", "write")), {
          n: 3,
          median: 26,
          q1: 24,
          q3: 28,
        });
        assert.deepStrictEqual(inMinutes(modeOf(summary, "assisted").total), {
          n: 3,
          median: 40,
          q1: 36.5,
          q3: 41,
        });
        // Manual: explore 45 (a 10 minute pause excluded)/60/38; no read stage at all.
        assert.deepStrictEqual(inMinutes(stageOf(summary, "manual", "explore")), {
          n: 3,
          median: 45,
          q1: 41.5,
          q3: 52.5,
        });
        assert.strictEqual(stageOf(summary, "manual", "read").n, 0);
        assert.deepStrictEqual(inMinutes(modeOf(summary, "manual").total), {
          n: 3,
          median: 100,
          q1: 98.5,
          q3: 101.5,
        });

        const comparison = (key: string) => summary.comparisons.find((entry) => entry.key === key)!;
        // Assisted exploring is explore + read: 8, 10 and 4 + 6.
        assert.deepStrictEqual(inMinutes(comparison("explore").assisted), {
          n: 3,
          median: 10,
          q1: 9,
          q3: 10,
        });
        assert.strictEqual(inMinutes(comparison("explore").manual).median, 45);
        assert.strictEqual(inMinutes(comparison("write").manual).median, 50);
        assert.strictEqual(inMinutes(comparison("total").assisted).median, 40);
        assert.deepStrictEqual(comparison("total").partial, { assisted: 0, manual: 0 });
        assert.deepStrictEqual(
          inMinutes(comparison("recorded").manual),
          inMinutes(comparison("total").manual),
        );
      }),
    ),
  );

  it.effect("reports utility, citations, actions, video results and the inbox", () =>
    withResults(
      Effect.gen(function* () {
        yield* seedResultsFixture;
        const summary = yield* (yield* EditorialResultsService.EditorialResultsService).summary;
        const assisted = modeOf(summary, "assisted");
        const manual = modeOf(summary, "manual");

        assert.deepStrictEqual(assisted.utility, { n: 3, mean: 4, distribution: [0, 0, 1, 1, 1] });
        assert.deepStrictEqual(manual.utility, { n: 3, mean: 3, distribution: [0, 1, 1, 1, 0] });
        assert.deepStrictEqual(assisted.actions, { accept: 1, edit: 1, reject: 1 });
        assert.deepStrictEqual(manual.actions, { accept: 2, edit: 1, reject: 0 });
        assert.deepStrictEqual(assisted.citations, {
          threads: 3,
          claims: 13,
          cited: 11,
          ratio: 11 / 13,
        });
        assert.strictEqual(assisted.withVideoResults, 1);
        assert.strictEqual(manual.withVideoResults, 1);
        assert.deepStrictEqual(summary.inbox, {
          read: 6,
          observing: 1,
          dismissed: 2,
          production: 3,
        });
        // 33 active minutes plus the 5 minute pause.
        assert.strictEqual(summary.firstDecidedAt, "2026-10-20T13:38:00.000Z");
        assert.isTrue(Date.parse(summary.firstDecidedAt!) > FIXTURE_START);
      }),
    ),
  );

  it.effect("pages decisions newest first, filtered by mode", () =>
    withResults(
      Effect.gen(function* () {
        yield* seedResultsFixture;
        const results = yield* EditorialResultsService.EditorialResultsService;
        const page = yield* results.decisions({ limit: 4 });
        assert.strictEqual(page.total, 6);
        assert.deepStrictEqual(
          page.decisions.map((decision) => decision.threadId),
          ["thread-manual-3", "thread-assisted-3", "thread-manual-2", "thread-assisted-2"],
        );
        const next = yield* results.decisions({ limit: 4, offset: 4 });
        assert.deepStrictEqual(
          next.decisions.map((decision) => decision.threadId),
          ["thread-manual-1", "thread-assisted-1"],
        );
        const first = next.decisions[1]!;
        assert.deepInclude(first.durations, {
          exploreMs: null,
          readMs: minutes(8),
          writeMs: minutes(22),
          totalMs: minutes(33),
        });
        assert.deepInclude(first.script, { claims: 4, cited: 4 });
        assert.strictEqual(first.video?.views, 1240);

        const manual = yield* results.decisions({ mode: "manual" });
        assert.strictEqual(manual.total, 3);
        assert.isTrue(manual.decisions.every((decision) => decision.mode === "manual"));
      }),
    ),
  );

  it.effect("counts only the latest decision of a thread and leaves unresolved clocks out", () =>
    withResults(
      Effect.gen(function* () {
        const commands = yield* EditorialCommandService;
        const clock = yield* WorkClockService;
        yield* TestClock.setTime(FIXTURE_START);
        yield* runFixtureThread({
          threadId: "thread-twice",
          mode: "assisted",
          steps: [{ stage: "write", minutes: 20 }],
          script: FULLY_CITED_SCRIPT,
          action: "reject",
          utility: 2,
          reason: "Primera lectura.",
          gapMinutes: 0,
        });
        yield* clock.start("thread-twice", "write");
        yield* TestClock.adjust(Duration.minutes(10));
        const rewritten = yield* commands.saveScriptVersion({
          threadId: "thread-twice",
          content: PARTLY_CITED_SCRIPT,
        });
        yield* commands.recordDecision({
          threadId: "thread-twice",
          action: "accept",
          utility: 5,
          scriptVersionHash: rewritten.contentHash,
        });

        // A crash leaves the segment open; recovery flags it and the decision is provisional.
        yield* runFixtureThread({
          threadId: "thread-crash",
          mode: "manual",
          steps: [{ stage: "explore", minutes: 15 }],
          script: FULLY_CITED_SCRIPT,
          action: "accept",
          utility: 4,
          gapMinutes: 0,
        });
        yield* clock.start("thread-crash", "write");
        yield* TestClock.adjust(Duration.minutes(30));
        yield* clock.recoverOpenIntervals();
        const same = yield* commands.saveScriptVersion({
          threadId: "thread-crash",
          content: FULLY_CITED_SCRIPT,
        });
        yield* commands.recordDecision({
          threadId: "thread-crash",
          action: "accept",
          utility: 4,
          scriptVersionHash: same.contentHash,
        });

        const results = yield* EditorialResultsService.EditorialResultsService;
        const summary = yield* results.summary;
        const assisted = modeOf(summary, "assisted");
        assert.strictEqual(assisted.threads, 1);
        assert.deepStrictEqual(assisted.utility.mean, 5);
        assert.strictEqual(assisted.total.medianMs, minutes(30));
        // Citations come from the version the current decision names.
        assert.deepInclude(assisted.citations, { threads: 1, claims: 5, cited: 3 });

        const manual = modeOf(summary, "manual");
        assert.strictEqual(manual.threads, 1);
        assert.strictEqual(manual.provisionalClock, 1);
        assert.strictEqual(manual.total.n, 0);
        assert.strictEqual(manual.utility.n, 1);

        const log = yield* results.decisions({});
        assert.strictEqual(log.total, 4);
        assert.deepStrictEqual(
          log.decisions.map((decision) => [decision.threadId, decision.current]),
          [
            ["thread-crash", true],
            ["thread-crash", false],
            ["thread-twice", true],
            ["thread-twice", false],
          ],
        );
      }),
    ),
  );

  it.effect("names a decision's trend by the latest dossier label of that trend", () =>
    withResults(
      Effect.gen(function* () {
        yield* seedResultsFixture;
        const sql = yield* EditorialSql;
        for (const [runId, label] of [
          ["run_20261019", "local models"],
          ["run_20261020", "local models llama"],
        ] as const) {
          yield* sql`
            INSERT INTO editorial_runs (
              run_id, cutoff_at, finished_at, engine_status, config_hash, logical_hash,
              sources_json, coverage_json, artifact_path, artifact_version, content_hash,
              dossier_count, import_state, skipped_files_json, imported_at, updated_at
            ) VALUES (
              ${runId}, '2026-10-19T00:00:00.000Z', '2026-10-19T00:05:00.000Z', 'ok', 'c', 'l',
              '[]', '{}', '/x', '{}', 'h', 1, 'imported', '[]', '2026-10-19T01:00:00.000Z',
              '2026-10-19T01:00:00.000Z'
            )
          `;
          yield* sql`
            INSERT INTO editorial_dossiers (
              run_id, dossier_id, trend_key, trend_key_rule, file_path, content_hash, label,
              items_7d, items_28d, authors_7d, score, volume_rank, score_rank
            ) VALUES (
              ${runId}, 'd1', 'trend:local-models', 'signal-id', 'd1.json', 'aaaa', ${label},
              5, 9, 3, 0.5, 1, 1
            )
          `;
        }
        const results = yield* EditorialResultsService.EditorialResultsService;
        const { decisions } = yield* results.decisions({});
        const labelOf = (threadId: string) =>
          decisions.find((decision) => decision.threadId === threadId)?.trendLabel;
        assert.strictEqual(labelOf("thread-assisted-1"), "local models llama");
        // A thread its trend never reached a dossier for has no label, never its key.
        assert.isTrue(
          decisions
            .filter((decision) => decision.trendKey !== "trend:local-models")
            .every((decision) => decision.trendLabel === null),
        );
      }),
    ),
  );

  it.effect("keeps a thread with only one stage out of the whole process", () =>
    withResults(
      Effect.gen(function* () {
        yield* seedResultsFixture;
        yield* runFixtureThread({
          threadId: "thread-write-only",
          mode: "assisted",
          steps: [{ stage: "write", minutes: 1 }],
          script: FULLY_CITED_SCRIPT,
          action: "accept",
          utility: 4,
          gapMinutes: 24 * 60,
        });
        const results = yield* EditorialResultsService.EditorialResultsService;
        const summary = yield* results.summary;
        const comparison = (key: string) => summary.comparisons.find((entry) => entry.key === key)!;

        // The whole process keeps the three complete assisted threads: 40 minutes, n = 3.
        assert.deepStrictEqual(inMinutes(comparison("total").assisted), {
          n: 3,
          median: 40,
          q1: 36.5,
          q3: 41,
        });
        assert.strictEqual(comparison("total").partial.assisted, 0);
        // The recorded total takes it in and says so.
        assert.strictEqual(comparison("recorded").assisted.n, 4);
        assert.strictEqual(comparison("recorded").assisted.minMs, minutes(1));
        assert.strictEqual(comparison("recorded").partial.assisted, 1);
        assert.strictEqual(modeOf(summary, "assisted").partialCoverage, 1);
        assert.strictEqual(modeOf(summary, "assisted").total.n, 4);

        const [latest] = (yield* results.decisions({ limit: 1 })).decisions;
        assert.strictEqual(latest!.threadId, "thread-write-only");
        assert.deepStrictEqual(latest!.stages, ["write"]);
        assert.strictEqual(latest!.coverage, "partial");
      }),
    ),
  );

  it("decides coverage from the stages of the mode", () => {
    assert.strictEqual(
      EditorialResultsService.coverageOf("assisted", ["read", "write", "decide"]),
      "complete",
    );
    assert.strictEqual(
      EditorialResultsService.coverageOf("assisted", ["explore", "write", "decide"]),
      "partial",
    );
    assert.strictEqual(
      EditorialResultsService.coverageOf("manual", ["explore", "write", "decide"]),
      "complete",
    );
    assert.strictEqual(EditorialResultsService.coverageOf("manual", ["write"]), "partial");
  });
});
