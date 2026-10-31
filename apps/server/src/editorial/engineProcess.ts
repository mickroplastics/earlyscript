// @effect-diagnostics nodeBuiltinImport:off -- the engine package is found through its module URL; a former child is ended by pid.
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const ENGINE_CLI_ENV = "EARLYSCRIPT_ENGINE_CLI";

/** Where the trend engine lives: its CLI and the configuration a run reads by default. */
export interface EngineLocation {
  readonly cli: string;
  readonly defaultConfig: string;
}

/**
 * `EARLYSCRIPT_ENGINE_CLI`, or `packages/trend-engine/src/cli.ts` of this workspace. The
 * engine runs from its TypeScript sources under the server's own Node, as `engine` does.
 */
export const resolveEngineLocation = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.String(ENGINE_CLI_ENV).pipe(Config.option);
  const cli = Option.match(configured, {
    onNone: () =>
      path.join(
        path.dirname(NodeURL.fileURLToPath(import.meta.resolve("@earlyscript/trend-engine/run"))),
        "cli.ts",
      ),
    onSome: (file) => path.resolve(file),
  });
  return {
    cli,
    defaultConfig: path.join(path.dirname(path.dirname(cli)), "config", "engine.v1.json"),
  } satisfies EngineLocation;
});

export interface EngineInvocation {
  readonly args: ReadonlyArray<string>;
  /** Receives both streams as they arrive, after the command line. */
  readonly logFile: string;
  /** Called for each stderr line, where the engine reports progress as JSON. */
  readonly onStderrLine?: (line: string) => Effect.Effect<void>;
  /** Runs once the child exists; a failure here kills it. */
  readonly onSpawn?: (pid: number) => Effect.Effect<void, EngineSpawnRejected>;
}

/** `onSpawn` refused the child it was given, which is killed. */
export class EngineSpawnRejected extends Schema.TaggedError<EngineSpawnRejected>()(
  "EngineSpawnRejected",
  { message: Schema.String },
) {}

export interface EngineOutput {
  readonly exitCode: number;
  readonly stdout: string;
}

/**
 * Runs one engine command as a child of the server and waits for it. Interrupting the caller
 * (a server shutdown) kills the child, so a lease never outlives the process that took it.
 */
export const runEngineCommand = Effect.fn("EditorialEngine.run")(function* (
  engine: EngineLocation,
  invocation: EngineInvocation,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const args = [engine.cli, ...invocation.args];
  yield* fs.writeFileString(invocation.logFile, `$ node ${args.join(" ")}\n`, { flag: "a" });
  const append = (chunk: Uint8Array) => fs.writeFile(invocation.logFile, chunk, { flag: "a" });
  const onLine = invocation.onStderrLine ?? (() => Effect.void);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(node, args, {
          cwd: path.dirname(engine.cli),
          // The desktop app's executable is Electron; this makes it behave as Node.
          env: { ELECTRON_RUN_AS_NODE: "1" },
          extendEnv: true,
          forceKillAfter: "5 seconds",
        }),
      );
      if (invocation.onSpawn !== undefined) yield* invocation.onSpawn(Number(child.pid));
      const [stdout] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.tap(append), Stream.decodeText, Stream.mkString),
          child.stderr.pipe(
            Stream.tap(append),
            Stream.decodeText,
            Stream.splitLines,
            Stream.runForEach(onLine),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = yield* child.exitCode;
      return { exitCode: Number(exitCode), stdout } satisfies EngineOutput;
    }),
  );
});

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The last line of stdout that parses as JSON: the engine prints its result there. */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  for (const line of lines.toReversed()) {
    const value = decodeJsonLine(line);
    if (Option.isSome(value)) return value.value;
  }
  return null;
}

/**
 * The server tags every engine child with `--lock-token <job>:<owner>:<generation>`, which
 * the CLI accepts and ignores. A process is that child only if `ps` shows the token, so a
 * recycled pid is never waited for or killed.
 */
export const LOCK_TOKEN_FLAG = "--lock-token";

const TOKEN_PATTERN = new RegExp(`${LOCK_TOKEN_FLAG}[ =](\\S+)`);

/** Pids of live processes that carry `token`; null where `ps` cannot run (Windows). */
export const processesWithToken = Effect.fn("EditorialEngine.processesWithToken")(function* (
  token: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const lines = yield* spawner
    .lines(ChildProcess.make("ps", ["-A", "-o", "pid=,command="]))
    .pipe(Effect.option);
  if (Option.isNone(lines)) return null;
  const pids: Array<number> = [];
  for (const line of lines.value) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match !== null && TOKEN_PATTERN.exec(match[2] ?? "")?.[1] === token) {
      pids.push(Number(match[1]));
    }
  }
  return pids;
});

export const killProcess = (pid: number) => {
  try {
    NodeProcess.kill(pid, "SIGKILL");
  } catch {
    // Gone already.
  }
};
