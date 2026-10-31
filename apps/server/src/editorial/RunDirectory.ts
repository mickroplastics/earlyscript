// @effect-diagnostics nodeBuiltinImport:off -- the default runs directory is derived from the home directory, and files are hashed.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  EditorialReadError,
  type EditorialRunSummary,
  type EditorialSkippedFile,
} from "@t3tools/contracts";
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

/** A directory whose run.json exists but does not read or decode. */
export interface InvalidRunDirectory {
  readonly directory: string;
  /** The folder name: the index's run id when no indexed run lived in this directory. */
  readonly name: string;
  readonly reason: string;
  /** The mtime of run.json; a change reads it again. */
  readonly version: string;
}

export interface RunScan {
  readonly entries: ReadonlyArray<RunEntry>;
  readonly invalid: ReadonlyArray<InvalidRunDirectory>;
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
  /**
   * sha256 over run.json, every dossier hash and every skipped file with its reason: changes
   * only when the content or the inventory of unreadable files does.
   */
  readonly contentHash: string;
  /** Dossier files that did not decode, with the reason; the rest of the run still loads. */
  readonly skippedFiles: ReadonlyArray<EditorialSkippedFile>;
}

export interface EditorialRunDirectoryShape {
  readonly runsDir: string;
  /** Newest cutoff first; a rerun of the same cutoff sorts by when it finished. */
  readonly entries: Effect.Effect<ReadonlyArray<RunEntry>, EditorialReadError>;
  /** The entries and the directories whose run.json does not decode, for the importer. */
  readonly scan: Effect.Effect<RunScan, EditorialReadError>;
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

/** Long enough to tell a syntax error from a schema mismatch, short enough for a list. */
const MAX_REASON_LENGTH = 300;

const reasonOf = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const line = message.replace(/\s+/g, " ").trim();
  return line.length > MAX_REASON_LENGTH ? `${line.slice(0, MAX_REASON_LENGTH - 1)}…` : line;
};

type DirectoryRead =
  | { readonly _tag: "run"; readonly entry: RunEntry }
  | { readonly _tag: "invalid"; readonly invalid: InvalidRunDirectory };

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

  // A directory is a run when it holds run.json. One that does not decode is reported, so
  // the index can show it; a directory without run.json is not a run and is skipped.
  const readRunEntry = Effect.fn("EditorialRunDirectory.readRunEntry")(
    function* (name: string) {
      const directory = path.join(runsDir, name);
      const runJson = path.join(directory, "run.json");
      const runMtime = yield* mtimeOf(runJson).pipe(Effect.option);
      if (Option.isNone(runMtime)) return Option.none<DirectoryRead>();
      const decoded = yield* Effect.result(
        fs.readFileString(runJson).pipe(Effect.flatMap(decodeRunFile)),
      );
      if (decoded._tag === "Failure") {
        const reason = reasonOf(decoded.failure);
        yield* Effect.logWarning("editorial: run.json does not decode", { name, reason });
        return Option.some<DirectoryRead>({
          _tag: "invalid",
          invalid: { directory, name, reason, version: `invalid|${runMtime.value}` },
        });
      }
      const run = decoded.success;
      const dossierDir = path.join(directory, "dossiers");
      const dossierNames = yield* fs
        .readDirectory(dossierDir)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const dossierPaths = dossierNames
        .filter((file) => file.endsWith(".json"))
        .toSorted()
        .map((file) => path.join(dossierDir, file));
      const mtimes = yield* Effect.forEach(dossierPaths, mtimeOf, { concurrency: 8 });
      const entry: RunEntry = {
        directory,
        run,
        version: [...dossierPaths, runMtime.value, ...mtimes].join("|"),
        dossierPaths,
      };
      return Option.some<DirectoryRead>({ _tag: "run", entry });
    },
    (effect, name) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logDebug("editorial: skipping run directory", { name, cause }).pipe(
            Effect.as(Option.none<DirectoryRead>()),
          ),
        ),
      ),
  );

  const scan: EditorialRunDirectoryShape["scan"] = Effect.gen(function* () {
    const exists = yield* fs.exists(runsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return { entries: [], invalid: [] };
    const names = yield* fs
      .readDirectory(runsDir)
      .pipe(Effect.mapError(() => unreadable(`Cannot list ${runsDir}.`)));
    const read = yield* Effect.forEach(names.toSorted(), readRunEntry, { concurrency: 4 });
    const found = read.flatMap((item) => (Option.isSome(item) ? [item.value] : []));
    return {
      entries: found
        .flatMap((item) => (item._tag === "run" ? [item.entry] : []))
        .toSorted(
          (a, b) =>
            b.run.cutoff_at.localeCompare(a.run.cutoff_at) ||
            (b.run.finished_at ?? "").localeCompare(a.run.finished_at ?? "") ||
            b.run.run_id.localeCompare(a.run.run_id),
        ),
      invalid: found.flatMap((item) => (item._tag === "invalid" ? [item.invalid] : [])),
    };
  }).pipe(Effect.withSpan("EditorialRunDirectory.scan"));

  const entries: EditorialRunDirectoryShape["entries"] = scan.pipe(
    Effect.map((result) => result.entries),
  );

  // One malformed dossier must not hide the rest of the run: it is listed with its reason.
  const readDossier = (file: string) =>
    Effect.result(
      fs
        .readFileString(file)
        .pipe(
          Effect.flatMap((text) =>
            decodeDossierFile(text).pipe(
              Effect.map((dossier) => ({ file, dossier, hash: sha256(text) })),
            ),
          ),
        ),
    ).pipe(
      Effect.tap((result) =>
        result._tag === "Failure"
          ? Effect.logWarning("editorial: skipping unreadable dossier", {
              file,
              cause: result.failure,
            })
          : Effect.void,
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
      const read = files.flatMap((result) => (result._tag === "Success" ? [result.success] : []));
      const skippedFiles = files.flatMap((result, index) =>
        result._tag === "Failure"
          ? [
              {
                file: path.relative(entry.directory, entry.dossierPaths[index]!),
                reason: reasonOf(result.failure),
              },
            ]
          : [],
      );
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
          [
            sha256(runJsonText),
            ...dossiers.map((d) => `${d.filePath}:${d.contentHash}`),
            ...skippedFiles.map((skipped) => `skipped:${skipped.file}:${skipped.reason}`),
          ].join("\n"),
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

  return EditorialRunDirectory.of({ runsDir, entries, scan, load, find });
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
