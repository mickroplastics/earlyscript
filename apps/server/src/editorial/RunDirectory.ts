// @effect-diagnostics nodeBuiltinImport:off -- the default runs directory is derived from the home directory, and files are hashed.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { EditorialReadError, type EditorialRunSummary } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  DossierFile,
  loadRunDossiers,
  RunFile,
  runSummary,
  type LoadedDossier,
} from "./dossierFormat.ts";

const EDITORIAL_RUNS_DIR_ENV = "EARLYSCRIPT_EDITORIAL_RUNS_DIR";

/** A directory of the runs directory that holds a readable run.json. */
export interface RunEntry {
  readonly directory: string;
  readonly run: RunFile;
  /** File names and mtimes of run.json and every dossier; a change reloads the run. */
  readonly version: string;
  readonly dossierPaths: ReadonlyArray<string>;
}

export interface IndexedDossier extends LoadedDossier {
  /** Relative to the run directory. */
  readonly filePath: string;
  /** sha256 of the file as read. */
  readonly contentHash: string;
}

export interface LoadedRun {
  readonly entry: RunEntry;
  readonly summary: EditorialRunSummary;
  readonly dossiers: ReadonlyArray<IndexedDossier>;
  /** sha256 over run.json and every dossier hash: changes only when the content does. */
  readonly contentHash: string;
  /** Dossier files that did not decode; the rest of the run still loads. */
  readonly skippedFiles: ReadonlyArray<string>;
}

export interface EditorialRunDirectoryShape {
  readonly runsDir: string;
  /** Newest cutoff first; a rerun of the same cutoff sorts by when it finished. */
  readonly entries: Effect.Effect<ReadonlyArray<RunEntry>, EditorialReadError>;
  /** Reloads only when the entry's files changed since the last load. */
  readonly load: (entry: RunEntry) => Effect.Effect<LoadedRun>;
  /** The run directory with this id, read again from disk. */
  readonly find: (runId: string) => Effect.Effect<Option.Option<RunEntry>, EditorialReadError>;
}

/**
 * The trend engine's runs on disk. Built once per server, so every connection and the
 * importer share one mtime cache. Never builds a path from client data: runs are found by
 * listing the directory and matching `run_id`.
 */
export class EditorialRunDirectory extends Context.Service<
  EditorialRunDirectory,
  EditorialRunDirectoryShape
>()("t3/editorial/RunDirectory/EditorialRunDirectory") {}

const decodeRunFile = Schema.decodeUnknownEffect(Schema.fromJsonString(RunFile));
const decodeDossierFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DossierFile));

const unreadable = (message: string) => new EditorialReadError({ reason: "unreadable", message });

const sha256 = (content: string) =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");

const makeWithRunsDir = Effect.fn("EditorialRunDirectory.make")(function* (runsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = new Map<string, LoadedRun>();

  const mtimeOf = (file: string) =>
    fs
      .stat(file)
      .pipe(
        Effect.map((info) =>
          Option.match(info.mtime, { onNone: () => "0", onSome: (date) => String(date.getTime()) }),
        ),
      );

  // A directory is a run when it holds a readable run.json; anything else is skipped.
  const readRunEntry = Effect.fn("EditorialRunDirectory.readRunEntry")(
    function* (name: string) {
      const directory = path.join(runsDir, name);
      const runJson = path.join(directory, "run.json");
      const run = yield* fs.readFileString(runJson).pipe(Effect.flatMap(decodeRunFile));
      const dossierDir = path.join(directory, "dossiers");
      const dossierNames = yield* fs
        .readDirectory(dossierDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const dossierPaths = dossierNames
        .filter((file) => file.endsWith(".json"))
        .toSorted()
        .map((file) => path.join(dossierDir, file));
      const mtimes = yield* Effect.forEach([runJson, ...dossierPaths], mtimeOf, {
        concurrency: 8,
      });
      const entry: RunEntry = {
        directory,
        run,
        version: [...dossierPaths, ...mtimes].join("|"),
        dossierPaths,
      };
      return Option.some(entry);
    },
    (effect, name) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logDebug("editorial: skipping run directory", { name, cause }).pipe(
            Effect.as(Option.none<RunEntry>()),
          ),
        ),
      ),
  );

  const entries: EditorialRunDirectoryShape["entries"] = Effect.gen(function* () {
    const exists = yield* fs.exists(runsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [];
    const names = yield* fs
      .readDirectory(runsDir)
      .pipe(Effect.mapError(() => unreadable(`Cannot list ${runsDir}.`)));
    const read = yield* Effect.forEach(names.toSorted(), readRunEntry, { concurrency: 4 });
    return read
      .flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
      .toSorted(
        (a, b) =>
          b.run.cutoff_at.localeCompare(a.run.cutoff_at) ||
          (b.run.finished_at ?? "").localeCompare(a.run.finished_at ?? "") ||
          b.run.run_id.localeCompare(a.run.run_id),
      );
  }).pipe(Effect.withSpan("EditorialRunDirectory.entries"));

  const readDossier = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap((text) =>
        decodeDossierFile(text).pipe(Effect.map((dossier) => ({ dossier, hash: sha256(text) }))),
      ),
      Effect.asSome,
      // One malformed dossier must not hide the rest of the run.
      Effect.catch((cause) =>
        Effect.logWarning("editorial: skipping unreadable dossier", { file, cause }).pipe(
          Effect.as(Option.none<{ readonly dossier: DossierFile; readonly hash: string }>()),
        ),
      ),
    );

  const load: EditorialRunDirectoryShape["load"] = Effect.fn("EditorialRunDirectory.load")(
    function* (entry) {
      const cached = cache.get(entry.directory);
      if (cached !== undefined && cached.entry.version === entry.version) return cached;
      const runJsonText = yield* fs
        .readFileString(path.join(entry.directory, "run.json"))
        .pipe(Effect.orElseSucceed(() => entry.version));
      const files = yield* Effect.forEach(entry.dossierPaths, readDossier, { concurrency: 8 });
      const read = entry.dossierPaths.flatMap((file, index) => {
        const result = files[index];
        return result !== undefined && Option.isSome(result) ? [{ file, ...result.value }] : [];
      });
      const skippedFiles = entry.dossierPaths
        .filter((_file, index) => Option.isNone(files[index] ?? Option.none()))
        .map((file) => path.relative(entry.directory, file));
      const loaded = loadRunDossiers(
        entry.run.run_id,
        read.map((item) => item.dossier),
      );
      const dossiers = loaded.map((dossier, index) => ({
        ...dossier,
        filePath: path.relative(entry.directory, read[index]!.file),
        contentHash: read[index]!.hash,
      }));
      const run: LoadedRun = {
        entry,
        summary: runSummary(entry.run, dossiers.length),
        dossiers,
        contentHash: sha256(
          [sha256(runJsonText), ...dossiers.map((d) => `${d.filePath}:${d.contentHash}`)].join(
            "\n",
          ),
        ),
        skippedFiles,
      };
      cache.set(entry.directory, run);
      return run;
    },
  );

  const find: EditorialRunDirectoryShape["find"] = (runId) =>
    entries.pipe(
      Effect.map((all) => Option.fromNullishOr(all.find((entry) => entry.run.run_id === runId))),
    );

  return EditorialRunDirectory.of({ runsDir, entries, load, find });
});

/** `EARLYSCRIPT_EDITORIAL_RUNS_DIR`, or `~/earlyscript-data/runs`. */
const resolveRunsDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.String(EDITORIAL_RUNS_DIR_ENV).pipe(Config.option);
  return Option.match(configured, {
    onNone: () => path.join(NodeOS.homedir(), "earlyscript-data", "runs"),
    onSome: (dir) => path.resolve(dir),
  });
});

export const layer = Layer.effect(
  EditorialRunDirectory,
  resolveRunsDir.pipe(Effect.orDie, Effect.flatMap(makeWithRunsDir)),
);

export const layerWithRunsDir = (runsDir: string) =>
  Layer.effect(EditorialRunDirectory, makeWithRunsDir(runsDir));
