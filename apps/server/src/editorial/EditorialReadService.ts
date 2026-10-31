// @effect-diagnostics nodeBuiltinImport:off -- the default runs directory is derived from the home directory.
import * as NodeOS from "node:os";

import {
  EditorialReadError,
  type EditorialGetDossierInput,
  type EditorialGetInboxInput,
  type EditorialInbox,
  type EditorialRunSummary,
  type EditorialTrendDossier,
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
  affinityThreshold,
  compareTrends,
  DossierFile,
  evidenceRange,
  loadRunDossiers,
  RunFile,
  runSummary,
  toDossiers,
  type LoadedDossier,
} from "./dossierFormat.ts";

const EDITORIAL_RUNS_DIR_ENV = "EARLYSCRIPT_EDITORIAL_RUNS_DIR";
const DEFAULT_INBOX_LIMIT = 100;
const DEFAULT_EVIDENCE_LIMIT = 6;

export interface EditorialReadServiceShape {
  readonly listRuns: Effect.Effect<ReadonlyArray<EditorialRunSummary>, EditorialReadError>;
  readonly getInbox: (
    input: EditorialGetInboxInput,
  ) => Effect.Effect<EditorialInbox, EditorialReadError>;
  readonly getDossier: (
    input: EditorialGetDossierInput,
  ) => Effect.Effect<EditorialTrendDossier, EditorialReadError>;
}

/** Read-only view of the trend engine's runs on disk. MCP readers (U4) get only this service. */
export class EditorialReadService extends Context.Service<
  EditorialReadService,
  EditorialReadServiceShape
>()("t3/editorial/EditorialReadService") {}

interface LoadedRun {
  readonly summary: EditorialRunSummary;
  readonly affinityThreshold: number;
  readonly dossiers: ReadonlyArray<LoadedDossier>;
}

interface RunEntry {
  readonly directory: string;
  readonly run: RunFile;
  /** mtimes of run.json and every dossier file; a change reloads the run. */
  readonly version: string;
  readonly dossierPaths: ReadonlyArray<string>;
}

const decodeRunFile = Schema.decodeUnknownEffect(Schema.fromJsonString(RunFile));
const decodeDossierFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DossierFile));

const unreadable = (message: string) => new EditorialReadError({ reason: "unreadable", message });

export const makeWithRunsDir = Effect.fn("EditorialReadService.make")(function* (runsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cache = new Map<string, { readonly version: string; readonly run: LoadedRun }>();

  const mtimeOf = (file: string) =>
    fs
      .stat(file)
      .pipe(
        Effect.map((info) =>
          Option.match(info.mtime, { onNone: () => "0", onSome: (date) => String(date.getTime()) }),
        ),
      );

  // A directory is a run when it holds a readable run.json; anything else is skipped.
  const readRunEntry = Effect.fn("EditorialReadService.readRunEntry")(
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

  const runEntries = Effect.gen(function* () {
    const exists = yield* fs.exists(runsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [];
    const names = yield* fs
      .readDirectory(runsDir)
      .pipe(Effect.mapError(() => unreadable(`Cannot list ${runsDir}.`)));
    const entries = yield* Effect.forEach(names.toSorted(), readRunEntry, { concurrency: 4 });
    // Newest cutoff first; a rerun of the same cutoff sorts by when it finished.
    return entries
      .flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
      .toSorted(
        (a, b) =>
          b.run.cutoff_at.localeCompare(a.run.cutoff_at) ||
          (b.run.finished_at ?? "").localeCompare(a.run.finished_at ?? "") ||
          b.run.run_id.localeCompare(a.run.run_id),
      );
  });

  const loadRun = Effect.fn("EditorialReadService.loadRun")(function* (
    entry: RunEntry,
    isLatestRun: boolean,
  ) {
    const cacheKey = `${entry.run.run_id}:${isLatestRun}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.version === entry.version) return cached.run;
    const files = yield* Effect.forEach(
      entry.dossierPaths,
      (file) =>
        fs.readFileString(file).pipe(
          Effect.flatMap(decodeDossierFile),
          Effect.asSome,
          // One malformed dossier must not hide the rest of the run.
          Effect.catch((cause) =>
            Effect.logWarning("editorial: skipping unreadable dossier", { file, cause }).pipe(
              Effect.as(Option.none<DossierFile>()),
            ),
          ),
        ),
      { concurrency: 8 },
    );
    const dossiers = toDossiers(files.flatMap((file) => (Option.isSome(file) ? [file.value] : [])));
    const run: LoadedRun = {
      summary: runSummary(entry.run, dossiers.length),
      affinityThreshold: affinityThreshold(entry.run),
      dossiers: loadRunDossiers(entry.run.run_id, dossiers, { isLatestRun }),
    };
    cache.set(cacheKey, { version: entry.version, run });
    return run;
  });

  const findRun = Effect.fn("EditorialReadService.findRun")(function* (runId: string | undefined) {
    const entries = yield* runEntries;
    const latest = entries.find((entry) => entry.run.status === "ok") ?? entries[0];
    const entry =
      runId === undefined ? latest : entries.find((candidate) => candidate.run.run_id === runId);
    if (entry === undefined) {
      if (runId === undefined) return Option.none<LoadedRun>();
      return yield* new EditorialReadError({
        reason: "run-not-found",
        message: `Run ${runId} is not in the runs directory.`,
      });
    }
    return Option.some(yield* loadRun(entry, entry === latest));
  });

  const listRuns: EditorialReadServiceShape["listRuns"] = runEntries.pipe(
    Effect.map((entries) =>
      entries.map((entry) => runSummary(entry.run, entry.dossierPaths.length)),
    ),
    Effect.withSpan("EditorialReadService.listRuns"),
  );

  const getInbox: EditorialReadServiceShape["getInbox"] = Effect.fn(
    "EditorialReadService.getInbox",
  )(function* (input) {
    const sort = input.sort ?? "new-first-growth";
    const run = yield* findRun(input.runId);
    if (Option.isNone(run)) return { run: null, sort, trends: [], total: 0, newCount: 0 };
    const trends = run.value.dossiers
      .map((dossier) => dossier.summary)
      .toSorted(compareTrends(sort));
    const offset = input.offset ?? 0;
    return {
      run: run.value.summary,
      sort,
      trends: trends.slice(offset, offset + (input.limit ?? DEFAULT_INBOX_LIMIT)),
      total: trends.length,
      newCount: trends.filter((trend) => trend.isNew).length,
    };
  });

  const getDossier: EditorialReadServiceShape["getDossier"] = Effect.fn(
    "EditorialReadService.getDossier",
  )(function* (input) {
    const run = yield* findRun(input.runId);
    const dossier = Option.isSome(run)
      ? run.value.dossiers.find((candidate) => candidate.summary.dossierId === input.dossierId)
      : undefined;
    if (Option.isNone(run) || dossier === undefined) {
      return yield* new EditorialReadError({
        reason: "dossier-not-found",
        message: `Dossier ${input.dossierId} is not in run ${input.runId}.`,
      });
    }
    const offset = input.evidenceOffset ?? 0;
    return {
      trend: dossier.summary,
      run: run.value.summary,
      rankMethod: dossier.file.rankings.weighted.method,
      rankComponents: dossier.file.rankings.weighted.components,
      affinityThreshold: run.value.affinityThreshold,
      curve: dossier.curve,
      coverage: dossier.coverage,
      evidence: dossier.evidence.slice(
        offset,
        offset + (input.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT),
      ),
      evidenceTotal: dossier.evidence.length,
      evidenceOffset: offset,
      evidenceRange: evidenceRange(dossier.evidence),
    };
  });

  return EditorialReadService.of({ listRuns, getInbox, getDossier });
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
  EditorialReadService,
  resolveRunsDir.pipe(Effect.orDie, Effect.flatMap(makeWithRunsDir)),
);
