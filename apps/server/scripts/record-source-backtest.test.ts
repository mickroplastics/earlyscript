// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BACKTEST_SCHEMA_VERSION,
  backtestId,
  backtestLogicalHash,
} from "@earlyscript/trend-engine/backtest-report";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EditorialSourcesService from "../src/editorial/EditorialSourcesService.ts";
import * as EditorialDatabase from "../src/editorial/persistence/EditorialDatabase.ts";
import { makeTempDir, removeDir } from "../src/editorial/persistence/EditorialDatabase.testkit.ts";
import { RecordSourceBacktestError, runRecordSourceBacktest } from "./record-source-backtest.ts";

/** A report as `engine backtest` writes it, reduced to what the hash and the reader need. */
function report(options: {
  readonly candidateP5: number;
  readonly candidate?: ReadonlyArray<string>;
}) {
  const worse = options.candidateP5 < 0.98;
  const logical = {
    inputs: {
      baseline_sources: ["hn", "github"],
      candidate_sources: options.candidate ?? ["hn", "github", "npm"],
      truth_sources: ["hn", "github"],
    },
    total: {
      baseline: { mean_p_at_5: 1, median_lead_days: 1 },
      candidate: { mean_p_at_5: options.candidateP5, median_lead_days: 1 },
    },
    verdict: {
      verdict: worse ? "worse" : "not-worse",
      reasons: worse ? [`P@5 drops by ${1 - options.candidateP5} (tolerance 0.02)`] : [],
    },
  };
  const hash = backtestLogicalHash(logical);
  return {
    schema_version: BACKTEST_SCHEMA_VERSION,
    backtest_id: backtestId(hash),
    logical_hash: hash,
    logical,
  };
}

const write = (dir: string, name: string, value: unknown) => {
  const file = NodePath.join(dir, name);
  NodeFS.writeFileSync(file, JSON.stringify(value));
  return file;
};

/** Creates and migrates editorial.sqlite, then reads `source` back through the service. */
const entryOf = (dbPath: string, source: string) =>
  Effect.gen(function* () {
    const sources = yield* EditorialSourcesService.EditorialSourcesService;
    const view = yield* sources.list;
    return view.sources.find((entry) => entry.source === source)!;
  }).pipe(
    Effect.provide(
      EditorialSourcesService.layerWithCorpusDir(NodePath.dirname(dbPath)).pipe(
        Layer.provide(EditorialDatabase.layerFromPath(dbPath)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

const reasonOfError = (error: { readonly _tag: string }) =>
  error instanceof RecordSourceBacktestError ? error.reason : error._tag;

it.effect("records a not-worse backtest and refuses worse, tampered or mismatched ones", () => {
  const dir = makeTempDir();
  const dbPath = NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
  return Effect.gen(function* () {
    assert.isNull((yield* entryOf(dbPath, "npm")).backtestRunId);
    const record = (source: string, file: string) =>
      runRecordSourceBacktest({ databasePath: dbPath, source, backtestPath: file }).pipe(
        Effect.provide(NodeServices.layer),
      );
    const reasonOf = (source: string, file: string) =>
      record(source, file).pipe(Effect.flip, Effect.map(reasonOfError));

    const worse = write(dir, "worse.json", report({ candidateP5: 0.6 }));
    assert.strictEqual(yield* reasonOf("npm", worse), "worse");
    const tamperedReport = report({ candidateP5: 1 });
    tamperedReport.logical.total.candidate.mean_p_at_5 = 0.97;
    const tampered = write(dir, "tampered.json", tamperedReport);
    assert.strictEqual(yield* reasonOf("npm", tampered), "tampered-backtest");
    const good = report({ candidateP5: 0.99 });
    const goodFile = write(dir, "good.json", good);
    // The backtest adds npm: it cannot let wikipedia in, nor change the baseline.
    assert.strictEqual(yield* reasonOf("wikipedia", goodFile), "wrong-arms");
    assert.strictEqual(yield* reasonOf("hn", goodFile), "baseline-source");
    assert.strictEqual(yield* reasonOf("devto", goodFile), "unknown-source");
    const twoSources = write(
      dir,
      "two.json",
      report({ candidateP5: 1, candidate: ["hn", "github", "npm", "wikipedia"] }),
    );
    assert.strictEqual(yield* reasonOf("npm", twoSources), "wrong-arms");
    assert.strictEqual(
      yield* runRecordSourceBacktest({
        databasePath: NodePath.join(dir, "typo.sqlite"),
        source: "npm",
        backtestPath: goodFile,
      }).pipe(Effect.provide(NodeServices.layer), Effect.flip, Effect.map(reasonOfError)),
      "missing-database",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(dir, "typo.sqlite")));
    assert.isNull((yield* entryOf(dbPath, "npm")).backtestRunId);

    const result = yield* record("npm", goodFile);
    assert.strictEqual(result.backtestId, good.backtest_id);
    assert.strictEqual(result.logicalHash, good.logical_hash);
    const entry = yield* entryOf(dbPath, "npm");
    assert.strictEqual(entry.backtestRunId, good.backtest_id);
    // Recording unlocks the switch; it does not turn ranking on.
    assert.isFalse(entry.rank);
    assert.strictEqual(entry.rankBlocked, null);
  }).pipe(Effect.ensuring(removeDir(dir)));
});
