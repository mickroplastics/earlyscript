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
import * as Schema from "effect/Schema";

import * as EditorialSourcesService from "../src/editorial/EditorialSourcesService.ts";
import * as EditorialDatabase from "../src/editorial/persistence/EditorialDatabase.ts";
import { makeTempDir, removeDir } from "../src/editorial/persistence/EditorialDatabase.testkit.ts";
import {
  exactSet,
  RecordSourceBacktestError,
  runRecordSourceBacktest,
} from "./record-source-backtest.ts";

const arm = (p5: number | null, lead: number | null) => ({
  mean_p_at_5: p5,
  median_lead_days: lead,
});

/** A report as `engine backtest` writes it, reduced to what the hash and the reader need. */
function report(
  options: {
    readonly candidateP5?: number;
    readonly complete?: number;
    readonly baseline?: ReadonlyArray<string>;
    readonly candidate?: ReadonlyArray<string>;
    readonly truth?: ReadonlyArray<string>;
  } = {},
) {
  const candidateP5 = options.candidateP5 ?? 0.8;
  const complete = options.complete ?? 7;
  const worse = complete === 0 || candidateP5 < 0.78;
  const logical = {
    status: complete >= 7 ? "final" : "provisional",
    inputs: {
      baseline_sources: options.baseline ?? ["hn", "github"],
      candidate_sources: options.candidate ?? ["hn", "github", "npm"],
      truth_sources: options.truth ?? ["hn"],
      cutoffs: ["2026-10-17T00:00:00.000Z", "2026-10-30T00:00:00.000Z"],
    },
    total: {
      complete: {
        cutoffs: complete,
        emission_regressions: 0,
        baseline: complete === 0 ? arm(null, null) : arm(0.8, 1),
        candidate: complete === 0 ? arm(null, null) : arm(candidateP5, 1),
      },
      partial: {
        cutoffs: 14 - complete,
        emission_regressions: 0,
        baseline: arm(0.75, 1),
        candidate: arm(0.7, 1),
      },
    },
    verdict: {
      verdict: worse ? "worse" : "not-worse",
      reasons:
        complete === 0
          ? ["no cutoff with a complete follow-up"]
          : worse
            ? [`P@5 drops by ${0.8 - candidateP5} (tolerance 0.02)`]
            : [],
    },
  };
  const hash = backtestLogicalHash(logical);
  return {
    schema_version: BACKTEST_SCHEMA_VERSION,
    backtest_id: backtestId(hash),
    logical_hash: hash,
    created_at: "2026-10-31T09:30:00.000Z",
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

const isRecordError = Schema.is(RecordSourceBacktestError);
const reasonOfError = (error: { readonly _tag: string }) =>
  isRecordError(error) ? error.reason : error._tag;

it("compares sets exactly: a repeated id never stands for a missing one", () => {
  assert.isTrue(exactSet(["github", "hn"], ["hn", "github"]));
  assert.isFalse(exactSet(["hn", "hn"], ["hn", "github"]));
  assert.isFalse(exactSet(["hn", "hn", "npm"], ["hn", "github", "npm"]));
  assert.isFalse(exactSet(["hn", "github", "npm"], ["hn", "github"]));
});

it.effect("records a not-worse backtest with its summary and refuses the others", () => {
  const dir = makeTempDir();
  const dbPath = NodePath.join(dir, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
  return Effect.gen(function* () {
    assert.isNull((yield* entryOf(dbPath, "npm")).backtestRunId);
    const record = (source: string, file: string, allowProvisional = false) =>
      runRecordSourceBacktest({
        databasePath: dbPath,
        source,
        backtestPath: file,
        allowProvisional,
      }).pipe(Effect.provide(NodeServices.layer));
    const reasonOf = (source: string, file: string, allowProvisional = false) =>
      record(source, file, allowProvisional).pipe(Effect.flip, Effect.map(reasonOfError));

    assert.strictEqual(
      yield* reasonOf("npm", write(dir, "worse.json", report({ candidateP5: 0.6 }))),
      "worse",
    );
    const tamperedReport = report();
    tamperedReport.logical.total.complete.candidate.mean_p_at_5 = 0.7;
    assert.strictEqual(
      yield* reasonOf("npm", write(dir, "tampered.json", tamperedReport)),
      "tampered-backtest",
    );
    const goodFile = write(dir, "good.json", report());
    // The backtest adds npm: it cannot let wikipedia in, nor change the baseline.
    assert.strictEqual(yield* reasonOf("wikipedia", goodFile), "wrong-arms");
    assert.strictEqual(yield* reasonOf("hn", goodFile), "baseline-source");
    assert.strictEqual(yield* reasonOf("devto", goodFile), "unknown-source");
    const twoSources = report({ candidate: ["hn", "github", "npm", "wikipedia"] });
    assert.strictEqual(yield* reasonOf("npm", write(dir, "two.json", twoSources)), "wrong-arms");
    // R1: a repeated hn never stands for github, in either arm.
    const repeated = report({ baseline: ["hn", "hn"], candidate: ["hn", "hn", "npm"] });
    assert.strictEqual(yield* reasonOf("npm", write(dir, "dup.json", repeated)), "wrong-arms");
    const repeatedCandidate = report({ candidate: ["hn", "hn", "npm"] });
    assert.strictEqual(
      yield* reasonOf("npm", write(dir, "dup-candidate.json", repeatedCandidate)),
      "wrong-arms",
    );
    // R2: the candidate among the truth sources would confirm its own trends.
    const leak = report({ truth: ["hn", "github", "npm"] });
    assert.strictEqual(yield* reasonOf("npm", write(dir, "leak.json", leak)), "wrong-truth");
    const sampledTruth = report({ truth: ["hn", "github"] });
    assert.strictEqual(
      yield* reasonOf("npm", write(dir, "sampled-truth.json", sampledTruth)),
      "wrong-truth",
    );
    const oldSchema = { ...report(), schema_version: "earlyscript.backtest/2" };
    assert.strictEqual(
      yield* reasonOf("npm", write(dir, "old-schema.json", oldSchema)),
      "unreadable-backtest",
    );
    // R3: a provisional report needs --allow-provisional; no complete cutoff is worse anyway.
    const provisionalFile = write(dir, "provisional.json", report({ complete: 1 }));
    assert.strictEqual(yield* reasonOf("npm", provisionalFile), "provisional");
    assert.strictEqual(
      yield* reasonOf("npm", write(dir, "none.json", report({ complete: 0 })), true),
      "worse",
    );
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

    const good = report();
    const result = yield* record("npm", goodFile);
    assert.strictEqual(result.backtestId, good.backtest_id);
    assert.strictEqual(result.logicalHash, good.logical_hash);
    assert.isFalse(result.provisional);
    const entry = yield* entryOf(dbPath, "npm");
    assert.strictEqual(entry.backtestRunId, good.backtest_id);
    assert.deepInclude(entry.backtest!, {
      backtestId: good.backtest_id,
      experimentAt: "2026-10-31T09:30:00.000Z",
      cutoffFrom: "2026-10-17",
      cutoffTo: "2026-10-30",
      status: "final",
      verdict: "not-worse",
      completeCutoffs: 7,
      partialCutoffs: 7,
      p5Baseline: 0.8,
      p5Candidate: 0.8,
      leadBaseline: 1,
      leadCandidate: 1,
      partialP5Baseline: 0.75,
      partialP5Candidate: 0.7,
      allowProvisional: false,
    });
    // Recording unlocks the switch; it does not turn ranking on.
    assert.isFalse(entry.rank);
    assert.strictEqual(entry.rankBlocked, null);

    // The operator may record a provisional backtest on purpose; it stays marked as such.
    const provisional = yield* record("npm", provisionalFile, true);
    assert.isTrue(provisional.provisional);
    const marked = yield* entryOf(dbPath, "npm");
    assert.strictEqual(marked.backtest?.status, "provisional");
    assert.isTrue(marked.backtest?.allowProvisional);
    assert.strictEqual(marked.backtest?.completeCutoffs, 1);
    assert.strictEqual(marked.rankBlocked, null);
  }).pipe(Effect.ensuring(removeDir(dir)));
});
