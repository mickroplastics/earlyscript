// @effect-diagnostics nodeBuiltinImport:off -- the engine package is found through its module URL; a former child is ended by pid.
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { restrictedNodeArgs, sandboxArgs } from "@earlyscript/engine-lab/sandbox";
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
const MODELS_DIR_ENV = "EARLYSCRIPT_EDITORIAL_MODELS_DIR";

/** The desktop app's copy, staged under its resources by scripts/earlyscript/stageTrendEngine.ts. */
const BUNDLED_ENGINE_CLI = ["trend-engine", "dist", "cli.mjs"] as const;

/** Where the trend engine lives: its CLI and the configuration a run reads by default. */
export interface EngineLocation {
  readonly cli: string;
  readonly defaultConfig: string;
}

/** No candidate CLI exists; the job reports `engine_missing`. */
export class EngineNotFound extends Schema.TaggedError<EngineNotFound>()("EngineNotFound", {
  message: Schema.String,
}) {}

export interface EngineSearch {
  /** `EARLYSCRIPT_ENGINE_CLI`; when set, the only candidate. */
  readonly configured: Option.Option<string>;
  /** Electron's resources directory, also under `ELECTRON_RUN_AS_NODE`; absent under Node. */
  readonly resourcesPath: string | undefined;
  /** `packages/trend-engine/src/cli.ts`; absent where the package does not resolve (the bundle). */
  readonly workspaceCli: string | undefined;
}

/**
 * The first CLI that exists: the configured one, else the app's bundled copy, else this
 * workspace's sources. Development Electron has resources too, without the engine in them.
 */
export const locateEngine = Effect.fn("EditorialEngine.locate")(function* (search: EngineSearch) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = Option.match(search.configured, {
    onSome: (file) => [path.resolve(file)],
    onNone: () => [
      ...(search.resourcesPath === undefined
        ? []
        : [path.join(search.resourcesPath, ...BUNDLED_ENGINE_CLI)]),
      ...(search.workspaceCli === undefined ? [] : [search.workspaceCli]),
    ],
  });
  for (const cli of candidates) {
    if (yield* fs.exists(cli).pipe(Effect.orElseSucceed(() => false))) {
      return {
        cli,
        defaultConfig: path.join(path.dirname(path.dirname(cli)), "config", "engine.v1.json"),
      } satisfies EngineLocation;
    }
  }
  return yield* new EngineNotFound({
    message: `No trend engine CLI at ${candidates.join(", ") || "any known path"}`,
  });
});

const workspaceEngineCli = () => {
  try {
    const run = NodeURL.fileURLToPath(import.meta.resolve("@earlyscript/trend-engine/run"));
    return run.replace(/run\.ts$/, "cli.ts");
  } catch {
    return undefined;
  }
};

/** This process's engine: its environment, Electron's resources, then this workspace. */
export const resolveEngineLocation = Effect.gen(function* () {
  const configured = yield* Config.String(ENGINE_CLI_ENV).pipe(Config.option);
  const resourcesPath: unknown = Reflect.get(NodeProcess, "resourcesPath");
  return yield* locateEngine({
    configured,
    resourcesPath: typeof resourcesPath === "string" ? resourcesPath : undefined,
    workspaceCli: workspaceEngineCli(),
  });
});

/**
 * The model directory every engine command gets: `EARLYSCRIPT_EDITORIAL_MODELS_DIR`, or null
 * for the engine's own default (`~/earlyscript-data/models/<revision>`, `defaultModelDir`).
 */
export const resolveModelsDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.String(MODELS_DIR_ENV).pipe(Config.option);
  return Option.match(configured, { onNone: () => null, onSome: (dir) => path.resolve(dir) });
});

/** `--models <dir>` when a directory is configured; nothing leaves the engine's default. */
export const modelsArgs = (modelsDir: string | null): ReadonlyArray<string> =>
  modelsDir === null ? [] : ["--models", modelsDir];

export interface EngineInvocation {
  readonly args: ReadonlyArray<string>;
  /** Receives both streams as they arrive, after the command line. */
  readonly logFile: string;
  /** Called for each stderr line, where the engine reports progress as JSON. */
  readonly onStderrLine?: (line: string) => Effect.Effect<void>;
  /** Called for each stdout line, for commands that print progress there (`model prepare`). */
  readonly onStdoutLine?: (line: string) => Effect.Effect<void>;
  /** Runs once the child exists; a failure here kills it. */
  readonly onSpawn?: (pid: number) => Effect.Effect<void, EngineSpawnRejected>;
  /**
   * Runs the engine in bwrap: no network, the user trees hidden, an empty environment, and
   * only these paths mounted back. For an engine that is not the installed one.
   */
  readonly sandbox?: EngineSandbox;
}

export interface EngineSandbox {
  readonly readOnly: ReadonlyArray<string>;
  readonly writable: ReadonlyArray<string>;
  /** The child's HOME and working directory, writable. */
  readonly home: string;
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
  const sandbox = invocation.sandbox;
  // bwrap binds only paths that exist: the runs directory and the cache's may not yet.
  if (sandbox !== undefined) {
    for (const dir of [sandbox.home, ...sandbox.writable]) {
      if (!(yield* fs.exists(dir))) yield* fs.makeDirectory(dir, { recursive: true });
    }
  }
  const [command, commandArgs] =
    sandbox === undefined
      ? [node, args]
      : [
          "bwrap",
          [
            ...sandboxArgs({
              readOnly: sandbox.readOnly,
              writable: sandbox.writable,
              out: sandbox.home,
              // The desktop app's executable is Electron; this makes it behave as Node.
              env: { ELECTRON_RUN_AS_NODE: "1" },
            }),
            node,
            // Node's own restrictions inside bwrap: no code from strings, reads and writes only
            // where bwrap mounted, no child processes, workers, addons or network.
            ...restrictedNodeArgs({
              read: sandbox.readOnly,
              write: [sandbox.home, ...sandbox.writable],
            }),
            ...args,
          ],
        ];
  // The launch line names the Node restrictions too, but not the bwrap mounts.
  const nodeFlags =
    sandbox === undefined
      ? []
      : (commandArgs as ReadonlyArray<string>).filter(
          (arg) => arg === "--permission" || arg === "--disallow-code-generation-from-strings",
        );
  yield* fs.writeFileString(
    invocation.logFile,
    `$ ${sandbox === undefined ? "" : "[bwrap] "}node ${[...nodeFlags, ...args].join(" ")}\n`,
    { flag: "a" },
  );
  const append = (chunk: Uint8Array) => fs.writeFile(invocation.logFile, chunk, { flag: "a" });
  const onLine = invocation.onStderrLine ?? (() => Effect.void);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          command,
          commandArgs,
          sandbox === undefined
            ? {
                cwd: path.dirname(engine.cli),
                // The desktop app's executable is Electron; this makes it behave as Node.
                env: { ELECTRON_RUN_AS_NODE: "1" },
                extendEnv: true,
                forceKillAfter: "5 seconds",
              }
            : {
                cwd: sandbox.home,
                // Nothing of the server's environment, its credentials included, reaches it.
                env: { PATH: "/usr/bin:/bin" },
                extendEnv: false,
                forceKillAfter: "5 seconds",
              },
        ),
      );
      if (invocation.onSpawn !== undefined) yield* invocation.onSpawn(Number(child.pid));
      const [stdout] = yield* Effect.all(
        [
          invocation.onStdoutLine === undefined
            ? child.stdout.pipe(Stream.tap(append), Stream.decodeText, Stream.mkString)
            : child.stdout.pipe(
                Stream.tap(append),
                Stream.decodeText,
                Stream.splitLines,
                Stream.tap(invocation.onStdoutLine),
                Stream.map((line) => `${line}\n`),
                Stream.mkString,
              ),
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
