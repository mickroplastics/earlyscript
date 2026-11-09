import {
  EditorialReadError,
  type EditorialGetDossierInput,
  type EditorialGetJudgeOpinionInput,
  type EditorialGetJudgeOpinionResult,
  type EditorialGetInboxInput,
  type EditorialInbox,
  type EditorialRunSummary,
  type EditorialTrendDossier,
  type EditorialTrendInboxState,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  latestDecisionOf,
  priorDecisionOf,
  selectThreadDecisions,
  type TopicFingerprint,
} from "./cardDecisions.ts";
import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialRunDirectory, type IndexedDossier, type LoadedRun } from "./RunDirectory.ts";
import { compareTrends, evidenceRange } from "./dossierFormat.ts";
import { toTrendInboxState } from "./inboxState.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import {
  runSummaryOf,
  selectLatestRun,
  selectRun,
  selectRunDossiers,
  selectRuns,
  selectTrendDossier,
  isReadableRun,
  type ReadableRunRow,
} from "./runIndex.ts";
import { withPresentations } from "./presentationRead.ts";

const DEFAULT_INBOX_LIMIT = 100;
const DEFAULT_EVIDENCE_LIMIT = 6;
const MAX_INBOX_KEYS_PER_READ = 500;

export interface EditorialReadServiceShape {
  readonly listRuns: Effect.Effect<ReadonlyArray<EditorialRunSummary>, EditorialReadError>;
  readonly getInbox: (
    input: EditorialGetInboxInput,
  ) => Effect.Effect<EditorialInbox, EditorialReadError>;
  readonly getDossier: (
    input: EditorialGetDossierInput,
  ) => Effect.Effect<EditorialTrendDossier, EditorialReadError>;
  /**
   * The judges' opinion of a dossier, only once the operator recorded a decision with utility
   * on its trend: the decision is stored with its time before the opinion can be read.
   */
  readonly getJudgeOpinion: (
    input: EditorialGetJudgeOpinionInput,
  ) => Effect.Effect<EditorialGetJudgeOpinionResult, EditorialReadError>;
  /** The state of one trend against the latest run, and that run's new count, from the index. */
  readonly getTrendState: (trendKey: string) => Effect.Effect<
    {
      readonly state: EditorialTrendInboxState;
      readonly newCount: number;
    },
    EditorialReadError
  >;
}

/**
 * Read-only view of the imported runs with their inbox state. Runs come from the index in
 * editorial.sqlite; dossier content from the run files through the shared directory cache.
 * MCP readers get only this service: nothing here writes.
 */
export class EditorialReadService extends Context.Service<
  EditorialReadService,
  EditorialReadServiceShape
>()("t3/editorial/EditorialReadService") {}

const unreadable = (message: string) => (cause: unknown) =>
  new EditorialReadError({
    reason: "unreadable",
    message: cause instanceof Error ? `${message}: ${cause.message}` : message,
  });

const make = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const directory = yield* EditorialRunDirectory;
  const commands = yield* EditorialCommandService;

  const statesFor = (trendKeys: ReadonlyArray<string>) =>
    Effect.forEach(
      Array.from({ length: Math.ceil(trendKeys.length / MAX_INBOX_KEYS_PER_READ) }, (_, page) =>
        trendKeys.slice(page * MAX_INBOX_KEYS_PER_READ, (page + 1) * MAX_INBOX_KEYS_PER_READ),
      ),
      (keys) =>
        Effect.gen(function* () {
          const states = yield* commands.getInboxState(keys);
          const trials = yield* sql<{ thread_id: string }>`
          SELECT t.thread_id FROM editorial_trend_inbox i
          JOIN editorial_video_threads t ON t.thread_id = i.production_thread_id
          WHERE i.trend_key IN ${sql.in([...keys])} AND t.cohort = 'trial'
        `.pipe(Effect.mapError(unreadable("Cannot read the production cohort")));
          const ids = new Set(trials.map((row) => row.thread_id));
          return states.map((state) => ({
            ...state,
            productionCohort: ids.has(state.productionThreadId ?? "")
              ? ("trial" as const)
              : ("human" as const),
          }));
        }),
    ).pipe(
      Effect.map((pages) => pages.flat()),
      Effect.mapError(unreadable("Cannot read the inbox state")),
    );

  const findRunRow = Effect.fn("EditorialReadService.findRunRow")(function* (
    runId: string | undefined,
  ) {
    const row = yield* (runId === undefined ? selectLatestRun(sql) : selectRun(sql, runId)).pipe(
      Effect.mapError(unreadable("Cannot read the run index")),
    );
    if (Option.isNone(row)) {
      if (runId === undefined) return Option.none<ReadableRunRow>();
      return yield* new EditorialReadError({
        reason: "run-not-found",
        message: `Run ${runId} has not been imported.`,
      });
    }
    if (!isReadableRun(row.value)) {
      return yield* new EditorialReadError({
        reason: "unreadable",
        message: `Run ${row.value.run_id} is invalid: its run.json does not decode.`,
      });
    }
    return Option.some(row.value);
  });

  // The files are the content; the index says which directory holds the run.
  const loadRun = Effect.fn("EditorialReadService.loadRun")(function* (row: ReadableRunRow) {
    const entry = yield* directory.find(row.run_id);
    if (Option.isNone(entry)) {
      return yield* new EditorialReadError({
        reason: "unreadable",
        message: `Run ${row.run_id} is indexed but its directory is no longer readable.`,
      });
    }
    return yield* directory.load(entry.value);
  });

  /** The run's trends with their inbox state, in the order the run lists them. */
  const withInbox = Effect.fn("EditorialReadService.withInbox")(function* (
    row: ReadableRunRow,
    loaded: LoadedRun,
  ) {
    const states = yield* statesFor(loaded.dossiers.map((dossier) => dossier.trendKey.key));
    const now = yield* Clock.currentTimeMillis;
    return loaded.dossiers.map((dossier, index): IndexedDossier => {
      const inbox = toTrendInboxState(
        states[index]!,
        { runCutoffAt: row.cutoff_at, lastActivityDay: dossier.lastActivityDay },
        now,
      );
      const summary: EditorialTrendSummary = {
        ...dossier.summary,
        isNew: inbox.isNew,
        trendKey: dossier.trendKey.key,
        inbox,
      };
      return { ...dossier, summary };
    });
  });

  /** A decided dossier's topic fingerprint, by `run_id/dossier_id`; a run that is gone gives none. */
  const decidedFingerprints = Effect.fn("EditorialReadService.decidedFingerprints")(function* (
    runIds: ReadonlyArray<string>,
  ) {
    const fingerprints = new Map<string, TopicFingerprint>();
    for (const runId of runIds) {
      const entry = yield* directory.find(runId).pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(entry)) continue;
      const loaded = yield* directory.load(entry.value).pipe(Effect.option);
      if (Option.isNone(loaded)) continue;
      for (const dossier of loaded.value.dossiers) {
        fingerprints.set(`${runId}/${dossier.summary.dossierId}`, {
          trendKey: dossier.trendKey.key,
          itemIds: new Set(dossier.file.evidence.map((item) => item.item_id)),
        });
      }
    }
    return fingerprints;
  });

  /**
   * Each card with the operator's latest decision on its trend and, when one was recorded
   * before the run's cutoff on the same topic, "ya decidido" (`cardDecisions.ts`).
   */
  const withDecisions = Effect.fn("EditorialReadService.withDecisions")(function* (
    row: ReadableRunRow,
    dossiers: ReadonlyArray<IndexedDossier>,
  ) {
    const rows = yield* selectThreadDecisions(sql).pipe(
      Effect.mapError(unreadable("Cannot read the decisions")),
    );
    const cutoffMs = Date.parse(row.cutoff_at);
    const earlier = rows.filter(
      (decision) => decision.run_id !== null && Date.parse(decision.decided_at) < cutoffMs,
    );
    const fingerprints =
      earlier.length === 0
        ? new Map<string, TopicFingerprint>()
        : yield* decidedFingerprints([...new Set(earlier.map((decision) => decision.run_id!))]);
    return dossiers.map((dossier): IndexedDossier => {
      const card = dossier.summary.card;
      if (card === undefined) return dossier;
      const own: TopicFingerprint = {
        trendKey: dossier.trendKey.key,
        itemIds: new Set(dossier.file.evidence.map((item) => item.item_id)),
      };
      const summary: EditorialTrendSummary = {
        ...dossier.summary,
        card: {
          ...card,
          decision: latestDecisionOf(own.trendKey, rows),
          priorDecision: priorDecisionOf(
            own,
            row.cutoff_at,
            rows,
            (decision) => fingerprints.get(`${decision.run_id}/${decision.dossier_id}`) ?? null,
          ),
        },
      };
      return { ...dossier, summary };
    });
  });

  const listRuns: EditorialReadServiceShape["listRuns"] = selectRuns(sql).pipe(
    Effect.map((rows) => rows.map(runSummaryOf)),
    Effect.mapError(unreadable("Cannot read the run index")),
    Effect.withSpan("EditorialReadService.listRuns"),
  );

  const getInbox: EditorialReadServiceShape["getInbox"] = Effect.fn(
    "EditorialReadService.getInbox",
  )(function* (input) {
    const sort = input.sort ?? "new-first-growth";
    const row = yield* findRunRow(input.runId);
    if (Option.isNone(row)) {
      return {
        run: null,
        sort,
        trends: [],
        total: 0,
        newCount: 0,
        snoozedCount: 0,
        dismissedCount: 0,
      };
    }
    const loaded = yield* loadRun(row.value);
    const dossiers = yield* withInbox(row.value, loaded).pipe(
      Effect.flatMap((inboxed) => withDecisions(row.value, inboxed)),
    );
    const trends = dossiers.map((dossier) => dossier.summary).toSorted(compareTrends(sort));
    const offset = input.offset ?? 0;
    return {
      run: { ...runSummaryOf(row.value), dossierCount: loaded.dossiers.length },
      sort,
      trends: trends.slice(offset, offset + (input.limit ?? DEFAULT_INBOX_LIMIT)),
      total: trends.length,
      newCount: trends.filter((trend) => trend.isNew).length,
      snoozedCount: trends.filter((trend) => trend.inbox?.snoozed != null).length,
      dismissedCount: trends.filter((trend) => trend.inbox?.dismissed != null).length,
    };
  });

  const getDossier: EditorialReadServiceShape["getDossier"] = Effect.fn(
    "EditorialReadService.getDossier",
  )(function* (input) {
    const notFound = new EditorialReadError({
      reason: "dossier-not-found",
      message: `Dossier ${input.dossierId} is not in run ${input.runId}.`,
    });
    const row = yield* findRunRow(input.runId).pipe(
      Effect.catchTags({
        EditorialReadError: (error) =>
          Effect.fail(error.reason === "run-not-found" ? notFound : error),
      }),
    );
    if (Option.isNone(row)) return yield* notFound;
    const loaded = yield* loadRun(row.value);
    const found = loaded.dossiers.find(
      (candidate) => candidate.summary.dossierId === input.dossierId,
    );
    if (found === undefined) return yield* notFound;
    const [dossier] = yield* withInbox(row.value, { ...loaded, dossiers: [found] }).pipe(
      Effect.flatMap((inboxed) => withDecisions(row.value, inboxed)),
    );
    const offset = input.evidenceOffset ?? 0;
    return {
      trend: dossier!.summary,
      run: { ...runSummaryOf(row.value), dossierCount: loaded.dossiers.length },
      rankMethod: found.file.rankings.weighted.method,
      rankComponents: found.file.rankings.weighted.components,
      affinityThreshold: loaded.entry.run.include_min,
      curve: found.curve,
      coverage: found.coverage,
      evidence: found.evidence.slice(
        offset,
        offset + (input.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT),
      ),
      evidenceTotal: found.evidence.length,
      evidenceOffset: offset,
      evidenceRange: evidenceRange(found.evidence),
    };
  });

  const getJudgeOpinion: EditorialReadServiceShape["getJudgeOpinion"] = Effect.fn(
    "EditorialReadService.getJudgeOpinion",
  )(function* (input) {
    const notFound = new EditorialReadError({
      reason: "dossier-not-found",
      message: `Dossier ${input.dossierId} is not in run ${input.runId}.`,
    });
    const row = yield* findRunRow(input.runId).pipe(
      Effect.catchTags({
        EditorialReadError: (error) =>
          Effect.fail(error.reason === "run-not-found" ? notFound : error),
      }),
    );
    if (Option.isNone(row)) return yield* notFound;
    const loaded = yield* loadRun(row.value);
    const found = loaded.dossiers.find(
      (candidate) => candidate.summary.dossierId === input.dossierId,
    );
    if (found === undefined) return yield* notFound;
    const rows = yield* selectThreadDecisions(sql).pipe(
      Effect.mapError(unreadable("Cannot read the decisions")),
    );
    const decision = latestDecisionOf(found.trendKey.key, rows);
    // Hidden comes first, so a closed opinion does not tell whether one exists.
    if (decision === null || decision.utility === null) return { _tag: "hidden" as const };
    if (found.judges === null) return { _tag: "none" as const };
    return { _tag: "shown" as const, view: found.judges, decidedAt: decision.decidedAt };
  });

  const getTrendState: EditorialReadServiceShape["getTrendState"] = Effect.fn(
    "EditorialReadService.getTrendState",
  )(function* (trendKey) {
    const latest = yield* findRunRow(undefined);
    const now = yield* Clock.currentTimeMillis;
    const [state] = yield* statesFor([trendKey]);
    if (Option.isNone(latest)) {
      return { state: toTrendInboxState(state!, null, now), newCount: 0 };
    }
    const cutoff = latest.value.cutoff_at;
    const rows = yield* selectRunDossiers(sql, latest.value.run_id).pipe(
      Effect.mapError(unreadable("Cannot read the dossier index")),
    );
    const states = yield* statesFor(rows.map((dossierRow) => dossierRow.trend_key));
    const newCount = rows.filter(
      (dossierRow, index) =>
        toTrendInboxState(
          states[index]!,
          { runCutoffAt: cutoff, lastActivityDay: dossierRow.last_activity_day },
          now,
        ).isNew,
    ).length;
    const own = yield* selectTrendDossier(sql, latest.value.run_id, trendKey).pipe(
      Effect.mapError(unreadable("Cannot read the dossier index")),
    );
    return {
      state: toTrendInboxState(
        state!,
        Option.match(own, {
          onNone: () => null,
          onSome: (dossierRow) => ({
            runCutoffAt: cutoff,
            lastActivityDay: dossierRow.last_activity_day,
          }),
        }),
        now,
      ),
      newCount,
    };
  });

  return EditorialReadService.of(
    withPresentations(sql, directory, {
      listRuns,
      getInbox,
      getDossier,
      getJudgeOpinion,
      getTrendState,
    }),
  );
});

export const layer = Layer.effect(EditorialReadService, make);
