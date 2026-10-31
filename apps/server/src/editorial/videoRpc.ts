import { checkScript } from "@earlyscript/editorial-script";
import {
  EDITORIAL_VIDEO_WS_METHODS,
  EditorialDossierId,
  EditorialRunId,
  EditorialVideoError,
  type EditorialVideoClockInput,
  type EditorialVideoDecision,
  type EditorialVideoErrorReason,
  type EditorialVideoResult,
  type EditorialVideoRpcGroup,
  type EditorialVideoScriptVersion,
  type EditorialVideoState,
  type EditorialVideoView,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import type { DecisionAction, VideoThread } from "./persistence/EditorialModel.ts";
import { ScriptVersionService } from "./ScriptVersionService.ts";
import { WorkClockService } from "./WorkClockService.ts";

/** Trace and metric aggregate of each video thread method, merged into `RpcInstrumentation`. */
export const EDITORIAL_VIDEO_RPC_AGGREGATES = {
  [EDITORIAL_VIDEO_WS_METHODS.get]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.subscribe]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.clock]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.saveScript]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.decide]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.saveResult]: "editorial",
} as const;

type VideoRpcs = RpcGroup.Rpcs<typeof EditorialVideoRpcGroup>;

/** One handler per video thread method, with its services already provided. */
export type EditorialVideoHandlers = {
  readonly [Current in VideoRpcs as Current["_tag"]]: (
    payload: Rpc.Payload<Current>,
  ) => Rpc.Success<Current> extends Stream.Stream<infer A, infer E, infer _R>
    ? Stream.Stream<A, E | Rpc.Error<Current>>
    : Effect.Effect<Rpc.Success<Current>, Rpc.Error<Current>>;
};

const videoError = (reason: EditorialVideoErrorReason, message: string) =>
  new EditorialVideoError({ reason, message });

const unavailable = videoError(
  "unavailable",
  "The editorial services are not mounted on this server.",
);

/**
 * Handlers spread into the WebSocket group in `ws.ts`. A Reference, not a requirement, so
 * `layerWsRpc` keeps its upstream signature; a server built without `layer` answers
 * `unavailable`.
 */
export class EditorialVideoRpcHandlers extends Context.Reference<EditorialVideoHandlers>(
  "t3/editorial/EditorialVideoRpcHandlers",
  {
    defaultValue: () => ({
      [EDITORIAL_VIDEO_WS_METHODS.get]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.subscribe]: () => Stream.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.clock]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.saveScript]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.decide]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.saveResult]: () => Effect.fail(unavailable),
    }),
  },
) {}

const isVideoError = Schema.is(EditorialVideoError);

/** Failures of the editorial services, in the contract's terms. */
const toVideoError = (cause: {
  readonly _tag: string;
  readonly message: string;
}): EditorialVideoError => {
  if (isVideoError(cause)) return cause;
  switch (cause._tag) {
    case "EditorialNotFoundError":
      return videoError("not-found", cause.message);
    case "EditorialInvalidInputError":
      return videoError("invalid-input", cause.message);
    case "EditorialConflictError":
      return videoError("invalid-input", cause.message);
    case "WorkClockStateError":
      return videoError("clock-state", cause.message);
    case "ScriptFileError":
      return videoError("script-file", cause.message);
    default:
      return videoError("storage", cause.message);
  }
};

const RESULTS_LIMIT = 20;
const CACHE_LIMIT = 500;

interface HeadRow {
  readonly version_id: string;
  readonly content_hash: string;
  readonly snapshot: string;
  readonly saved_at: string;
}

interface DecisionRow {
  readonly decision_id: string;
  readonly action: DecisionAction;
  readonly utility: number;
  readonly reason: string | null;
  readonly script_version_hash: string | null;
  readonly explore_ms: number | null;
  readonly read_ms: number | null;
  readonly write_ms: number | null;
  readonly decide_ms: number | null;
  readonly total_ms: number | null;
  readonly clock_definitive: number;
  readonly decided_at: string;
}

interface ResultRow {
  readonly result_id: string;
  readonly views: number | null;
  readonly subscribers: number | null;
  readonly clicks: number | null;
  readonly comments: number | null;
  readonly observed_at: string;
  readonly recorded_at: string;
}

const toDecision = (row: DecisionRow): EditorialVideoDecision => ({
  decisionId: row.decision_id,
  action: row.action,
  utility: row.utility,
  reason: row.reason,
  scriptVersionHash: row.script_version_hash,
  durations: {
    exploreMs: row.explore_ms,
    readMs: row.read_ms,
    writeMs: row.write_ms,
    decideMs: row.decide_ms,
    totalMs: row.total_ms,
  },
  clockDefinitive: row.clock_definitive === 1,
  decidedAt: row.decided_at,
});

const toResult = (row: ResultRow): EditorialVideoResult => ({
  resultId: row.result_id,
  views: row.views,
  subscribers: row.subscribers,
  clicks: row.clicks,
  comments: row.comments,
  observedAt: row.observed_at,
  recordedAt: row.recorded_at,
});

/** Bounded memo: cleared whole when full, like the Results script counts. */
const boundedCache = <A>() => {
  const entries = new Map<string, A>();
  return {
    get: (key: string) => entries.get(key),
    set: (key: string, value: A) => {
      if (entries.size >= CACHE_LIMIT) entries.clear();
      entries.set(key, value);
    },
  };
};

const makeHandlers = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const log = yield* EditorialEventLog;
  const threads = yield* EditorialThreadService;
  const clocks = yield* WorkClockService;
  const scripts = yield* ScriptVersionService;
  const commands = yield* EditorialCommandService;
  // The trend title comes from the run directory, mounted by `layer.ts`; without it the
  // thread still works and shows its dossier id.
  const reader = yield* Effect.serviceOption(EditorialReadService);

  const scriptCounts = boundedCache<{ claims: number; cited: number } | null>();
  const trendTitles = boundedCache<string>();

  const countClaims = (hash: string, snapshot: string) => {
    const cached = scriptCounts.get(hash);
    if (cached !== undefined) return cached;
    let count: { claims: number; cited: number } | null;
    try {
      const { counts } = checkScript(snapshot);
      count = { claims: counts.claims, cited: counts.cited };
    } catch {
      count = null;
    }
    scriptCounts.set(hash, count);
    return count;
  };

  const trendTitleOf = Effect.fn("EditorialVideoRpc.trendTitleOf")(function* (thread: VideoThread) {
    const { runId, dossierId } = thread;
    if (Option.isNone(reader) || runId === null || dossierId === null) return null;
    const key = `${runId}\u0000${dossierId}`;
    const cached = trendTitles.get(key);
    if (cached !== undefined) return cached;
    const dossier = yield* reader.value
      .getDossier({
        runId: EditorialRunId.make(runId),
        dossierId: EditorialDossierId.make(dossierId),
        evidenceLimit: 1,
      })
      .pipe(Effect.option);
    if (Option.isNone(dossier)) return null;
    const title = dossier.value.trend.presentation?.title ?? dossier.value.trend.label;
    trendTitles.set(key, title);
    return title;
  });

  const readHead = (threadId: string) =>
    sql<HeadRow>`
      SELECT v.version_id, v.content_hash, v.snapshot, v.saved_at
      FROM editorial_video_threads t
      JOIN editorial_script_versions v
        ON v.thread_id = t.thread_id AND v.content_hash = t.script_head_hash
      WHERE t.thread_id = ${threadId}
    `.pipe(
      Effect.map((rows): EditorialVideoScriptVersion | null => {
        const row = rows[0];
        if (row === undefined) return null;
        const count = countClaims(row.content_hash, row.snapshot);
        return {
          versionId: row.version_id,
          contentHash: row.content_hash,
          savedAt: row.saved_at,
          claims: count?.claims ?? null,
          cited: count?.cited ?? null,
        };
      }),
    );

  const readState = Effect.fn("EditorialVideoRpc.readState")(function* (thread: VideoThread) {
    const threadId = thread.threadId;
    const clock = yield* clocks.summary(threadId);
    const head = yield* readHead(threadId);
    const versionCount = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM editorial_script_versions WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));
    const decision = yield* sql<DecisionRow>`
      SELECT
        decision_id, action, utility, reason, script_version_hash, explore_ms, read_ms,
        write_ms, decide_ms, total_ms, clock_definitive, decided_at
      FROM editorial_decisions
      WHERE thread_id = ${threadId}
      ORDER BY decided_at DESC, rowid DESC
      LIMIT 1
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : toDecision(rows[0]))));
    const results = yield* sql<ResultRow>`
      SELECT result_id, views, subscribers, clicks, comments, observed_at, recorded_at
      FROM editorial_video_results
      WHERE thread_id = ${threadId}
      ORDER BY observed_at DESC, rowid DESC
      LIMIT ${RESULTS_LIMIT}
    `.pipe(Effect.map((rows) => rows.map(toResult)));
    const exists = yield* scripts.readScript({ threadId }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const state: EditorialVideoState = {
      thread: {
        threadId,
        mode: thread.mode,
        launchState: thread.launchState,
        createdAt: thread.createdAt,
        trendKey: thread.trendKey,
        runId: thread.runId,
        dossierId: thread.dossierId,
        trendTitle: yield* trendTitleOf(thread),
      },
      clock: {
        state:
          clock.state._tag === "idle"
            ? { _tag: "idle" }
            : { _tag: clock.state._tag, stage: clock.state.stage, since: clock.state.since },
        stages: clock.stages,
        activeMs: clock.activeMs,
        pausedMs: clock.pausedMs,
        unresolved: clock.unresolved,
        definitive: clock.definitive,
        asOf: clock.asOf,
      },
      script: { path: thread.scriptPath, exists, head, versionCount },
      decision,
      results,
    };
    return state;
  });

  const findThread = (threadId: string) =>
    threads.getVideoThread(threadId).pipe(Effect.map(Option.getOrNull));

  const requireThread = (threadId: string) =>
    findThread(threadId).pipe(
      Effect.filterOrFail(
        (thread): thread is VideoThread => thread !== null,
        () => videoError("not-found", `Thread ${threadId} is not a video thread.`),
      ),
    );

  const stateOf = (thread: VideoThread) => readState(thread).pipe(Effect.mapError(toVideoError));

  const view = (threadId: string): Effect.Effect<EditorialVideoView, EditorialVideoError> =>
    findThread(threadId).pipe(
      Effect.flatMap((thread) => (thread === null ? Effect.succeed(null) : readState(thread))),
      Effect.map((video) => ({ threadId, video })),
      Effect.mapError(toVideoError),
    );

  const hasDecision = (threadId: string) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM editorial_decisions WHERE thread_id = ${threadId} LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toVideoError),
    );

  /** A command on one video thread, answered with the thread's state after it. */
  const onThread = Effect.fn("EditorialVideoRpc.onThread")(function* <
    E extends { readonly _tag: string; readonly message: string },
  >(threadId: string, body: (thread: VideoThread) => Effect.Effect<unknown, E>) {
    const thread = yield* requireThread(threadId).pipe(Effect.mapError(toVideoError));
    yield* body(thread).pipe(Effect.mapError(toVideoError));
    return yield* stateOf(thread);
  });

  const clock = (input: EditorialVideoClockInput) =>
    onThread(input.threadId, (thread) =>
      Effect.gen(function* () {
        const { command } = input;
        const options = { operationId: input.operationId, actor: "operator" as const };
        // A decision stops the clock for good; resolving a recovered segment stays possible.
        if (command._tag !== "resolve" && (yield* hasDecision(thread.threadId))) {
          return yield* videoError("decided", "The thread was decided; its clock is final.");
        }
        switch (command._tag) {
          case "start":
            return yield* clocks.start(thread.threadId, command.stage, options);
          case "pause":
            return yield* clocks.pause(thread.threadId, { ...options, reason: command.reason });
          case "resume":
            return yield* clocks.resume(thread.threadId, options);
          case "stage":
            return yield* clocks.changeStage(thread.threadId, command.stage, options);
          case "stop":
            return yield* clocks.stop(thread.threadId, options);
          case "resolve": {
            const summary = yield* clocks.summary(thread.threadId);
            if (!summary.unresolved.some((entry) => entry.intervalId === command.intervalId)) {
              return yield* videoError(
                "not-found",
                `Interval ${command.intervalId} does not await resolution in this thread.`,
              );
            }
            return yield* clocks.resolveInterval({
              intervalId: command.intervalId,
              endedAt: command.endedAt,
              actor: "operator",
            });
          }
        }
      }),
    );

  const saveScript = ({ threadId }: { readonly threadId: string }) =>
    onThread(threadId, (thread) =>
      Effect.gen(function* () {
        yield* scripts.snapshot(thread.threadId);
        // Reading the dossier ends at the first saved script, unless the thread was decided.
        const summary = yield* clocks.summary(thread.threadId);
        if (
          summary.state._tag === "running" &&
          summary.state.stage === "read" &&
          !(yield* hasDecision(thread.threadId))
        ) {
          yield* clocks.changeStage(thread.threadId, "write", { actor: "operator" });
        }
      }),
    );

  const handlers: EditorialVideoHandlers = {
    [EDITORIAL_VIDEO_WS_METHODS.get]: ({ threadId }) => view(threadId),
    [EDITORIAL_VIDEO_WS_METHODS.subscribe]: ({ threadId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribed before the first read, so no commit in between is lost.
          const subscription = yield* log.subscribe;
          const first = yield* view(threadId);
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (event) => event.aggregateKind === "video_thread" && event.aggregateId === threadId,
            ),
            Stream.mapEffect(() => view(threadId)),
          );
          return Stream.concat(Stream.make(first), live);
        }),
      ),
    [EDITORIAL_VIDEO_WS_METHODS.clock]: clock,
    [EDITORIAL_VIDEO_WS_METHODS.saveScript]: saveScript,
    [EDITORIAL_VIDEO_WS_METHODS.decide]: (input) =>
      onThread(input.threadId, (thread) =>
        scripts
          .decide({
            threadId: thread.threadId,
            action: input.action,
            utility: input.utility,
            reason: input.reason,
            scriptVersionHash: input.scriptVersionHash ?? undefined,
            operationId: input.operationId,
            actor: "operator",
          })
          .pipe(
            Effect.mapError((error) =>
              // The only conflict, and a version that is not the thread's: the script moved on.
              error._tag === "EditorialConflictError" ||
              (error._tag === "EditorialNotFoundError" && error.entity === "script_version")
                ? videoError("version-changed", error.message)
                : error,
            ),
          ),
      ),
    [EDITORIAL_VIDEO_WS_METHODS.saveResult]: ({ threadId, ...metrics }) =>
      onThread(threadId, (thread) =>
        Effect.gen(function* () {
          if (!(yield* hasDecision(thread.threadId))) {
            return yield* videoError(
              "not-decided",
              "Video results are recorded on a decided thread.",
            );
          }
          return yield* commands.saveResult({
            threadId: thread.threadId,
            ...metrics,
            actor: "operator",
          });
        }),
      ),
  };
  return handlers;
});

/**
 * Mounted once in `server.ts`, over the video thread services and the storage that
 * `runtimeLayer.ts` and `persistenceLayer.ts` provide.
 */
export const layer = Layer.effect(EditorialVideoRpcHandlers, makeHandlers);
