// @effect-diagnostics nodeBuiltinImport:off - the tests copy run directories on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  addNativeFixtureRun,
  FIXTURE_RUN_ID,
  NATIVE_FIXTURE_RUN_ID,
  withEditorial,
} from "./editorialLayer.testkit.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";

// The native fixture's inputs: the key of a nightly job that would have produced it.
const CUTOFF = "2026-10-31T00:00:00.000Z";
const CONFIG_HASH = "sha256:290b9ddeec9bf5bc4e0512972d047c106623a3d050789fe0a8c145504d2e9095";
const PROFILE_HASH = "sha256:db510e303cb7f3cff7099230a00d36b1918f28a0e6aa6b8be01727649b8bb80d";
const SECOND_RUN_ID = "run_20261031_20261031T055000_abcdef";

/** Only the native fixture, alone in the runs directory. */
const nativeOnly = (runsDir: string) =>
  Effect.gen(function* () {
    yield* addNativeFixtureRun(runsDir);
    NodeFS.rmSync(NodePath.join(runsDir, FIXTURE_RUN_ID), { recursive: true });
  });

/** A second run with the same inputs and logical hash, under another id. */
const copyAs = (runsDir: string, runId: string) => {
  const target = NodePath.join(runsDir, runId);
  NodeFS.cpSync(NodePath.join(runsDir, NATIVE_FIXTURE_RUN_ID), target, { recursive: true });
  const file = NodePath.join(target, "run.json");
  const run = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>;
  NodeFS.writeFileSync(file, JSON.stringify({ ...run, run_id: runId }));
};

const insertJob = (status: string, acceptedRunId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* EditorialSql;
    yield* sql`
      INSERT INTO editorial_jobs (
        job_id, kind, profile_hash, cutoff_at, config_hash, timezone, scheduled_for,
        status, accepted_run_id, artifacts_json, created_at
      )
      VALUES (
        'job-1', 'daily', ${PROFILE_HASH}, ${CUTOFF}, ${CONFIG_HASH}, 'UTC', ${CUTOFF},
        ${status}, ${acceptedRunId}, '{}', ${CUTOFF}
      )
    `;
  });

const indexed = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const runs = yield* sql<{ readonly run_id: string }>`
    SELECT run_id FROM editorial_runs ORDER BY run_id
  `;
  const imported = yield* sql<{ readonly aggregate_id: string }>`
    SELECT aggregate_id FROM editorial_events WHERE type = 'run.imported'
  `;
  const excluded = yield* sql<{ readonly run_id: string; readonly reason: string }>`
    SELECT run_id, reason FROM editorial_run_exclusions ORDER BY run_id
  `;
  return {
    runs: runs.map((row) => row.run_id),
    imported: imported.length,
    excluded: excluded.map((row) => [row.run_id, row.reason] as const),
  };
});

const outcomes = (report: { readonly runs: ReadonlyArray<{ runId: string; outcome: string }> }) =>
  Object.fromEntries(report.runs.map((run) => [run.runId, run.outcome]));

describe("run admission", () => {
  it.effect("a second run with the same inputs and logical hash is a duplicate", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        yield* nativeOnly(dir);
        copyAs(dir, SECOND_RUN_ID);
        const importer = yield* EditorialImportService;
        const report = yield* importer.sync;
        assert.deepStrictEqual(outcomes(report), {
          [NATIVE_FIXTURE_RUN_ID]: "imported",
          [SECOND_RUN_ID]: "duplicate",
        });
        assert.deepStrictEqual(yield* indexed, {
          runs: [NATIVE_FIXTURE_RUN_ID],
          imported: 1,
          excluded: [[SECOND_RUN_ID, "duplicate"]],
        });
        // Decided once: a later pass neither imports it nor reports it again.
        assert.deepStrictEqual((yield* importer.sync).runs, []);
      }),
    ),
  );

  it.effect("a run that no nightly job shares is imported as before", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        yield* nativeOnly(dir);
        const report = yield* (yield* EditorialImportService).sync;
        assert.deepStrictEqual(outcomes(report), { [NATIVE_FIXTURE_RUN_ID]: "imported" });
      }),
    ),
  );

  it.effect("waits while the job of its inputs has not chosen, then takes only its choice", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        yield* nativeOnly(dir);
        const sql = yield* EditorialSql;
        const importer = yield* EditorialImportService;
        yield* insertJob("running", null);
        assert.deepStrictEqual(outcomes(yield* importer.sync), {
          [NATIVE_FIXTURE_RUN_ID]: "waiting",
        });
        assert.deepStrictEqual((yield* indexed).runs, []);

        // The job accepts the other one: the fixture is superseded, its choice imported.
        copyAs(dir, SECOND_RUN_ID);
        yield* sql`UPDATE editorial_jobs SET accepted_run_id = ${SECOND_RUN_ID}`;
        assert.deepStrictEqual(outcomes(yield* importer.sync), {
          [NATIVE_FIXTURE_RUN_ID]: "superseded",
          [SECOND_RUN_ID]: "imported",
        });
        assert.deepStrictEqual(yield* indexed, {
          runs: [SECOND_RUN_ID],
          imported: 1,
          excluded: [[NATIVE_FIXTURE_RUN_ID, "superseded"]],
        });
      }),
    ),
  );

  it.effect("a job that ended without choosing lets its runs in, deduplicated", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        yield* nativeOnly(dir);
        copyAs(dir, SECOND_RUN_ID);
        yield* insertJob("failed", null);
        const importer = yield* EditorialImportService;
        assert.deepStrictEqual(outcomes(yield* importer.sync), {
          [NATIVE_FIXTURE_RUN_ID]: "imported",
          [SECOND_RUN_ID]: "duplicate",
        });
        assert.deepStrictEqual(yield* importer.importRun(SECOND_RUN_ID), {
          runId: SECOND_RUN_ID,
          outcome: "duplicate",
          keptRunId: NATIVE_FIXTURE_RUN_ID,
        });
      }),
    ),
  );
});
