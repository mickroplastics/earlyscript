// @effect-diagnostics nodeBuiltinImport:off -- the default runs directory is derived from the home directory.
import * as NodeOS from "node:os";

import { EditorialPresentationError } from "@t3tools/contracts";
import type {
  TrendPresentationEvidence,
  TrendPresentationTrend,
} from "@t3tools/provider-core/server/textGeneration";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { DossierFile, loadRunDossiers, RunFile } from "./dossierFormat.ts";

const EDITORIAL_RUNS_DIR_ENV = "EARLYSCRIPT_EDITORIAL_RUNS_DIR";
/** Evidence items sent to the assistant, in the engine's selection order. */
const PRESENTATION_EVIDENCE_LIMIT = 12;

/** What the assistant reads about one dossier: deterministic engine data and its evidence. */
export interface PresentationDossier {
  readonly runId: string;
  readonly dossierId: string;
  /** `trend_key` when the dossier has one, else `signal.id`, else the dossier id. */
  readonly trendKey: string;
  readonly trend: TrendPresentationTrend;
  readonly evidence: ReadonlyArray<TrendPresentationEvidence>;
}

export interface PresentationDossierSourceShape {
  /** Every dossier of the run, in file order. */
  readonly loadRun: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<PresentationDossier>, EditorialPresentationError>;
}

/**
 * Dossiers as the presentation service needs them. The read service's contract leaves out
 * evidence excerpts and the signal id, so this reads the same `dossier/1` files with the
 * shared `dossierFormat.ts` rules (ranks, coverage, link validation) plus those two fields.
 * When a shared run directory service exists, `layer` is the only thing to replace.
 */
export class PresentationDossierSource extends Context.Service<
  PresentationDossierSource,
  PresentationDossierSourceShape
>()("t3/editorial/presentationDossierSource") {}

// The fields `dossierFormat.ts` ignores and the assistant needs.
const PresentationExtras = Schema.Struct({
  trend_key: Schema.optionalKey(Schema.String),
  signal: Schema.Struct({ id: Schema.optionalKey(Schema.String) }),
  evidence: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        item_id: Schema.String,
        excerpt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const decodeRunFile = Schema.decodeUnknownEffect(Schema.fromJsonString(RunFile));
const decodeDossierFile = Schema.decodeUnknownEffect(Schema.fromJsonString(DossierFile));
const decodeExtras = Schema.decodeUnknownEffect(Schema.fromJsonString(PresentationExtras));

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
};

function toPresentationDossiers(
  runId: string,
  files: ReadonlyArray<{
    readonly file: DossierFile;
    readonly extras: typeof PresentationExtras.Type;
  }>,
): ReadonlyArray<PresentationDossier> {
  // Ranks are relative to the whole run, so every dossier of the run is loaded together.
  const loaded = loadRunDossiers(
    runId,
    files.map((entry) => entry.file),
    { isLatestRun: false },
  );
  return loaded.map((dossier, index) => {
    const extras = files[index]!.extras;
    const excerpts = new Map(
      (extras.evidence ?? []).map((item) => [item.item_id, item.excerpt ?? ""]),
    );
    const { summary } = dossier;
    return {
      runId,
      dossierId: summary.dossierId,
      trendKey: nonEmpty(extras.trend_key) ?? nonEmpty(extras.signal.id) ?? summary.dossierId,
      trend: {
        id: nonEmpty(extras.trend_key) ?? nonEmpty(extras.signal.id) ?? summary.dossierId,
        terms: summary.terms,
        items7d: summary.items7d,
        authors7d: summary.authors7d,
        // A dossier without the component reads as flat growth and no affinity, not as missing.
        growth: summary.growth ?? 0,
        affinity: summary.affinity ?? 0,
        volumeRank: summary.volumeRank,
        scoreRank: summary.scoreRank,
        sourceCount: summary.sourceCount,
        coverage: dossier.coverage.map((entry) => ({
          source: entry.source,
          daysComplete: entry.daysComplete,
          daysPartial: entry.daysPartial,
          daysUnavailable: entry.daysUnavailable,
        })),
      },
      evidence: dossier.evidence.slice(0, PRESENTATION_EVIDENCE_LIMIT).map((item) => ({
        itemId: item.itemId,
        source: item.source,
        title: item.title,
        excerpt: excerpts.get(item.itemId) ?? "",
        publishedAt: item.publishedAt,
        url: item.externalUrl ?? item.permalink ?? "",
      })),
    };
  });
}

const notFound = (runId: string) =>
  new EditorialPresentationError({
    reason: "run-not-found",
    message: `Run ${runId} is not in the runs directory.`,
  });

export const makeWithRunsDir = Effect.fn("PresentationDossierSource.make")(function* (
  runsDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Runs are found by listing the directory and matching `run_id`; the id never builds a path.
  const findRunDirectory = Effect.fn("PresentationDossierSource.findRunDirectory")(function* (
    runId: string,
  ) {
    const names = yield* fs
      .readDirectory(runsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const name of names.toSorted()) {
      const directory = path.join(runsDir, name);
      const run = yield* fs
        .readFileString(path.join(directory, "run.json"))
        .pipe(Effect.flatMap(decodeRunFile), Effect.option);
      if (Option.isSome(run) && run.value.run_id === runId) return Option.some(directory);
    }
    return Option.none<string>();
  });

  const loadRun: PresentationDossierSourceShape["loadRun"] = Effect.fn(
    "PresentationDossierSource.loadRun",
  )(function* (runId) {
    const directory = yield* findRunDirectory(runId);
    if (Option.isNone(directory)) return yield* notFound(runId);
    const dossierDir = path.join(directory.value, "dossiers");
    const names = yield* fs
      .readDirectory(dossierDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const files = yield* Effect.forEach(
      names.filter((name) => name.endsWith(".json")).toSorted(),
      (name) =>
        fs.readFileString(path.join(dossierDir, name)).pipe(
          Effect.flatMap((text) =>
            Effect.all({ file: decodeDossierFile(text), extras: decodeExtras(text) }),
          ),
          Effect.asSome,
          // Same rule as the read service: one malformed dossier does not hide the rest.
          Effect.catch((cause) =>
            Effect.logWarning("editorial: presentation skipping unreadable dossier", {
              name,
              cause,
            }).pipe(Effect.as(Option.none<never>())),
          ),
        ),
      { concurrency: 8 },
    );
    return toPresentationDossiers(
      runId,
      files.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : [])),
    );
  });

  return PresentationDossierSource.of({ loadRun });
});

/** Same directory as the read service: `EARLYSCRIPT_EDITORIAL_RUNS_DIR` or `~/earlyscript-data/runs`. */
const resolveRunsDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.String(EDITORIAL_RUNS_DIR_ENV).pipe(Config.option);
  return Option.match(configured, {
    onNone: () => path.join(NodeOS.homedir(), "earlyscript-data", "runs"),
    onSome: (dir) => path.resolve(dir),
  });
});

export const layer = Layer.effect(
  PresentationDossierSource,
  resolveRunsDir.pipe(Effect.orDie, Effect.flatMap(makeWithRunsDir)),
);
