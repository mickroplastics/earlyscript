// @effect-diagnostics nodeBuiltinImport:off - writes the read-only copy of a decided version.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { checkScript } from "@earlyscript/editorial-script";
import {
  EDITORIAL_VIDEO_WS_METHODS,
  EditorialDossierId,
  EditorialRunId,
  EditorialVideoError,
  type EditorialVideoCapture,
  type EditorialVideoClockInput,
  type EditorialVideoDecision,
  type EditorialVideoErrorReason,
  type EditorialVideoResult,
  type EditorialVideoRpcGroup,
  type EditorialVideoScriptVersion,
  type EditorialVideoState,
  type EditorialVideoView,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as BrowserVisits from "./BrowserVisitService.ts";
import { purgeVideoRecord } from "./EditorialPurge.ts";
import * as VideoThreadDeletion from "./VideoThreadDeletion.ts";
import { EditorialCommandService } from "./EditorialCommandService.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { EditorialThreadService } from "./EditorialThreadService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { appendEvent, EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { nowIso } from "./persistence/support.ts";
import type { DecisionAction, VideoThread } from "./persistence/EditorialModel.ts";
import { ScriptVersionService } from "./ScriptVersionService.ts";
import { EditorialVideoProject } from "./VideoProject.ts";
import { EditorialVideoWorkspace } from "./VideoWorkspace.ts";
import { dossierPathOf } from "./videoWorkspaceFormat.ts";
import { WorkClockService } from "./WorkClockService.ts";

/** Longest wait for a thread's folder before its view is sent anyway. */
const PREPARE_ON_OPEN_TIMEOUT = "5 seconds";

/** Trace and metric aggregate of each video thread method, merged into `RpcInstrumentation`. */
export const EDITORIAL_VIDEO_RPC_AGGREGATES = {
  [EDITORIAL_VIDEO_WS_METHODS.get]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.subscribe]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.clock]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.saveScript]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.decide]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.saveResult]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.openVersion]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.createManual]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.capture]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.removeCapture]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.purge]: "editorial",
  [EDITORIAL_VIDEO_WS_METHODS.prepare]: "editorial",
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
      [EDITORIAL_VIDEO_WS_METHODS.openVersion]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.createManual]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.capture]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.removeCapture]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.purge]: () => Effect.fail(unavailable),
      [EDITORIAL_VIDEO_WS_METHODS.prepare]: () => Effect.fail(unavailable),
    }),
  },
) {}

const isVideoError = Schema.is(EditorialVideoError);

/** Failures of the editorial services, in the contract's terms. */
const toVideoError = (cause: {
  readonly _tag: string;
  readonly message: string;
  readonly reason?: unknown;
}): EditorialVideoError => {
  if (isVideoError(cause)) return cause;
  switch (cause._tag) {
    case "EditorialNotFoundError":
      return videoError("not-found", cause.message);
    case "EditorialInvalidInputError":
      return videoError("invalid-input", cause.message);
    case "EditorialConflictError":
      return videoError("invalid-input", cause.message);
    case "WorkClockStateError": {
      const reason = "reason" in cause ? cause.reason : undefined;
      return reason === "decided"
        ? videoError("decided", "The thread was decided; its clock is final.")
        : reason === "unresolved"
          ? videoError("clock-unresolved", "Resuelve el tramo abierto antes de decidir.")
          : videoError("clock-state", cause.message);
    }
    case "ScriptFileError":
      return videoError("script-file", cause.message);
    // Its message getter is fixed Spanish text by cause, never the cause's own message.
    case "EditorialVideoLaunchError":
      return videoError("launch", cause.message);
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

interface CaptureRow {
  readonly capture_id: string;
  readonly url: string;
  readonly title: string | null;
  readonly note: string | null;
  readonly captured_at: string;
}

const toCapture = (row: CaptureRow): EditorialVideoCapture => ({
  captureId: row.capture_id,
  url: row.url,
  title: row.title,
  note: row.note,
  capturedAt: row.captured_at,
});

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
  const visits = yield* BrowserVisits.BrowserVisitService;
  // The trend title comes from the run directory, mounted by `layer.ts`; without it the
  // thread still works and shows its dossier id.
  const reader = yield* Effect.serviceOption(EditorialReadService);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  // Whether the T3 thread still exists; without the service (a test), every thread does.
  const threadManagement = yield* Effect.serviceOption(ThreadManagement.ThreadManagementService);
  const studio = yield* Effect.serviceOption(EditorialVideoProject);
  // Writes a new manual thread's script from the template and completes a thread's folder when
  // it is opened; absent in tests without a workspace.
  const workspace = yield* Effect.serviceOption(EditorialVideoWorkspace);

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

  /**
   * Deleted in T3, or absent after its launch. A failed read counts as present: the view stays
   * readable and the policy, not this check, guards agent work.
   */
  const isDeleted = Effect.fn("EditorialVideoRpc.isDeleted")(function* (thread: VideoThread) {
    if (Option.isNone(threadManagement)) return false;
    const shell = yield* threadManagement.value
      .getThreadShell(ThreadId.make(thread.threadId))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (shell === undefined) return false;
    return shell === null ? thread.launchState === "launched" : shell.deletedAt !== null;
  });

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
    const captures = yield* sql<CaptureRow>`
      SELECT capture_id, url, title, note, captured_at
      FROM editorial_captures
      WHERE thread_id = ${threadId} AND removed_at IS NULL
      ORDER BY captured_at ASC, rowid ASC
    `.pipe(Effect.map((rows) => rows.map(toCapture)));
    const history = thread.mode === "manual" ? yield* visits.list(threadId) : [];
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
        deleted: yield* isDeleted(thread),
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
      script: {
        path: thread.scriptPath,
        exists,
        dossierPath: dossierPathOf(thread),
        head,
        versionCount,
      },
      decision,
      results,
      captures,
      visits: history,
    };
    return state;
  });

  const findThread = (threadId: string) =>
    threads.getVideoThread(threadId).pipe(Effect.map(Option.getOrNull));

  /**
   * Writes what is missing of a thread's folder: the studio's instructions when the thread
   * lives there, then its script and dossier file (`prepareIfNeeded`). Undecided threads only;
   * `VideoWorkspace.ts` checks that again before every write. When something was written, an
   * event makes every open subscription read the view again. True when something was written.
   */
  const prepareFolder = Effect.fn("EditorialVideoRpc.prepareFolder")(function* (threadId: string) {
    if (Option.isNone(workspace)) return false;
    const thread = yield* findThread(threadId);
    if (thread === null) return false;
    const decided = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM editorial_decisions WHERE thread_id = ${threadId}
    `.pipe(Effect.map((rows) => (rows[0]?.n ?? 0) > 0));
    if (decided) return false;
    if (Option.isSome(studio) && Option.isSome(threadManagement)) {
      const shell = yield* threadManagement.value.getThreadShell(ThreadId.make(threadId));
      if (shell !== null) yield* studio.value.ensureInstructions(shell.projectId);
    }
    const result = yield* workspace.value.prepareIfNeeded({
      thread,
      getDossier: Option.isSome(reader) ? reader.value.getDossier : null,
    });
    const wrote = result !== null && (result.dossier === "written" || result.script === "created");
    if (!wrote) return false;
    yield* log.transact(
      "editorial.videoFolderPrepared",
      Effect.gen(function* () {
        const event = yield* appendEvent(sql, {
          type: "video-thread.folder-prepared",
          aggregateKind: "video_thread",
          aggregateId: threadId,
          actor: "system",
          payload: { dossier: result.dossier, script: result.script },
          createdAt: yield* nowIso,
        });
        return { result: undefined, events: [event] };
      }),
    );
    return true;
  });

  /**
   * The folder preparation of an open or a "prepare", never failing and never holding the view
   * back: after the limit the caller goes on, and the guard in `VideoWorkspace.ts` keeps a late
   * write out of a thread decided meanwhile.
   */
  const prepareSafely = (threadId: string) =>
    prepareFolder(threadId).pipe(
      Effect.timeout(PREPARE_ON_OPEN_TIMEOUT),
      Effect.catchCause((cause) =>
        Effect.logWarning("Cannot prepare the video thread folder", { threadId, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

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

  /**
   * A work command on one video thread, answered with the thread's state after it. Refused on
   * a thread deleted in T3: a stale tab or a direct URL cannot keep its clock or record going.
   */
  const onThread = Effect.fn("EditorialVideoRpc.onThread")(function* <
    E extends { readonly _tag: string; readonly message: string },
  >(threadId: string, body: (thread: VideoThread) => Effect.Effect<unknown, E>) {
    const thread = yield* requireThread(threadId).pipe(Effect.mapError(toVideoError));
    if (yield* isDeleted(thread)) {
      return yield* videoError(
        "thread-deleted",
        `Thread ${threadId} was deleted; its editorial record is read-only until purged.`,
      );
    }
    yield* body(thread).pipe(Effect.mapError(toVideoError));
    return yield* stateOf(thread);
  });

  const clock = (input: EditorialVideoClockInput) =>
    onThread(input.threadId, (thread) =>
      Effect.gen(function* () {
        const { command } = input;
        // A decision stops the clock for good: the service checks it inside the same
        // transaction as the change, so a command admitted before a decision commits is
        // refused after it. Resolving a recovered segment stays possible.
        const options = {
          operationId: input.operationId,
          actor: "operator" as const,
          refuseWhenDecided: true,
        };
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
            const owner = yield* sql<{ readonly thread_id: string }>`
              SELECT thread_id FROM editorial_work_intervals
              WHERE interval_id = ${command.intervalId}
            `;
            if (owner[0]?.thread_id !== thread.threadId) {
              return yield* videoError(
                "not-found",
                `Interval ${command.intervalId} is not a segment of this thread.`,
              );
            }
            // A retry of the same operation returns the current state; see resolveInterval.
            return yield* clocks.resolveInterval({
              intervalId: command.intervalId,
              endedAt: command.endedAt,
              actor: "operator",
              operationId: input.operationId,
            });
          }
        }
      }),
    );

  const saveScript = ({ threadId }: { readonly threadId: string }) =>
    onThread(threadId, (thread) =>
      Effect.gen(function* () {
        yield* scripts.snapshot(thread.threadId);
        // Reading the dossier ends at the first saved script. Both conditions, Leer running
        // and no decision, are checked in the stage change's own transaction.
        yield* clocks
          .changeStage(thread.threadId, "write", {
            actor: "operator",
            onlyFrom: "read",
            refuseWhenDecided: true,
          })
          .pipe(
            Effect.catchIf(
              (error) => error._tag === "WorkClockStateError" && error.reason === "decided",
              () => Effect.void,
            ),
          );
      }),
    );

  /** Where `openVersion` writes the read-only copy of a version, by content hash. */
  const versionDirOf = (stateDir: string, contentHash: string) =>
    NodePath.join(
      stateDir,
      "editorial",
      "versions",
      contentHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
    );

  /** Version hashes of a thread whose read-only copy no other thread shares. */
  const ownHashesOf = (threadId: string) =>
    sql<{ readonly content_hash: string }>`
      SELECT DISTINCT v.content_hash FROM editorial_script_versions v
      WHERE v.thread_id = ${threadId}
        AND NOT EXISTS (
          SELECT 1 FROM editorial_script_versions o
          WHERE o.content_hash = v.content_hash AND o.thread_id <> ${threadId}
        )
    `.pipe(Effect.map((rows) => rows.map((row) => row.content_hash)));

  /** Deletes the read-only copies of these versions; the number of files that were there. */
  const removeVersionCopies = Effect.fn("EditorialVideoRpc.removeVersionCopies")(function* (
    hashes: ReadonlyArray<string>,
  ) {
    if (Option.isNone(config)) return 0;
    const stateDir = config.value.stateDir;
    let files = 0;
    for (const hash of hashes) {
      const dir = versionDirOf(stateDir, hash);
      files += yield* Effect.tryPromise({
        try: async () => {
          const names = await NodeFSP.readdir(dir).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [] as string[];
            throw error;
          });
          await NodeFSP.rm(dir, { recursive: true, force: true });
          return names.length;
        },
        catch: () =>
          videoError(
            "storage",
            "Cannot delete a version's read-only copy; nothing was purged. Fix the folder's permissions and purge again.",
          ),
      });
    }
    return files;
  });

  /**
   * Disk first, database after: the copies go before any row, so a copy that cannot be deleted
   * leaves the whole record in place and the purge can run again. The rows and the purge event
   * commit only once the disk is clean.
   */
  const purge = Effect.fn("EditorialVideoRpc.purge")(function* (threadId: string) {
    const thread = yield* requireThread(threadId);
    if (!(yield* isDeleted(thread))) {
      return yield* videoError(
        "thread-live",
        "Borra primero el hilo; sus datos editoriales se borran después.",
      );
    }
    const versionFiles = yield* removeVersionCopies(yield* ownHashesOf(threadId));
    const deleted = yield* purgeVideoRecord(thread, versionFiles).pipe(
      Effect.provideService(EditorialSql, sql),
      Effect.provideService(EditorialEventLog, log),
    );
    return { threadId: ThreadId.make(threadId), deleted };
  }, Effect.mapError(toVideoError));

  /**
   * The snapshot of a saved version as a read-only file under the server's state directory.
   * The file surface shows an absolute host path without editing, so the decided script reads
   * as it was decided while editing in the workspace stays as it is. Content-addressed: the
   * file is written once and never changes.
   */
  const openVersion = Effect.fn("EditorialVideoRpc.openVersion")(function* (
    threadId: string,
    contentHash: string,
  ) {
    if (Option.isNone(config)) {
      return yield* videoError("unavailable", "The server has no state directory.");
    }
    const thread = yield* requireThread(threadId);
    const rows = yield* sql<{ readonly snapshot: string; readonly script_path: string | null }>`
        SELECT snapshot, script_path FROM editorial_script_versions
        WHERE thread_id = ${thread.threadId} AND content_hash = ${contentHash}
      `;
    const row = rows[0];
    if (row === undefined) {
      return yield* videoError(
        "not-found",
        `Version ${contentHash} is not a version of this thread.`,
      );
    }
    const name = NodePath.basename(row.script_path ?? "") || "guion.md";
    const target = NodePath.join(versionDirOf(config.value.stateDir, contentHash), name);
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        // `wx` leaves an existing copy alone: its content is the same by construction.
        await NodeFSP.writeFile(target, row.snapshot, { flag: "wx", mode: 0o444 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
      },
      catch: () => videoError("storage", "Cannot write the version's read-only copy."),
    });
    return { path: target };
  }, Effect.mapError(toVideoError));

  /** A manual thread with no dossier; the operation id is the client's, scoped to this use. */
  const createManual = Effect.fn("EditorialVideoRpc.createManual")(function* (input: {
    readonly operationId: string;
    readonly projectId?: ProjectId;
    readonly title: string;
    readonly modelSelection: Parameters<typeof threads.createVideo>[0]["modelSelection"];
    readonly trendKey?: string;
  }) {
    const created = yield* threads.createVideo({
      operationId: `editorial:manual-video:${input.operationId}`,
      projectId: input.projectId,
      mode: "manual",
      title: input.title,
      modelSelection: input.modelSelection,
      creationSource: "web",
      trendKey: input.trendKey,
    });
    if (Option.isSome(workspace)) {
      yield* workspace.value.prepare({ thread: created.thread, dossier: null });
    }
    return { threadId: ThreadId.make(created.thread.threadId), created: created.created };
  }, Effect.mapError(toVideoError));

  const handlers: EditorialVideoHandlers = {
    [EDITORIAL_VIDEO_WS_METHODS.get]: ({ threadId }) => view(threadId),
    [EDITORIAL_VIDEO_WS_METHODS.subscribe]: ({ threadId }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* prepareSafely(threadId);
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
            // Resolve first: the decision freezes its durations and Results reads them.
            requireDefinitiveClock: true,
            // Deciding is the Decidir stage, even when nobody opened it before sending.
            openStage: "decide",
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
    [EDITORIAL_VIDEO_WS_METHODS.openVersion]: ({ threadId, contentHash }) =>
      openVersion(threadId, contentHash),
    [EDITORIAL_VIDEO_WS_METHODS.createManual]: (input) => createManual(input),
    [EDITORIAL_VIDEO_WS_METHODS.purge]: ({ threadId }) => purge(threadId),
    [EDITORIAL_VIDEO_WS_METHODS.prepare]: ({ threadId }) =>
      requireThread(threadId).pipe(
        Effect.mapError(toVideoError),
        Effect.andThen(prepareSafely(threadId)),
        Effect.map((prepared) => ({ prepared })),
      ),
    [EDITORIAL_VIDEO_WS_METHODS.capture]: ({ threadId, url, title, note }) =>
      onThread(threadId, (thread) =>
        commands.saveCapture({
          threadId: thread.threadId,
          url,
          title,
          note,
          actor: "operator",
          refuseWhenDecided: true,
        }),
      ),
    [EDITORIAL_VIDEO_WS_METHODS.removeCapture]: ({ threadId, captureId }) =>
      onThread(threadId, (thread) =>
        commands.removeCapture({
          threadId: thread.threadId,
          captureId,
          actor: "operator",
          refuseWhenDecided: true,
        }),
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
export const layer = Layer.effect(EditorialVideoRpcHandlers, makeHandlers).pipe(
  // The browser history of manual threads, read here and recorded from the preview manager.
  Layer.provideMerge(BrowserVisits.layer),
  // T3 deletions of video threads stop their clock and refresh their open views.
  Layer.provideMerge(VideoThreadDeletion.layer),
);
