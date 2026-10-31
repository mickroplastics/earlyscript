#!/usr/bin/env node
// @effect-diagnostics preferSchemaOverJson:off - backtest.json is hashed as parsed, then decoded by checkBacktestReport.

// Records a not-worse source backtest (§23) whose arms are exactly {hn, github} and
// {hn, github, source}, against a truth of exactly {hn, github}; a provisional one only with
// --allow-provisional. It never switches `rank` on. Usage:
//   node apps/server/scripts/record-source-backtest.ts --db <editorial.sqlite> --source npm --backtest <backtest.json> [--allow-provisional]

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type SourceId } from "@earlyscript/editorial-contracts/source";
import {
  isCatalogSourceId,
  SOURCE_CATALOG,
  SOURCE_IDS,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import { backtestSummary, checkBacktestReport } from "@earlyscript/trend-engine/backtest-report";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import * as EditorialSourcesService from "../src/editorial/EditorialSourcesService.ts";
import * as EditorialDatabase from "../src/editorial/persistence/EditorialDatabase.ts";

export class RecordSourceBacktestError extends Schema.TaggedError<RecordSourceBacktestError>()(
  "RecordSourceBacktestError",
  {
    reason: Schema.Literals([
      "missing-database",
      "unreadable-backtest",
      "tampered-backtest",
      "unknown-source",
      "baseline-source",
      "wrong-arms",
      "wrong-truth",
      "worse",
      "provisional",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.reason}: ${this.detail}`;
  }
}

export interface RecordSourceBacktestResult {
  readonly source: SourceId;
  readonly backtestId: string;
  readonly logicalHash: string;
  readonly provisional: boolean;
  readonly databasePath: string;
}

const fail = (reason: RecordSourceBacktestError["reason"], detail: string) =>
  Effect.fail(new RecordSourceBacktestError({ reason, detail }));

/** The engine baseline of the catalog (hn and github): what every source is measured against. */
const ENGINE_BASELINE = SOURCE_IDS.filter((id) => SOURCE_CATALOG[id].engineBaseline);

/** The same set: no repeated id in `a`, and the same members as `expected`. */
export const exactSet = (a: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
  new Set(a).size === a.length &&
  new Set(expected).size === a.length &&
  expected.every((id) => a.includes(id));

export const runRecordSourceBacktest = Effect.fn("runRecordSourceBacktest")(function* (input: {
  readonly databasePath: string;
  readonly source: string;
  readonly backtestPath: string;
  readonly allowProvisional?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = path.resolve(input.databasePath);
  const source = input.source;
  if (!isCatalogSourceId(source)) return yield* fail("unknown-source", source);
  if (SOURCE_CATALOG[source].engineBaseline) {
    return yield* fail("baseline-source", `${source} is part of the engine baseline`);
  }

  const text = yield* fs.readFileString(path.resolve(input.backtestPath)).pipe(
    Effect.mapError(
      (cause) =>
        new RecordSourceBacktestError({
          reason: "unreadable-backtest",
          detail: String(cause),
        }),
    ),
  );
  const checked = yield* Effect.try({
    try: () => checkBacktestReport(JSON.parse(text)),
    catch: (cause) =>
      new RecordSourceBacktestError({ reason: "unreadable-backtest", detail: String(cause) }),
  });
  if (!checked.ok) return yield* fail("tampered-backtest", checked.problems.join("; "));
  const { inputs, verdict, status } = checked.report.logical;
  if (
    !exactSet(inputs.baseline_sources, ENGINE_BASELINE) ||
    !exactSet(inputs.candidate_sources, [...ENGINE_BASELINE, source])
  ) {
    return yield* fail(
      "wrong-arms",
      `the backtest compares ${inputs.baseline_sources.join(",")} with ` +
        `${inputs.candidate_sources.join(",")}, not ${ENGINE_BASELINE.join(",")} with ` +
        `${[...ENGINE_BASELINE, source].join(",")}`,
    );
  }
  // With the candidate among the truth sources, the source would confirm its own trends.
  if (!exactSet(inputs.truth_sources, ENGINE_BASELINE)) {
    return yield* fail(
      "wrong-truth",
      `the backtest labels against ${inputs.truth_sources.join(",")}, not ${ENGINE_BASELINE.join(",")}`,
    );
  }
  if (verdict.verdict !== "not-worse") {
    return yield* fail("worse", verdict.reasons.join("; "));
  }
  const provisional = status === "provisional";
  if (provisional && input.allowProvisional !== true) {
    return yield* fail(
      "provisional",
      "fewer than 7 cutoffs with a complete follow-up; record it on purpose with --allow-provisional",
    );
  }

  // An existing database only: a typo in --db must not create an empty one.
  if (!(yield* fs.exists(databasePath))) return yield* fail("missing-database", databasePath);
  yield* Effect.gen(function* () {
    const sources = yield* EditorialSourcesService.EditorialSourcesService;
    yield* sources.recordBacktest(source, {
      ...backtestSummary(checked.report),
      allowProvisional: provisional,
    });
  }).pipe(
    Effect.provide(
      // recordBacktest never reads the corpus; the directory only satisfies the constructor.
      EditorialSourcesService.layerWithCorpusDir(path.dirname(databasePath)).pipe(
        Layer.provide(EditorialDatabase.layerFromPath(databasePath)),
      ),
    ),
  );
  return {
    source,
    backtestId: checked.backtest_id,
    logicalHash: checked.recorded,
    provisional,
    databasePath,
  } satisfies RecordSourceBacktestResult;
});

const recordSourceBacktestCommand = Command.make(
  "record-source-backtest",
  {
    db: Flag.String("db").pipe(Flag.withDescription("Path of the editorial.sqlite to write.")),
    source: Flag.String("source").pipe(Flag.withDescription("Source id the backtest adds.")),
    backtest: Flag.String("backtest").pipe(
      Flag.withDescription("backtest.json written by `engine backtest`."),
    ),
    allowProvisional: Flag.Boolean("allow-provisional").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Record a provisional backtest (fewer than 7 cutoffs with a complete follow-up).",
      ),
    ),
  },
  ({ db, source, backtest, allowProvisional }) =>
    Effect.gen(function* () {
      const result = yield* runRecordSourceBacktest({
        databasePath: db,
        source,
        backtestPath: backtest,
        allowProvisional,
      });
      yield* Console.log(
        `Recorded ${result.backtestId} (${result.logicalHash})${result.provisional ? ", provisional," : ""} for ${result.source} in ${result.databasePath}.`,
      );
    }),
).pipe(
  Command.withDescription(
    "Record a not-worse source backtest so the source may be ranked by the engine.",
  ),
);

if (import.meta.main) {
  Command.run(recordSourceBacktestCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
