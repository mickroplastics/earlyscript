import { checkScript } from "@earlyscript/editorial-script";
import {
  EditorialResultsError,
  type EditorialDurationStats,
  type EditorialResultsComparison,
  type EditorialResultsCoverage,
  type EditorialResultsDecision,
  type EditorialResultsDecisionPage,
  type EditorialResultsDecisionsInput,
  type EditorialResultsMode,
  type EditorialResultsModeSummary,
  type EditorialResultsStage,
  type EditorialResultsSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";

import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { WORK_STAGES } from "./persistence/EditorialModel.ts";
import { nowIso } from "./persistence/support.ts";

const DEFAULT_DECISIONS_LIMIT = 50;
const MODES: ReadonlyArray<EditorialResultsMode> = ["assisted", "manual"];
const SCRIPT_COUNT_CACHE_LIMIT = 500;

export interface EditorialResultsServiceShape {
  readonly summary: Effect.Effect<EditorialResultsSummary, EditorialResultsError>;
  readonly decisions: (
    input: EditorialResultsDecisionsInput,
  ) => Effect.Effect<EditorialResultsDecisionPage, EditorialResultsError>;
  /**
   * Every decision, superseded ones included, most recent first (`decided_at`, then insertion
   * order). For the evidence export, which filters by date and re-derives `current`.
   */
  readonly allDecisions: Effect.Effect<
    ReadonlyArray<EditorialResultsDecision>,
    EditorialResultsError
  >;
}

/**
 * Read-only aggregates for the Results space over `editorial.sqlite`. Descriptive: per mode
 * medians and quartiles of the durations stored with each decision (pauses already excluded
 * by the work clock), operator utility, mechanical citation counts and inbox counters.
 */
export class EditorialResultsService extends Context.Service<
  EditorialResultsService,
  EditorialResultsServiceShape
>()("t3/editorial/EditorialResultsService") {}

/** Quantile by linear interpolation between order statistics (R type 7). */
export const quantile = (sorted: ReadonlyArray<number>, p: number): number | null => {
  if (sorted.length === 0) return null;
  const h = (sorted.length - 1) * p;
  const low = Math.floor(h);
  const lower = sorted[low]!;
  const upper = sorted[Math.min(low + 1, sorted.length - 1)]!;
  return lower + (h - low) * (upper - lower);
};

export const durationStats = (values: ReadonlyArray<number>): EditorialDurationStats => {
  const sorted = [...values].toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    medianMs: quantile(sorted, 0.5),
    q1Ms: quantile(sorted, 0.25),
    q3Ms: quantile(sorted, 0.75),
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
};

/**
 * The stages a mode needs for the whole process. Assisted `explore` is optional: the engine
 * explored and the operator reads the dossier. Manual has no dossier to read.
 */
const COMPLETE_STAGES: Readonly<
  Record<EditorialResultsMode, ReadonlyArray<EditorialResultsStage>>
> = {
  assisted: ["read", "write", "decide"],
  manual: ["explore", "write", "decide"],
};

export const coverageOf = (
  mode: EditorialResultsMode,
  stages: ReadonlyArray<EditorialResultsStage>,
): EditorialResultsCoverage => {
  // A stored mode outside the enum (the table is not STRICT) is never complete.
  const required = COMPLETE_STAGES[mode] as ReadonlyArray<EditorialResultsStage> | undefined;
  return required?.every((stage) => stages.includes(stage)) ? "complete" : "partial";
};

interface DecisionRow {
  readonly decision_id: string;
  readonly thread_id: string;
  readonly environment_id: string;
  readonly mode: EditorialResultsMode;
  readonly trend_key: string | null;
  readonly run_id: string | null;
  readonly dossier_id: string | null;
  readonly action: EditorialResultsDecision["action"];
  readonly utility: number;
  readonly reason: string | null;
  readonly script_version_hash: string | null;
  readonly snapshot: string | null;
  readonly explore_ms: number | null;
  readonly read_ms: number | null;
  readonly write_ms: number | null;
  readonly decide_ms: number | null;
  readonly total_ms: number | null;
  readonly clock_definitive: number;
  readonly decided_at: string;
  readonly is_current: number;
  readonly views: number | null;
  readonly subscribers: number | null;
  readonly clicks: number | null;
  readonly comments: number | null;
  readonly observed_at: string | null;
}

// The current decision of a thread is its latest; earlier ones stay in the log.
const selectDecisions = (
  sql: SqlClient.SqlClient,
  options: {
    readonly currentOnly: boolean;
    readonly mode?: EditorialResultsMode | undefined;
    readonly limit: number;
    readonly offset: number;
  },
) => sql<DecisionRow>`
  SELECT
    d.decision_id, d.thread_id, t.environment_id, t.mode, t.trend_key, t.run_id, t.dossier_id,
    d.action, d.utility, d.reason, d.script_version_hash, v.snapshot,
    d.explore_ms, d.read_ms, d.write_ms, d.decide_ms, d.total_ms, d.clock_definitive,
    d.decided_at,
    d.decision_id = (
      SELECT latest.decision_id FROM editorial_decisions latest
      WHERE latest.thread_id = d.thread_id
      ORDER BY latest.decided_at DESC, latest.rowid DESC LIMIT 1
    ) AS is_current,
    r.views, r.subscribers, r.clicks, r.comments, r.observed_at
  FROM editorial_decisions d
  JOIN editorial_video_threads t ON t.thread_id = d.thread_id
  LEFT JOIN editorial_script_versions v
    ON v.thread_id = d.thread_id AND v.content_hash = d.script_version_hash
  LEFT JOIN editorial_video_results r ON r.result_id = (
    SELECT latest.result_id FROM editorial_video_results latest
    WHERE latest.thread_id = d.thread_id
    ORDER BY latest.observed_at DESC, latest.recorded_at DESC LIMIT 1
  )
  WHERE (${options.mode ?? null} IS NULL OR t.mode = ${options.mode ?? null})
  ${options.currentOnly ? sql`AND is_current = 1` : sql``}
  ORDER BY d.decided_at DESC, d.rowid DESC
  LIMIT ${options.limit} OFFSET ${options.offset}
`;

type ScriptCount = NonNullable<EditorialResultsDecision["script"]>;

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  // Versions are content-addressed, so a hash always counts the same.
  const scriptCounts = new Map<string, ScriptCount | null>();

  const countScript = (hash: string | null, snapshot: string | null): ScriptCount | null => {
    if (hash === null || snapshot === null) return null;
    const cached = scriptCounts.get(hash);
    if (cached !== undefined) return cached;
    let count: ScriptCount | null;
    try {
      const { counts } = checkScript(snapshot);
      count = { versionHash: hash, claims: counts.claims, cited: counts.cited };
    } catch {
      count = null;
    }
    if (scriptCounts.size >= SCRIPT_COUNT_CACHE_LIMIT) scriptCounts.clear();
    scriptCounts.set(hash, count);
    return count;
  };

  const toDecision = (row: DecisionRow): EditorialResultsDecision => {
    const durations = {
      exploreMs: row.explore_ms,
      readMs: row.read_ms,
      writeMs: row.write_ms,
      decideMs: row.decide_ms,
      totalMs: row.total_ms,
    };
    const stages = WORK_STAGES.filter((stage) => stageDuration(durations, stage) !== null);
    return {
      decisionId: row.decision_id,
      threadId: row.thread_id,
      environmentId: row.environment_id,
      mode: row.mode,
      trendKey: row.trend_key,
      runId: row.run_id,
      dossierId: row.dossier_id,
      action: row.action,
      utility: row.utility,
      reason: row.reason,
      decidedAt: row.decided_at,
      current: row.is_current === 1,
      clockDefinitive: row.clock_definitive === 1,
      stages,
      coverage: coverageOf(row.mode, stages),
      durations,
      script: countScript(row.script_version_hash, row.snapshot),
      video:
        row.observed_at === null
          ? null
          : {
              views: row.views,
              subscribers: row.subscribers,
              clicks: row.clicks,
              comments: row.comments,
              observedAt: row.observed_at,
            },
    };
  };

  const unreadable = (operation: string) => (cause: unknown) =>
    Effect.logWarning(`editorial results: ${operation} failed`, { cause }).pipe(
      Effect.andThen(
        Effect.fail(
          new EditorialResultsError({
            reason: "unreadable",
            message: "The editorial database could not be read.",
          }),
        ),
      ),
    );

  const summary: EditorialResultsServiceShape["summary"] = Effect.gen(function* () {
    const rows = yield* selectDecisions(sql, {
      currentOnly: true,
      limit: -1,
      offset: 0,
    });
    const counts = yield* sql<{
      readonly decisions: number;
      readonly first_decided_at: string | null;
      readonly last_decided_at: string | null;
    }>`
      SELECT COUNT(*) AS decisions, MIN(decided_at) AS first_decided_at,
        MAX(decided_at) AS last_decided_at
      FROM editorial_decisions
    `;
    const inbox = yield* sql<{
      readonly read: number;
      readonly observing: number;
      readonly dismissed: number;
      readonly production: number;
    }>`
      SELECT
        COALESCE(SUM(seen_at IS NOT NULL), 0) AS read,
        COALESCE(SUM(snoozed_at IS NOT NULL AND dismissed_at IS NULL), 0) AS observing,
        COALESCE(SUM(dismissed_at IS NOT NULL), 0) AS dismissed,
        COALESCE(SUM(production_thread_id IS NOT NULL), 0) AS production
      FROM editorial_trend_inbox
    `;
    const decisions = rows.map(toDecision);
    const summaryCounts = counts[0];
    return {
      ...summarizeDecisions(decisions),
      inbox: inbox[0] ?? { read: 0, observing: 0, dismissed: 0, production: 0 },
      decisionCount: summaryCounts?.decisions ?? 0,
      firstDecidedAt: summaryCounts?.first_decided_at ?? null,
      lastDecidedAt: summaryCounts?.last_decided_at ?? null,
      asOf: yield* nowIso,
    };
  }).pipe(
    Effect.catchTags({ SqlError: unreadable("summary") }),
    Effect.withSpan("EditorialResultsService.summary"),
  );

  const decisions: EditorialResultsServiceShape["decisions"] = Effect.fn(
    "EditorialResultsService.decisions",
  )(
    function* (input) {
      const offset = input.offset ?? 0;
      const rows = yield* selectDecisions(sql, {
        currentOnly: false,
        mode: input.mode,
        limit: input.limit ?? DEFAULT_DECISIONS_LIMIT,
        offset,
      });
      const total = yield* sql<{ readonly total: number }>`
        SELECT COUNT(*) AS total FROM editorial_decisions d
        JOIN editorial_video_threads t ON t.thread_id = d.thread_id
        WHERE (${input.mode ?? null} IS NULL OR t.mode = ${input.mode ?? null})
      `;
      return { decisions: rows.map(toDecision), total: total[0]?.total ?? 0, offset };
    },
    Effect.catchTags({ SqlError: unreadable("decisions") }),
  );

  const allDecisions: EditorialResultsServiceShape["allDecisions"] = selectDecisions(sql, {
    currentOnly: false,
    limit: -1,
    offset: 0,
  }).pipe(
    Effect.map((rows) => rows.map(toDecision)),
    Effect.catchTags({ SqlError: unreadable("allDecisions") }),
    Effect.withSpan("EditorialResultsService.allDecisions"),
  );

  return EditorialResultsService.of({ summary, decisions, allDecisions });
});

function stageDuration(
  durations: EditorialResultsDecision["durations"],
  stage: EditorialResultsStage,
): number | null {
  switch (stage) {
    case "explore":
      return durations.exploreMs;
    case "read":
      return durations.readMs;
    case "write":
      return durations.writeMs;
    case "decide":
      return durations.decideMs;
  }
}

const stageMs = (decision: EditorialResultsDecision, stage: EditorialResultsStage) =>
  stageDuration(decision.durations, stage);

/** Assisted exploring is the explore stage plus reading the dossier; null if neither ran. */
const exploringMs = (decision: EditorialResultsDecision) => {
  const { exploreMs, readMs } = decision.durations;
  return exploreMs === null && readMs === null ? null : (exploreMs ?? 0) + (readMs ?? 0);
};

const collect = (
  decisions: ReadonlyArray<EditorialResultsDecision>,
  pick: (decision: EditorialResultsDecision) => number | null,
) => durationStats(decisions.flatMap((decision) => pick(decision) ?? []));

/**
 * Aggregates over the current decision of each thread. Time statistics leave out threads
 * whose clock is not definitive, so an unresolved segment never shortens a median.
 */
export const summarizeDecisions = (
  decisions: ReadonlyArray<EditorialResultsDecision>,
): Pick<EditorialResultsSummary, "modes" | "comparisons"> => {
  const current = decisions.filter((decision) => decision.current);
  const byMode = (mode: EditorialResultsMode) => current.filter((entry) => entry.mode === mode);
  const timed = (mode: EditorialResultsMode) =>
    byMode(mode).filter((decision) => decision.clockDefinitive);

  const modes = MODES.map((mode): EditorialResultsModeSummary => {
    const all = byMode(mode);
    const clocked = timed(mode);
    const scripts = all.flatMap((decision) => (decision.script === null ? [] : [decision.script]));
    const claims = scripts.reduce((sum, script) => sum + script.claims, 0);
    const cited = scripts.reduce((sum, script) => sum + script.cited, 0);
    const utilities = all.map((decision) => decision.utility);
    return {
      mode,
      threads: all.length,
      provisionalClock: all.length - clocked.length,
      actions: {
        accept: all.filter((decision) => decision.action === "accept").length,
        edit: all.filter((decision) => decision.action === "edit").length,
        reject: all.filter((decision) => decision.action === "reject").length,
      },
      stages: WORK_STAGES.map((stage) => ({
        stage,
        stats: collect(clocked, (decision) => stageMs(decision, stage)),
      })),
      total: collect(clocked, (decision) => decision.durations.totalMs),
      partialCoverage: all.filter((decision) => decision.coverage === "partial").length,
      utility: {
        n: utilities.length,
        mean:
          utilities.length === 0
            ? null
            : utilities.reduce((sum, value) => sum + value, 0) / utilities.length,
        distribution: [1, 2, 3, 4, 5].map(
          (score) => utilities.filter((value) => value === score).length,
        ),
      },
      citations: {
        threads: scripts.length,
        claims,
        cited,
        ratio: claims === 0 ? null : cited / claims,
      },
      withVideoResults: all.filter((decision) => decision.video !== null).length,
    };
  });

  const complete = (mode: EditorialResultsMode) =>
    timed(mode).filter((decision) => decision.coverage === "complete");
  const compare = (
    key: EditorialResultsComparison["key"],
    threads: (mode: EditorialResultsMode) => ReadonlyArray<EditorialResultsDecision>,
    pick: (mode: EditorialResultsMode) => (decision: EditorialResultsDecision) => number | null,
  ): EditorialResultsComparison => {
    const side = (mode: EditorialResultsMode) => {
      const included = threads(mode).filter((decision) => pick(mode)(decision) !== null);
      return {
        stats: collect(included, pick(mode)),
        partial: included.filter((decision) => decision.coverage === "partial").length,
      };
    };
    const assisted = side("assisted");
    const manual = side("manual");
    return {
      key,
      assisted: assisted.stats,
      manual: manual.stats,
      partial: { assisted: assisted.partial, manual: manual.partial },
    };
  };
  const totalMs = () => (decision: EditorialResultsDecision) => decision.durations.totalMs;

  const comparisons: Array<EditorialResultsComparison> = [
    compare("explore", timed, (mode) =>
      mode === "assisted" ? exploringMs : (decision) => decision.durations.exploreMs,
    ),
    compare("write", timed, () => (decision) => decision.durations.writeMs),
    // The whole process: only threads that recorded every stage of their mode.
    compare("total", complete, totalMs),
    // Every timed thread, whatever it recorded; the page warns about partial coverage.
    compare("recorded", timed, totalMs),
  ];
  return { modes, comparisons };
};

export const layer = Layer.effect(EditorialResultsService, make);
