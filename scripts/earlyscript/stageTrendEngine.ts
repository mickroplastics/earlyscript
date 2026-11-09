// Bundles packages/trend-engine into the desktop app's resources, so the nightly run needs no
// checkout. The server looks for it under process.resourcesPath (apps/server/src/editorial/
// engineProcess.ts). Usage alone: node scripts/earlyscript/stageTrendEngine.ts <resources-dir>
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { build } from "vite-plus/pack";

/** Directory under the app's resources; engineProcess.ts names the same one. */
export const TREND_ENGINE_RESOURCE = "trend-engine";

// electron-builder always drops the node_modules at the root of a `from`; it gets its own entry.
export const TREND_ENGINE_EXTRA_RESOURCES = [
  { from: `apps/desktop/prod-resources/${TREND_ENGINE_RESOURCE}`, to: TREND_ENGINE_RESOURCE },
  {
    from: `apps/desktop/prod-resources/${TREND_ENGINE_RESOURCE}/node_modules`,
    to: `${TREND_ENGINE_RESOURCE}/node_modules`,
  },
] as const;

/** Keeps the engine out of app.asar: it runs as its own process from real paths. */
export const TREND_ENGINE_FILE_EXCLUSIONS = [
  `!apps/desktop/prod-resources/${TREND_ENGINE_RESOURCE}`,
  `!apps/desktop/prod-resources/${TREND_ENGINE_RESOURCE}/**/*`,
] as const;

// Native or self-locating packages stay out of the bundle and are copied with their own files.
const RUNTIME_EXTERNALS = ["@huggingface/transformers", "onnxruntime-node"];
const isRuntimeExternal = (id: string) =>
  RUNTIME_EXTERNALS.some((name) => id === name || id.startsWith(`${name}/`));
// transformers' Node build inlines the part of onnxruntime-web it uses; the package is 140 MB.
const SKIPPED_PACKAGES = new Set(["onnxruntime-web"]);

const NODE_PLATFORM = { mac: "darwin", linux: "linux", win: "win32" } as const;

export class TrendEngineStageError extends Schema.TaggedError<TrendEngineStageError>()(
  "TrendEngineStageError",
  { message: Schema.String },
) {}

const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));
const decodeModelStatus = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ status: Schema.String })),
);

export const stageTrendEngine = Effect.fn("stageTrendEngine")(function* (input: {
  readonly repoRoot: string;
  /** The engine lands in its `trend-engine`, which electron-builder copies to the resources. */
  readonly stageProdResourcesDir: string;
  readonly platform: keyof typeof NODE_PLATFORM;
  readonly arch: "arm64" | "x64" | "universal";
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArch = yield* HostProcess.Architecture;
  // The native runtime is copied from this machine's install, which only holds its own binaries.
  if (NODE_PLATFORM[input.platform] !== hostPlatform || input.arch !== hostArch) {
    yield* Effect.logWarning(
      `[desktop-artifact] Trend engine not bundled: ${input.platform}-${input.arch} differs from the host ${hostPlatform}-${hostArch}; the nightly run will report the engine missing.`,
    );
    return;
  }
  const engineDir = path.join(input.repoRoot, "packages/trend-engine");
  const outDir = path.join(input.stageProdResourcesDir, TREND_ENGINE_RESOURCE);
  yield* fs.remove(outDir, { recursive: true, force: true });

  yield* Effect.tryPromise({
    try: () =>
      build({
        config: false,
        cwd: engineDir,
        entry: { cli: "src/cli.ts", worker: "src/embed/worker.ts" },
        outDir: path.join(outDir, "dist"),
        format: "esm",
        platform: "node",
        dts: false,
        sourcemap: false,
        clean: true,
        deps: { alwaysBundle: (id) => !isRuntimeExternal(id), neverBundle: isRuntimeExternal },
        logLevel: "warn",
      }),
    catch: (cause) => new TrendEngineStageError({ message: `bundle failed: ${String(cause)}` }),
  });
  // dist/cli.mjs reads ../config/engine.v1.json, as src/cli.ts does.
  yield* fs.copy(path.join(engineDir, "config"), path.join(outDir, "config"));

  const nodeModules = path.join(outDir, "node_modules");
  const placed = new Map<string, string>();
  const findPackage = Effect.fn("stageTrendEngine.findPackage")(function* (
    name: string,
    fromDir: string,
  ) {
    for (let dir = fromDir; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", name);
      if (yield* fs.exists(path.join(candidate, "package.json"))) {
        return yield* fs.realPath(candidate);
      }
      if (path.dirname(dir) === dir) return null;
    }
  });
  // A flat tree like npm's: a second version of a name nests under the package that needs it.
  const copyPackage: (
    name: string,
    fromDir: string,
    parentDest: string,
    optional: boolean,
  ) => Effect.Effect<void, TrendEngineStageError | Schema.SchemaError | PlatformError> = Effect.fn(
    "stageTrendEngine.copyPackage",
  )(function* (name, fromDir, parentDest, optional) {
    if (SKIPPED_PACKAGES.has(name)) return;
    const real = yield* findPackage(name, fromDir);
    if (real === null) {
      if (optional) return;
      return yield* new TrendEngineStageError({
        message: `${name} is not installed beside ${fromDir}; run vp i`,
      });
    }
    const top = placed.get(name);
    if (top === real) return;
    const dest =
      top === undefined
        ? path.join(nodeModules, name)
        : path.join(parentDest, "node_modules", name);
    if (top === undefined) placed.set(name, real);
    else if (yield* fs.exists(dest)) return;
    yield* fs.copy(real, dest);
    // pnpm leaves a node_modules/.bin of links into its store inside some packages.
    yield* fs.remove(path.join(dest, "node_modules"), { recursive: true, force: true });
    const manifest = yield* decodeManifest(
      yield* fs.readFileString(path.join(real, "package.json")),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      yield* copyPackage(dependency, real, dest, false);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      yield* copyPackage(dependency, real, dest, true);
    }
  });
  for (const name of RUNTIME_EXTERNALS) yield* copyPackage(name, engineDir, outDir, false);

  // onnxruntime-node ships every platform's binaries; keep the target's.
  const onnxBin = path.join(nodeModules, "onnxruntime-node/bin/napi-v6");
  for (const platform of yield* fs.readDirectory(onnxBin)) {
    if (platform !== hostPlatform) {
      yield* fs.remove(path.join(onnxBin, platform), { recursive: true });
      continue;
    }
    for (const arch of yield* fs.readDirectory(path.join(onnxBin, platform))) {
      if (arch !== hostArch)
        yield* fs.remove(path.join(onnxBin, platform, arch), { recursive: true });
    }
  }
  if (!(yield* fs.exists(path.join(onnxBin, hostPlatform, hostArch)))) {
    return yield* new TrendEngineStageError({
      message: `onnxruntime-node has no binary for ${hostPlatform}-${hostArch}`,
    });
  }
  yield* smokeTrendEngine(outDir);
  yield* Effect.log(`[desktop-artifact] Bundled the trend engine into ${outDir}.`);
});

/**
 * The bundle must start: `model status` loads every module of dist/cli.mjs and prints one JSON
 * line. A module that reads src at load or runs its own main (B4) fails here, not in the app.
 */
export const smokeTrendEngine = (outDir: string) => Effect.scoped(smokeTrendEngineScoped(outDir));
const smokeTrendEngineScoped = Effect.fn("smokeTrendEngine")(function* (outDir: string) {
  const path = yield* Path.Path;
  const node = yield* HostProcess.ExecutablePath;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(
      node,
      [
        path.join(outDir, "dist/cli.mjs"),
        "model",
        "status",
        "--models",
        path.join(outDir, "smoke-models-absent"),
      ],
      { cwd: outDir },
    ),
  );
  const text = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [text(child.stdout), text(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  const status = yield* decodeModelStatus(stdout.trim()).pipe(Effect.option);
  if (exitCode !== 0 || status._tag === "None") {
    return yield* new TrendEngineStageError({
      message: `the bundled engine does not start (exit ${exitCode}): ${stderr.trim().slice(-2000) || stdout.trim()}`,
    });
  }
});

if (import.meta.main) {
  const [resourcesDir] = process.argv.slice(2);
  if (resourcesDir === undefined) throw new Error("Usage: stageTrendEngine.ts <resources-dir>");
  const program = Effect.gen(function* () {
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    yield* stageTrendEngine({
      repoRoot: path.resolve(import.meta.dirname, "../.."),
      stageProdResourcesDir: path.resolve(resourcesDir),
      platform: platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux",
      arch: arch === "arm64" ? "arm64" : "x64",
    });
  });
  NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)));
}
