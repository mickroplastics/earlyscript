#!/usr/bin/env node
// @effect-diagnostics preferSchemaOverJson:off - backtest.json is hashed as parsed, then decoded by checkBacktestReport.

// Records the backtest that lets a source into the engine (§18 `recordBacktest`, §23), only
// when the report checks out and its verdict is `not-worse`:
//   node apps/server/scripts/record-source-backtest.ts --db <dir>/editorial.sqlite --source npm --backtest <dir>/backtest.json
// It does not switch the source's `rank` on: the operator does that in Settings › Editorial.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type SourceId } from "@earlyscript/editorial-contracts/source";
import {
  isCatalogSourceId,
  SOURCE_CATALOG,
  SOURCE_IDS,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import { checkBacktestReport } from "@earlyscript/trend-engine/backtest-report";
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
      "worse",
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
  readonly databasePath: string;
}

const fail = (reason: RecordSourceBacktestError["reason"], detail: string) =>
  Effect.fail(new RecordSourceBacktestError({ reason, detail }));

/** The engine baseline of the catalog (hn and github): what every source is measured against. */
const ENGINE_BASELINE = SOURCE_IDS.filter((id) => SOURCE_CATALOG[id].engineBaseline);

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((x) => b.includes(x));

export const runRecordSourceBacktest = Effect.fn("runRecordSourceBacktest")(function* (input: {
  readonly databasePath: string;
  readonly source: string;
  readonly backtestPath: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databasePath = path.resolve(input.databasePath);
  const source = input.source;
  if (!isCatalogSourceId(source)) return yield* fail("unknown-source", source);
  if (SOURCE_CATALOG[source].engineBaseline) {
    return yield* fail("baseline-source", `${source} is part of the engine baseline`);
  }

  const text = yield* fs
    .readFileString(path.resolve(input.backtestPath))
    .pipe(Effect.mapError((cause) => new RecordSourceBacktestError({
      reason: "unreadable-backtest",
      detail: String(cause),
    })));
  const checked = yield* Effect.try({
    try: () => checkBacktestReport(JSON.parse(text)),
    catch: (cause) =>
      new RecordSourceBacktestError({ reason: "unreadable-backtest", detail: String(cause) }),
  });
  if (!checked.ok) return yield* fail("tampered-backtest", checked.problems.join("; "));
  const { inputs, verdict } = checked.report.logical;
  if (
    !sameSet(inputs.baseline_sources, ENGINE_BASELINE) ||
    !sameSet(inputs.candidate_sources, [...ENGINE_BASELINE, source])
  ) {
    return yield* fail(
      "wrong-arms",
      `the backtest compares ${inputs.baseline_sources.join(",")} with ` +
        `${inputs.candidate_sources.join(",")}, not ${ENGINE_BASELINE.join(",")} with ` +
        `${[...ENGINE_BASELINE, source].join(",")}`,
    );
  }
  if (verdict.verdict !== "not-worse") {
    return yield* fail("worse", verdict.reasons.join("; "));
  }

  // An existing database only: a typo in --db must not create an empty one.
  if (!(yield* fs.exists(databasePath))) return yield* fail("missing-database", databasePath);
  yield* Effect.gen(function* () {
    const sources = yield* EditorialSourcesService.EditorialSourcesService;
    yield* sources.recordBacktest(source, checked.backtest_id);
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
  },
  ({ db, source, backtest }) =>
    Effect.gen(function* () {
      const result = yield* runRecordSourceBacktest({
        databasePath: db,
        source,
        backtestPath: backtest,
      });
      yield* Console.log(
        `Recorded ${result.backtestId} (${result.logicalHash}) for ${result.source} in ${result.databasePath}.`,
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
