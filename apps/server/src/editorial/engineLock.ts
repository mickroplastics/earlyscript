// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- liveness of an engine child by pid, which may belong to a server that died.
import * as NodeProcess from "node:process";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * One engine process per job directory, across owners and server processes. The file is
 * created exclusively before the child starts and then names its pid; a later owner waits
 * while that child lives, so a recovered job never runs a second engine beside the first.
 */
const ENGINE_LOCK_FILE = "engine.lock";

const LockFile = Schema.Struct({
  owner: Schema.String,
  generation: Schema.Number,
  pid: Schema.NullOr(Schema.Number),
  /** Epoch milliseconds the lock was taken. */
  at: Schema.Number,
});
type LockFile = typeof LockFile.Type;
const LockJson = Schema.fromJsonString(LockFile);
const decodeLock = Schema.decodeUnknownOption(LockJson);
const encodeLock = Schema.encodeSync(LockJson);

export interface EngineLockOwner {
  readonly owner: string;
  readonly generation: number;
}

export interface EngineLockTiming {
  /** How often a waiting owner looks at the lock again. */
  readonly pollMs: number;
  /** A lock without a pid older than this lost its owner before the child started. */
  readonly startingGraceMs: number;
  /** After waiting this long for a former child, it is killed. */
  readonly staleEngineTimeoutMs: number;
}

const signal = (pid: number, value: NodeJS.Signals | 0) => {
  try {
    NodeProcess.kill(pid, value);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Whether `pid` is still an engine of `cli`. Where /proc exists its command line must name
 * the CLI, so a recycled pid does not hold a job forever; elsewhere a live pid is enough.
 */
const isEngineAlive = Effect.fn("EngineLock.isEngineAlive")(function* (pid: number, cli: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!signal(pid, 0)) return false;
  const procExists = yield* fs.exists("/proc/self/cmdline").pipe(Effect.orElseSucceed(() => false));
  if (!procExists) return true;
  const cmdline = yield* fs.readFileString(`/proc/${pid}/cmdline`).pipe(Effect.option);
  return Option.isSome(cmdline) && cmdline.value.split("\u0000").includes(cli);
});

export interface EngineLockOutcome {
  /** A former owner's child this owner waited for, or killed after the timeout. */
  readonly waitedFor: {
    readonly pid: number;
    readonly generation: number;
    readonly killed: boolean;
  } | null;
}

/**
 * Takes the job's engine lock for `holder`, waiting while a former owner's child runs. The
 * caller holds it while it decides whether to launch the engine and while the child lives.
 */
export const acquireEngineLock = Effect.fn("EngineLock.acquire")(function* (
  jobDir: string,
  holder: EngineLockOwner,
  cli: string,
  timing: EngineLockTiming,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = path.join(jobDir, ENGINE_LOCK_FILE);
  const waitStarted = yield* Clock.currentTimeMillis;
  let waitedFor: EngineLockOutcome["waitedFor"] = null;
  while (true) {
    const nowMs = yield* Clock.currentTimeMillis;
    const created = yield* fs
      .writeFileString(lockPath, encodeLock({ ...holder, pid: null, at: nowMs }), { flag: "wx" })
      .pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
      );
    if (created) return { waitedFor } satisfies EngineLockOutcome;
    const text = yield* fs.readFileString(lockPath).pipe(Effect.option);
    const lock = Option.flatMap(text, decodeLock);
    // Created a moment ago and not yet written: treat it as a child about to start.
    const current: LockFile = Option.getOrElse(lock, () => ({
      owner: "",
      generation: -1,
      pid: null,
      at: nowMs,
    }));
    if (current.owner === holder.owner && current.generation === holder.generation) {
      return { waitedFor } satisfies EngineLockOutcome;
    }
    const alive = current.pid !== null && (yield* isEngineAlive(current.pid, cli));
    const abandoned = current.pid === null ? nowMs - current.at > timing.startingGraceMs : !alive;
    if (abandoned) {
      yield* fs.remove(lockPath).pipe(Effect.ignore);
      continue;
    }
    if (current.pid !== null) {
      const killed = nowMs - waitStarted > timing.staleEngineTimeoutMs;
      waitedFor = { pid: current.pid, generation: current.generation, killed };
      if (killed) {
        signal(current.pid, "SIGKILL");
        yield* fs.remove(lockPath).pipe(Effect.ignore);
        continue;
      }
    }
    yield* Effect.sleep(`${timing.pollMs} millis`);
  }
});

const readOwn = Effect.fn("EngineLock.readOwn")(function* (
  lockPath: string,
  holder: EngineLockOwner,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(lockPath).pipe(Effect.option);
  return Option.filter(
    Option.flatMap(text, decodeLock),
    (lock) => lock.owner === holder.owner && lock.generation === holder.generation,
  );
});

/** Names the child in the lock; false when the lock is no longer this holder's. */
export const recordEnginePid = Effect.fn("EngineLock.recordPid")(function* (
  jobDir: string,
  holder: EngineLockOwner,
  pid: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = path.join(jobDir, ENGINE_LOCK_FILE);
  const own = yield* readOwn(lockPath, holder);
  if (Option.isNone(own)) return false;
  const tmp = `${lockPath}.${holder.generation}.tmp`;
  yield* fs.writeFileString(tmp, encodeLock({ ...own.value, pid }));
  yield* fs.rename(tmp, lockPath);
  return true;
});

/** Removes the lock if it is still this holder's. */
export const releaseEngineLock = Effect.fn("EngineLock.release")(function* (
  jobDir: string,
  holder: EngineLockOwner,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockPath = path.join(jobDir, ENGINE_LOCK_FILE);
  if (Option.isSome(yield* readOwn(lockPath, holder))) {
    yield* fs.remove(lockPath).pipe(Effect.ignore);
  }
});
