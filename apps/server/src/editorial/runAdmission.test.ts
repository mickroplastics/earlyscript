// @effect-diagnostics nodeBuiltinImport:off - the tests copy run directories on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import {
  addNativeFixtureRun,
  FIXTURE_RUN_ID,
  NATIVE_FIXTURE_RUN_ID,
  withEditorial,
} from "./editorialLayer.testkit.ts";
import * as ImportModule from "./EditorialImportService.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import * as EditorialPersistence from "./persistenceLayer.ts";
import * as EditorialDatabase from "./persistence/EditorialDatabase.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { makeTempDir, removeDir } from "./persistence/EditorialDatabase.testkit.ts";
import { editorialMigrationEntries, makeEditorialMigrations } from "./persistence/Migrations.ts";
import * as RunDirectory from "./RunDirectory.ts";

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

/** Lets through `count` arrivals at once: each importer passed its admission shortcut. */
const makeLatch = (count: number) =>
  Effect.gen(function* () {
    const together = yield* Deferred.make<void>();
    let arrived = 0;
    return Effect.suspend(() => {
      arrived += 1;
      return arrived >= count ? Deferred.succeed(together, undefined) : Effect.void;
    }).pipe(Effect.andThen(Deferred.await(together)));
  });

/** The run directory of `base` whose `load` first passes `arrive`. */
const meetingAtLoad = <E, R>(
  base: Layer.Layer<RunDirectory.EditorialRunDirectory, E, R>,
  arrive: Effect.Effect<void>,
) =>
  Layer.effect(
    RunDirectory.EditorialRunDirectory,
    Effect.gen(function* () {
      const directory = yield* RunDirectory.EditorialRunDirectory;
      return {
        ...directory,
        load: (entry: RunDirectory.RunEntry) => arrive.pipe(Effect.andThen(directory.load(entry))),
      };
    }),
  ).pipe(Layer.provide(Layer.fresh(base)));

describe("run admission across importers", () => {
  it.live("two independent importers on one database index one of two identical runs", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        yield* nativeOnly(dir);
        copyAs(dir, SECOND_RUN_ID);
        yield* insertJob("failed", null);
        const arrive = yield* makeLatch(2);
        const shared = Layer.succeed(
          RunDirectory.EditorialRunDirectory,
          yield* RunDirectory.EditorialRunDirectory,
        );
        const fresh = Layer.build(
          Layer.fresh(ImportModule.layer.pipe(Layer.provide(meetingAtLoad(shared, arrive)))),
        ).pipe(Effect.map((context) => Context.get(context, EditorialImportService)));
        const a = yield* fresh;
        const b = yield* fresh;
        const reports = yield* Effect.all(
          [a.importRun(NATIVE_FIXTURE_RUN_ID), b.importRun(SECOND_RUN_ID)],
          { concurrency: 2 },
        );
        const result = yield* indexed;
        assert.strictEqual(result.runs.length, 1);
        assert.strictEqual(result.imported, 1);
        assert.deepStrictEqual(
          result.excluded.map(([, reason]) => reason),
          ["duplicate"],
        );
        assert.deepStrictEqual(reports.map((report) => report?.outcome).toSorted(), [
          "duplicate",
          "imported",
        ]);
      }).pipe(Effect.scoped),
    ),
  );

  it.live("two servers with their own connections index one of two identical runs", () => {
    const root = makeTempDir();
    const runsDir = NodePath.join(root, "runs");
    const dbPath = NodePath.join(root, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
    NodeFS.mkdirSync(runsDir);
    return Effect.gen(function* () {
      yield* addNativeFixtureRun(runsDir);
      copyAs(runsDir, SECOND_RUN_ID);
      const arrive = yield* makeLatch(2);
      // One server: its own SQLite connection, storage, run directory and importer.
      const server = Layer.fresh(
        ImportModule.layer.pipe(
          Layer.provideMerge(meetingAtLoad(RunDirectory.layerWithRunsDir(runsDir), arrive)),
          Layer.provideMerge(
            EditorialPersistence.layerFromDatabase(EditorialDatabase.layerFromPath(dbPath)),
          ),
        ),
      );
      const first = yield* Layer.build(server);
      const second = yield* Layer.build(server);
      yield* insertJob("failed", null).pipe(Effect.provide(first));
      const a = Context.get(first, EditorialImportService);
      const b = Context.get(second, EditorialImportService);
      assert.notStrictEqual(Context.get(first, EditorialSql), Context.get(second, EditorialSql));
      const reports = yield* Effect.all(
        [a.importRun(NATIVE_FIXTURE_RUN_ID), b.importRun(SECOND_RUN_ID)],
        { concurrency: 2 },
      );
      const result = yield* indexed.pipe(Effect.provide(second));
      assert.strictEqual(result.runs.length, 1);
      assert.strictEqual(result.imported, 1);
      assert.deepStrictEqual(
        result.excluded.map(([, reason]) => reason),
        ["duplicate"],
      );
      assert.deepStrictEqual(reports.map((report) => report?.outcome).toSorted(), [
        "duplicate",
        "imported",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.ensuring(removeDir(root)));
  });

  it.effect("a database with rows indexed before 010 opens, and the index rejects copies", () => {
    const root = makeTempDir();
    const dbPath = NodePath.join(root, EditorialDatabase.EDITORIAL_DATABASE_FILENAME);
    const onFile = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const insertRun = (runId: string, profileHash: string | null) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO editorial_runs (
            run_id, cutoff_at, engine_status, config_hash, logical_hash, sources_json,
            coverage_json, artifact_path, artifact_version, dossier_count, import_state,
            skipped_files_json, imported_at, updated_at
          )
          VALUES (
            ${runId}, ${CUTOFF}, 'ok', ${CONFIG_HASH}, 'sha256:same', '[]', 'null',
            ${`/runs/${runId}`}, 'v', 0, 'imported', '[]', ${CUTOFF}, ${CUTOFF}
          )
        `;
        if (profileHash !== null) {
          yield* sql`UPDATE editorial_runs SET profile_hash = ${profileHash} WHERE run_id = ${runId}`;
        }
      });
    return Effect.gen(function* () {
      // Two identical runs indexed by main, which has no profile_hash column yet.
      yield* onFile(
        makeEditorialMigrations(editorialMigrationEntries.filter(([id]) => id <= 9)).run(),
      );
      yield* onFile(insertRun("run_a", null));
      yield* onFile(insertRun("run_b", null));
      yield* onFile(makeEditorialMigrations(editorialMigrationEntries).run());
      const index = yield* onFile(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly sql: string }>`
            SELECT sql FROM sqlite_schema WHERE name = 'editorial_runs_content_key'
          `;
        }),
      );
      assert.include(index[0]?.sql ?? "", "WHERE profile_hash IS NOT NULL");
      // The two old rows stay; a copy of one with a profile hash cannot join.
      yield* onFile(insertRun("run_c", PROFILE_HASH));
      const rejected = yield* onFile(insertRun("run_d", PROFILE_HASH)).pipe(Effect.flip);
      assert.strictEqual(rejected.reason._tag, "UniqueViolation");
    }).pipe(Effect.provide(NodeServices.layer), Effect.ensuring(removeDir(root)));
  });
});
