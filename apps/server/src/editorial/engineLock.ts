// @effect-diagnostics nodeBuiltinImport:off -- liveness and termination of an engine child by pid, which may outlive the server that started it.
import * as NodeProcess from "node:process";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// One engine per job. Each claim writes or deletes only its own `<owner>-g<generation>.json`
// (or a foreign one proved abandoned, by exact name), never a shared file. A child counts as
// this job's engine only if `ps` shows its `--lock-token`; without `ps` (Windows) no pid is
// identified and only the starting grace of the files holds a new owner back.
const LOCK_DIR = "engine.lock.d";
export const LOCK_TOKEN_FLAG = "--lock-token";

export interface EngineClaim {
  readonly jobId: string;
  readonly owner: string;
  readonly generation: number;
}

export const engineToken = (claim: EngineClaim) =>
  `${claim.jobId}:${claim.owner}:${claim.generation}`;

const fileNameOf = (claim: EngineClaim) => `${claim.owner}-g${claim.generation}.json`;

const LockFile = Schema.Struct({
  owner: Schema.String,
  generation: Schema.Number,
  token: Schema.String,
  pid: Schema.NullOr(Schema.Number),
});
const LockJson = Schema.fromJsonString(LockFile);
const decodeLock = Schema.decodeUnknownOption(LockJson);
const encodeLock = Schema.encodeSync(LockJson);

export interface EngineLockTiming {
  /** How often a waiting owner looks again. */
  readonly pollMs: number;
  /** A file without a pid, or unreadable, older than this lost its owner before the child started. */
  readonly startingGraceMs: number;
  /** After waiting this long for an identified former child, it is killed. */
  readonly staleEngineTimeoutMs: number;
}

const TOKEN_PATTERN = new RegExp(`${LOCK_TOKEN_FLAG}[ =](\\S+)`);

/** Live processes and their command lines, or null where `ps` cannot run. */
const processTable = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lines = yield* spawner.lines(ChildProcess.make("ps", ["-A", "-o", "pid=,command="]));
  const table = new Map<number, string>();
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null) table.set(Number(match[1]), match[2] ?? "");
  }
  return table;
}).pipe(Effect.orElseSucceed(() => null));

/** The lock token on a process's command line, if it is an engine child. */
const tokenOf = (command: string | undefined) =>
  command === undefined ? null : (TOKEN_PATTERN.exec(command)?.[1] ?? null);

const kill = (pid: number) => {
  try {
    NodeProcess.kill(pid, "SIGKILL");
  } catch {
    // Gone already.
  }
};

export interface EngineLockOutcome {
  /** A former child of this job this owner waited for, or killed after the timeout. */
  readonly waitedFor: {
    readonly pid: number;
    readonly token: string;
    readonly killed: boolean;
  } | null;
}

/** Writes this claim's own file; the temporary carries the same claim in its name. */
const writeOwn = Effect.fn("EngineLock.writeOwn")(function* (
  jobDir: string,
  claim: EngineClaim,
  pid: number | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(jobDir, LOCK_DIR);
  yield* fs.makeDirectory(dir, { recursive: true });
  const file = path.join(dir, fileNameOf(claim));
  const tmp = `${file}.tmp`;
  yield* fs.writeFileString(
    tmp,
    encodeLock({
      owner: claim.owner,
      generation: claim.generation,
      token: engineToken(claim),
      pid,
    }),
  );
  yield* fs.rename(tmp, file);
});

/**
 * Records this claim, then waits while another claim of the job may run an engine: a live
 * process with this job's token, or a foreign file still inside its starting grace. Foreign
 * files proved abandoned are deleted by exact name.
 */
export const acquireEngineLock = Effect.fn("EngineLock.acquire")(function* (
  jobDir: string,
  claim: EngineClaim,
  timing: EngineLockTiming,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(jobDir, LOCK_DIR);
  const ownName = fileNameOf(claim);
  const ownToken = engineToken(claim);
  yield* writeOwn(jobDir, claim, null);
  const waitStarted = yield* Clock.currentTimeMillis;
  let waitedFor: EngineLockOutcome["waitedFor"] = null;
  while (true) {
    const nowMs = yield* Clock.currentTimeMillis;
    const table = yield* processTable;
    const engines: Array<{ readonly pid: number; readonly token: string }> = [];
    for (const [pid, command] of table ?? []) {
      const token = tokenOf(command);
      if (token !== null && token !== ownToken && token.startsWith(`${claim.jobId}:`)) {
        engines.push({ pid, token });
      }
    }
    let starting = false;
    for (const name of yield* fs.readDirectory(dir)) {
      if (name === ownName || name === `${ownName}.tmp`) continue;
      const file = path.join(dir, name);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      // The file's own age, never the time of this look: an unreadable file ages too.
      const modifiedMs = Option.match(info.value.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      });
      const lock = Option.flatMap(yield* fs.readFileString(file).pipe(Effect.option), decodeLock);
      const identified =
        Option.isSome(lock) &&
        lock.value.pid !== null &&
        tokenOf(table?.get(lock.value.pid)) === lock.value.token;
      if (identified) continue;
      const namesPid = Option.isSome(lock) && lock.value.pid !== null;
      if (!namesPid && nowMs - modifiedMs <= timing.startingGraceMs) {
        starting = true;
        continue;
      }
      // Its child is gone or was never this job's engine, or it never got one.
      yield* fs.remove(file).pipe(Effect.ignore);
    }
    if (engines.length === 0 && !starting) return { waitedFor } satisfies EngineLockOutcome;
    const first = engines[0];
    if (first !== undefined) {
      const killed = nowMs - waitStarted > timing.staleEngineTimeoutMs;
      waitedFor = { pid: first.pid, token: first.token, killed };
      if (killed) for (const engine of engines) kill(engine.pid);
    }
    yield* Effect.sleep(`${timing.pollMs} millis`);
  }
});

/** Names the child in this claim's own file. */
export const recordEnginePid = (jobDir: string, claim: EngineClaim, pid: number) =>
  writeOwn(jobDir, claim, pid);

/** Deletes this claim's own file, by its exact name. */
export const releaseEngineLock = Effect.fn("EngineLock.release")(function* (
  jobDir: string,
  claim: EngineClaim,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.remove(path.join(jobDir, LOCK_DIR, fileNameOf(claim))).pipe(Effect.ignore);
});
