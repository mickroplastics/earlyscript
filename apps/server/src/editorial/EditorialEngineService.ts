// @effect-diagnostics nodeBuiltinImport:off -- the model location is shown with the home directory as `~`.
import * as NodeOS from "node:os";

import {
  EditorialModelErrorCode,
  type EditorialModelError,
  type EditorialModelState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import {
  lastJsonLine,
  modelsArgs,
  resolveEngineLocation,
  resolveModelsDir,
  runEngineCommand,
  type EngineLocation,
  type EngineNotFound,
} from "./engineProcess.ts";

/** Bytes per second are measured over this window, so one slow chunk does not swing them. */
const SPEED_WINDOW_MS = 5_000;

export interface EditorialEngineOptions {
  /** Found once at startup, as the nightly run does; without it the state says `engine_missing`. */
  readonly engine: Result.Result<EngineLocation, EngineNotFound>;
  /** `EARLYSCRIPT_EDITORIAL_MODELS_DIR`, or null for the engine's default (`resolveModelsDir`). */
  readonly modelsDir: string | null;
  /** Holds `model.log`, with every engine command and its output. */
  readonly logDir: string;
  /** Written `~` in `location`. */
  readonly homeDir: string;
}

export interface EditorialEngineServiceShape {
  /** Reads the disk again unless a download runs, and answers the state. */
  readonly modelStatus: Effect.Effect<EditorialModelState>;
  /** Starts `engine model prepare` once; while it runs, more calls only answer the state. */
  readonly prepareModel: Effect.Effect<EditorialModelState>;
  /** The state after a fresh look at the disk, then every change. */
  readonly watchModel: Stream.Stream<EditorialModelState>;
}

/** The local embedding model: its state on disk and the download the operator starts. */
export class EditorialEngineService extends Context.Service<
  EditorialEngineService,
  EditorialEngineServiceShape
>()("t3/editorial/EditorialEngineService") {}

const StatusLine = Schema.Struct({
  status: Schema.Literals(["ready", "missing", "partial"]),
  revision: Schema.String,
  path: Schema.String,
  bytesPresent: Schema.Number,
  bytesExpected: Schema.Number,
});
const decodeStatusLine = Schema.decodeUnknownOption(StatusLine);

const ProgressLine = Schema.Struct({
  file: Schema.String,
  bytesDone: Schema.Number,
  bytesTotal: Schema.Number,
  /** Bytes received by this process; `bytesDone` also counts what was on disk already. */
  sessionBytes: Schema.optionalKey(Schema.Number),
});
const ErrorLine = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const decodeLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([ProgressLine, ErrorLine])),
);
const isModelErrorCode = Schema.is(EditorialModelErrorCode);

/** One line of `engine model prepare`'s stdout, or null for anything else (`done`). */
export function parsePrepareLine(line: string):
  | {
      readonly _tag: "progress";
      readonly file: string;
      readonly bytesDone: number;
      readonly bytesTotal: number;
      /** Null from an engine that does not report it: then no speed is shown. */
      readonly sessionBytes: number | null;
    }
  | { readonly _tag: "error"; readonly error: EditorialModelError }
  | null {
  const decoded = decodeLine(line);
  if (Option.isNone(decoded)) return null;
  const value = decoded.value;
  if ("error" in value) {
    const code = value.error.code;
    return {
      _tag: "error",
      error: { code: isModelErrorCode(code) ? code : "other", message: value.error.message },
    };
  }
  return {
    _tag: "progress",
    file: value.file,
    bytesDone: value.bytesDone,
    bytesTotal: value.bytesTotal,
    sessionBytes: value.sessionBytes ?? null,
  };
}

/** Bytes per second between the oldest and newest sample of the window; null below a second. */
export function windowSpeed(samples: ReadonlyArray<{ at: number; bytes: number }>): number | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined || last.at - first.at < 1_000) return null;
  return ((last.bytes - first.bytes) * 1000) / (last.at - first.at);
}

const INITIAL: EditorialModelState = {
  status: "unknown",
  revision: null,
  path: null,
  location: null,
  bytesPresent: 0,
  bytesExpected: 0,
  download: null,
  error: null,
};

const makeWith = Effect.fn("EditorialEngineService.make")(function* (
  options: EditorialEngineOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The engine runs under the services the layer was built with, not the caller's.
  const context = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const state = yield* SubscriptionRef.make<EditorialModelState>(INITIAL);
  const samples = yield* Ref.make<Array<{ at: number; bytes: number }>>([]);
  const downloadScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(downloadScope, Exit.void));
  const logFile = path.join(options.logDir, "model.log");

  const displayLocation = (revisionDir: string) => {
    const parent = path.dirname(revisionDir);
    return parent === options.homeDir || parent.startsWith(`${options.homeDir}${path.sep}`)
      ? `~${parent.slice(options.homeDir.length)}`
      : parent;
  };

  const fail = (error: EditorialModelError) =>
    SubscriptionRef.update(state, (current) => ({ ...current, error }));

  const engineCommand = (
    engine: EngineLocation,
    args: ReadonlyArray<string>,
    onStdoutLine?: (line: string) => Effect.Effect<void>,
  ) =>
    fs.makeDirectory(options.logDir, { recursive: true }).pipe(
      Effect.andThen(
        runEngineCommand(engine, {
          args: ["model", ...args, ...modelsArgs(options.modelsDir)],
          logFile,
          ...(onStdoutLine === undefined ? {} : { onStdoutLine }),
        }),
      ),
      Effect.mapError((error) => ({ code: "engine_failed" as const, message: String(error) })),
      Effect.provide(context),
    );

  /** Asks the engine what is on disk; a failure lands in `error`, never in the caller. */
  const readDisk = Effect.gen(function* () {
    if (Result.isFailure(options.engine)) {
      return yield* fail({ code: "engine_missing", message: options.engine.failure.message });
    }
    const output = yield* engineCommand(options.engine.success, ["status"]).pipe(Effect.result);
    if (Result.isFailure(output)) return yield* fail(output.failure);
    const status = decodeStatusLine(lastJsonLine(output.success.stdout));
    if (Option.isNone(status)) {
      return yield* fail({
        code: "engine_failed",
        message: `engine model status exited with ${output.success.exitCode}`,
      });
    }
    const disk = status.value;
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: disk.status,
      revision: disk.revision,
      path: disk.path,
      location: displayLocation(disk.path),
      bytesPresent: disk.bytesPresent,
      bytesExpected: disk.bytesExpected,
      // A status that could be read clears a failure of the status itself.
      error:
        current.error?.code === "engine_failed" || current.error?.code === "engine_missing"
          ? null
          : current.error,
    }));
  });

  const refreshUnlessDownloading = Effect.gen(function* () {
    if ((yield* SubscriptionRef.get(state)).download === null) yield* readDisk;
  });

  const onPrepareLine = Effect.fn("EditorialEngineService.onPrepareLine")(function* (line: string) {
    const parsed = parsePrepareLine(line);
    if (parsed === null) return;
    // The download stays in flight until the process ends; the error shows after it.
    if (parsed._tag === "error") {
      return yield* SubscriptionRef.update(state, (current) => ({
        ...current,
        error: parsed.error,
      }));
    }
    const at = yield* Clock.currentTimeMillis;
    // Speed counts only what this process received: the files it verified and the partial
    // it adopted reach `bytesDone` in one jump and are not a transfer.
    const sessionBytes = parsed.sessionBytes;
    const window =
      sessionBytes === null
        ? []
        : yield* Ref.updateAndGet(samples, (current) =>
            [...current, { at, bytes: sessionBytes }].filter(
              (sample) => at - sample.at <= SPEED_WINDOW_MS,
            ),
          );
    yield* SubscriptionRef.update(state, (current) => {
      if (current.download === null) return current;
      // The engine counts from zero while it re-checks the finished files; the bar stays
      // where the disk already was until the count passes it.
      const bytesDone = Math.max(current.download.bytesDone, parsed.bytesDone);
      return {
        ...current,
        status: bytesDone > 0 && current.status === "missing" ? "partial" : current.status,
        bytesPresent: bytesDone,
        bytesExpected: parsed.bytesTotal,
        download: {
          ...current.download,
          file: parsed.file,
          bytesDone,
          bytesTotal: parsed.bytesTotal,
          bytesPerSecond: windowSpeed(window),
        },
      };
    });
  });

  const download = Effect.fn("EditorialEngineService.download")(
    function* (engine: EngineLocation) {
      const output = yield* engineCommand(engine, ["prepare"], onPrepareLine).pipe(Effect.result);
      const failed = (yield* SubscriptionRef.get(state)).error !== null;
      if (Result.isFailure(output)) {
        yield* fail(output.failure);
      } else if (output.success.exitCode !== 0 && !failed) {
        yield* fail({
          code: "engine_failed",
          message: `engine model prepare exited with ${output.success.exitCode}`,
        });
      }
    },
    (effect) =>
      effect.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            // `download` stays set until the disk was read again: it is what claims a download.
            yield* readDisk;
            yield* SubscriptionRef.update(state, (current) => ({ ...current, download: null }));
          }),
        ),
      ),
  );

  const prepareModel = Effect.gen(function* () {
    if (Result.isFailure(options.engine)) {
      yield* fail({ code: "engine_missing", message: options.engine.failure.message });
      return yield* SubscriptionRef.get(state);
    }
    const engine = options.engine.success;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    // One download at a time: the claim and the state that shows it are a single update.
    // A model already known ready, without an error, needs no download at all.
    const claimed = yield* SubscriptionRef.modify(state, (current) =>
      current.download !== null || (current.status === "ready" && current.error === null)
        ? [false, current]
        : [
            true,
            {
              ...current,
              error: null,
              download: {
                startedAt,
                file: null,
                bytesDone: current.bytesPresent,
                bytesTotal: current.bytesExpected,
                bytesPerSecond: null,
              },
            },
          ],
    );
    if (!claimed) return yield* SubscriptionRef.get(state);
    yield* Ref.set(samples, []);
    yield* download(engine).pipe(Effect.forkIn(downloadScope));
    return yield* SubscriptionRef.get(state);
  }).pipe(Effect.withSpan("EditorialEngineService.prepareModel"));

  const modelStatus = refreshUnlessDownloading.pipe(
    Effect.andThen(SubscriptionRef.get(state)),
    Effect.withSpan("EditorialEngineService.modelStatus"),
  );

  const watchModel = Stream.unwrap(
    refreshUnlessDownloading.pipe(Effect.as(SubscriptionRef.changes(state))),
  );

  return EditorialEngineService.of({ modelStatus, prepareModel, watchModel });
});

const resolveOptions = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const engine = yield* resolveEngineLocation.pipe(
    Effect.map(Result.succeed),
    Effect.catchTags({ EngineNotFound: (missing) => Effect.succeed(Result.fail(missing)) }),
  );
  return {
    engine,
    modelsDir: yield* resolveModelsDir,
    logDir: path.join(stateDir, "editorial-engine"),
    homeDir: NodeOS.homedir(),
  } satisfies EditorialEngineOptions;
});

export const layer = Layer.effect(
  EditorialEngineService,
  resolveOptions.pipe(Effect.orDie, Effect.flatMap(makeWith)),
);

export const layerWith = (options: EditorialEngineOptions) =>
  Layer.effect(EditorialEngineService, makeWith(options));
