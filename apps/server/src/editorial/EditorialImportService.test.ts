import { assert, describe, it } from "@effect/vitest";
import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  type EditorialTrendKey as TrendKeyType,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as TestClock from "effect/testing/TestClock";

import { EditorialCommandService } from "./EditorialCommandService.ts";
import * as EditorialImportService from "./EditorialImportService.ts";
import { EditorialInboxCommands, defaultGrowthTarget } from "./EditorialInboxCommands.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import {
  addNativeFixtureRun,
  FIXTURE_RUN_ID,
  NATIVE_FIXTURE_RUN_ID,
  withEditorial,
} from "./editorialLayer.testkit.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { trendKeyOf } from "./trendKey.ts";

const SESSION = { sessionId: "session-operator" };
const QUANTUM_FILE = "13-dos_bbb80d57481e.json";
const QUANTUM_DOSSIER = EditorialDossierId.make("dos_bbb80d57481e");
const QUANTUM = EditorialTrendKey.make("sig_69a4b83dd577");
const CHINA = EditorialTrendKey.make("sig_833479e1f4de");
const CHINA_DOSSIER = EditorialDossierId.make("dos_ead8cfa066df");
const JUDGE = EditorialTrendKey.make("sig_7c382e796d60");
const JUDGE_DOSSIER = EditorialDossierId.make("dos_82c53bb05e52");
const RUN_ID = EditorialRunId.make(FIXTURE_RUN_ID);
const { IMPORT_POLL_INTERVAL } = EditorialImportService;
const RUN_2 = "run_20261020_20261028T003754_aaaaaa";

/** A fixed mtime in seconds, after the copy's, so each rewrite looks changed. */
const mtimeAt = (seconds: number) => Date.UTC(2030, 0, 1) / 1000 + seconds;

const events = Effect.gen(function* () {
  const log = yield* EditorialEventLog;
  return yield* log.readSince(0);
});

/** Every column of the operator's inbox state, by trend key. */
const inboxRows = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  return yield* sql`SELECT * FROM editorial_trend_inbox ORDER BY trend_key`;
});

const countRows = (table: "editorial_runs" | "editorial_dossiers") =>
  Effect.gen(function* () {
    const sql = yield* EditorialSql;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM ${sql(table)}
    `;
    return rows[0]?.count ?? 0;
  });

const runRow = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* EditorialSql;
    const rows = yield* sql<{
      readonly import_state: string;
      readonly skipped_files_json: string;
      readonly cutoff_at: string | null;
      readonly content_hash: string | null;
      readonly artifact_path: string;
    }>`
      SELECT import_state, skipped_files_json, cutoff_at, content_hash, artifact_path
      FROM editorial_runs WHERE run_id = ${runId}
    `;
    return rows[0];
  });

/**
 * A second run one day later: the fixture run copied with a new id and cutoff, and one more
 * curve day (18 to 19 October) for the quantum trend with `quantumItems` items.
 */
const addNextRun = (runsDir: string, quantumItems: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const from = path.join(runsDir, FIXTURE_RUN_ID);
    const to = path.join(runsDir, RUN_2);
    yield* fs.copy(from, to);
    const runJson = path.join(to, "run.json");
    const run = JSON.parse(yield* fs.readFileString(runJson));
    yield* fs.writeFileString(
      runJson,
      JSON.stringify({
        ...run,
        run_id: RUN_2,
        cutoff_at: "2026-10-20T00:00:00.000Z",
        finished_at: "2026-10-28T00:43:13.414Z",
        logical_hash: "sha256:next",
      }),
    );
    for (const file of yield* fs.readDirectory(path.join(to, "dossiers"))) {
      const filePath = path.join(to, "dossiers", file);
      const dossier = JSON.parse(yield* fs.readFileString(filePath));
      dossier.cutoff_at = "2026-10-20T00:00:00.000Z";
      if (file === QUANTUM_FILE && quantumItems > 0) {
        dossier.curve.push({
          day: "2026-10-19",
          items: quantumItems,
          sources: 1,
          authors: quantumItems,
          known: true,
        });
      }
      yield* fs.writeFileString(filePath, JSON.stringify(dossier));
    }
  });

describe("EditorialImportService", () => {
  it.effect("imports a run once: a repeated import adds no rows and no events", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        const importer = yield* EditorialImportService.EditorialImportService;
        const first = yield* importer.sync;
        assert.deepStrictEqual(first.runs, [{ runId: FIXTURE_RUN_ID, outcome: "imported" }]);
        assert.strictEqual(yield* countRows("editorial_runs"), 1);
        assert.strictEqual(yield* countRows("editorial_dossiers"), 3);
        const imported = (yield* events).filter((event) => event.type === "run.imported");
        assert.strictEqual(imported.length, 1);
        assert.strictEqual(imported[0]?.aggregateKind, "run");
        assert.strictEqual(imported[0]?.aggregateId, FIXTURE_RUN_ID);
        assert.strictEqual(imported[0]?.actor, "system");

        const second = yield* importer.sync;
        assert.deepStrictEqual(second.runs, []);
        assert.strictEqual(yield* countRows("editorial_dossiers"), 3);
        assert.strictEqual((yield* events).length, 1);

        const sql = yield* EditorialSql;
        const [row] = yield* sql<{
          readonly cutoff_at: string;
          readonly logical_hash: string | null;
          readonly corpus_hash: string | null;
          readonly config_hash: string | null;
          readonly import_state: string;
          readonly coverage_json: string;
        }>`
          SELECT cutoff_at, logical_hash, corpus_hash, config_hash, import_state, coverage_json
          FROM editorial_runs
        `;
        assert.strictEqual(row?.cutoff_at, "2026-10-19T00:00:00.000Z");
        assert.strictEqual(
          row?.logical_hash,
          "sha256:d1f2291005e9f4310396a7f53d0f5b752174daa3ec401e7ab65073b7e9fadfc6",
        );
        assert.strictEqual(
          row?.corpus_hash,
          "sha256:5bf2d88a265b587390f4798612a1b4dfd96a14e88a5becde9b0df6ad81e1177b",
        );
        assert.ok(row?.config_hash?.startsWith("sha256:bbd96934"));
        assert.strictEqual(row?.import_state, "imported");
        // No run-level coverage in Earlywindow's run.json: the first dossier's is kept.
        assert.strictEqual(JSON.parse(row?.coverage_json ?? "null").window_days, 28);
      }),
    ),
  );

  it.effect("announces every change of the content in force, a revert included", () =>
    withEditorial(({ runDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const importer = yield* EditorialImportService.EditorialImportService;
        yield* importer.sync;
        const file = path.join(runDir, "dossiers", QUANTUM_FILE);
        const original = yield* fs.readFileString(file);

        // Same bytes under a new mtime: indexed again, announced never.
        yield* fs.writeFileString(file, original);
        yield* fs.utimes(file, mtimeAt(5), mtimeAt(5));
        const touched = yield* importer.sync;
        assert.deepStrictEqual(touched.runs, [{ runId: FIXTURE_RUN_ID, outcome: "unchanged" }]);
        assert.strictEqual((yield* events).length, 1);

        const edited = JSON.parse(original);
        edited.signal.label = "quantum computing ibm open edited";
        yield* fs.writeFileString(file, JSON.stringify(edited));
        yield* fs.utimes(file, mtimeAt(10), mtimeAt(10));
        const changed = yield* importer.sync;
        assert.deepStrictEqual(changed.runs, [{ runId: FIXTURE_RUN_ID, outcome: "updated" }]);
        assert.strictEqual(yield* countRows("editorial_dossiers"), 3);

        yield* fs.writeFileString(file, original);
        yield* fs.utimes(file, mtimeAt(15), mtimeAt(15));
        const reverted = yield* importer.sync;
        assert.deepStrictEqual(reverted.runs, [{ runId: FIXTURE_RUN_ID, outcome: "updated" }]);

        const runEvents = (yield* events).filter((event) => event.aggregateKind === "run");
        assert.deepStrictEqual(
          runEvents.map((event) => [event.type, event.seq]),
          [
            ["run.imported", 1],
            ["run.updated", 2],
            ["run.updated", 3],
          ],
        );
        const hashes = runEvents.map(
          (event) => (event.payload as { readonly contentHash: string }).contentHash,
        );
        // A -> B -> A: the last event carries the first hash again, and B as the previous one.
        assert.strictEqual(hashes[2], hashes[0]);
        assert.notStrictEqual(hashes[1], hashes[0]);
        const revert = runEvents[2]?.payload as { readonly previousContentHash: string };
        assert.strictEqual(revert.previousContentHash, hashes[1]);
        // Only the first announcement of new content carries an operation id.
        assert.deepStrictEqual(
          runEvents.map((event) => event.operationId !== null),
          [true, false, false],
        );
      }),
    ),
  );

  it.effect("lists a dossier that does not decode and clears it once the file is fixed", () =>
    withEditorial(({ runDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const importer = yield* EditorialImportService.EditorialImportService;
        yield* importer.sync;
        const runState = runRow(FIXTURE_RUN_ID);

        // Only a corrupt file is added; the three dossiers do not change.
        const bad = path.join(runDir, "dossiers", "99-bad.json");
        yield* fs.writeFileString(bad, "{");
        const added = yield* importer.sync;
        assert.deepStrictEqual(added.runs, [{ runId: FIXTURE_RUN_ID, outcome: "updated" }]);
        const partial = yield* runState;
        assert.strictEqual(partial?.import_state, "partial");
        assert.deepStrictEqual(JSON.parse(partial?.skipped_files_json ?? "[]"), [
          { file: "dossiers/99-bad.json", reason: "Expected a valid JSON string" },
        ]);
        assert.strictEqual(yield* countRows("editorial_dossiers"), 3);

        const quantum = yield* fs.readFileString(path.join(runDir, "dossiers", QUANTUM_FILE));
        yield* fs.writeFileString(
          bad,
          JSON.stringify({ ...JSON.parse(quantum), dossier_id: "dos_fixed" }),
        );
        yield* fs.utimes(bad, mtimeAt(5), mtimeAt(5));
        const fixed = yield* importer.sync;
        assert.deepStrictEqual(fixed.runs, [{ runId: FIXTURE_RUN_ID, outcome: "updated" }]);
        const repaired = yield* runState;
        assert.strictEqual(repaired?.import_state, "imported");
        assert.strictEqual(repaired?.skipped_files_json, "[]");
        assert.strictEqual(yield* countRows("editorial_dossiers"), 4);
        assert.deepStrictEqual(
          (yield* events).map((event) => [
            event.type,
            (event.payload as { readonly importState: string }).importState,
          ]),
          [
            ["run.imported", "imported"],
            ["run.updated", "partial"],
            ["run.updated", "imported"],
          ],
        );
      }),
    ),
  );

  it.effect("records a new directory whose run.json does not decode as an invalid run", () =>
    withEditorial(({ dir, runDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const importer = yield* EditorialImportService.EditorialImportService;
        const read = yield* EditorialReadService;
        yield* importer.sync;

        const corrupt = path.join(dir, "corrupt");
        yield* fs.copy(runDir, corrupt);
        yield* fs.writeFileString(path.join(corrupt, "run.json"), "{");
        const report = yield* importer.sync;
        assert.deepStrictEqual(report.runs, [{ runId: "corrupt", outcome: "invalid" }]);

        const row = yield* runRow("corrupt");
        assert.strictEqual(row?.import_state, "invalid");
        assert.strictEqual(row?.cutoff_at, null);
        assert.strictEqual(row?.content_hash, null);
        assert.strictEqual(row?.artifact_path, corrupt);
        assert.deepStrictEqual(JSON.parse(row?.skipped_files_json ?? "[]"), [
          { file: "run.json", reason: "Expected a valid JSON string" },
        ]);

        const runs = yield* read.listRuns;
        assert.deepStrictEqual(
          runs.map((run) => [run.runId, run.importState, run.cutoffAt]),
          [
            [FIXTURE_RUN_ID, "imported", "2026-10-19T00:00:00.000Z"],
            ["corrupt", "invalid", null],
          ],
        );
        assert.strictEqual((yield* read.getInbox({})).run?.runId, FIXTURE_RUN_ID);
        const error = yield* read
          .getInbox({ runId: EditorialRunId.make("corrupt") })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "unreadable");

        // Nothing changed: no new event on the next pass.
        const seq = (yield* events).length;
        assert.deepStrictEqual((yield* importer.sync).runs, []);
        assert.strictEqual((yield* events).length, seq);
        assert.deepStrictEqual(
          (yield* events).map((event) => [event.type, event.aggregateId]),
          [
            ["run.imported", FIXTURE_RUN_ID],
            ["run.invalidated", "corrupt"],
          ],
        );
      }),
    ),
  );

  it.effect(
    "marks an indexed run invalid when its run.json breaks and restores it when fixed",
    () =>
      withEditorial(({ runDir }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const importer = yield* EditorialImportService.EditorialImportService;
          const read = yield* EditorialReadService;
          yield* importer.sync;
          const before = yield* runRow(FIXTURE_RUN_ID);
          const runJson = path.join(runDir, "run.json");
          const original = yield* fs.readFileString(runJson);

          yield* fs.writeFileString(runJson, "{");
          yield* fs.utimes(runJson, mtimeAt(5), mtimeAt(5));
          const broken = yield* importer.sync;
          assert.deepStrictEqual(broken.runs, [{ runId: FIXTURE_RUN_ID, outcome: "invalid" }]);
          const invalid = yield* runRow(FIXTURE_RUN_ID);
          // Its metadata stays; only the state, the inventory and the version change.
          assert.strictEqual(invalid?.import_state, "invalid");
          assert.strictEqual(invalid?.cutoff_at, before?.cutoff_at);
          assert.strictEqual(invalid?.content_hash, before?.content_hash);
          assert.deepStrictEqual(JSON.parse(invalid?.skipped_files_json ?? "[]"), [
            { file: "run.json", reason: "Expected a valid JSON string" },
          ]);
          assert.strictEqual(yield* countRows("editorial_runs"), 1);
          assert.deepStrictEqual(
            (yield* read.listRuns).map((run) => [run.runId, run.importState] as const),
            [[EditorialRunId.make(FIXTURE_RUN_ID), "invalid"]],
          );
          const inbox = yield* read.getInbox({});
          assert.strictEqual(inbox.run, null);
          assert.strictEqual(inbox.total, 0);

          yield* fs.writeFileString(runJson, original);
          yield* fs.utimes(runJson, mtimeAt(10), mtimeAt(10));
          const fixed = yield* importer.sync;
          assert.deepStrictEqual(fixed.runs, [{ runId: FIXTURE_RUN_ID, outcome: "updated" }]);
          const restored = yield* runRow(FIXTURE_RUN_ID);
          assert.strictEqual(restored?.import_state, "imported");
          assert.strictEqual(restored?.skipped_files_json, "[]");
          assert.strictEqual(restored?.content_hash, before?.content_hash);
          assert.strictEqual((yield* read.getInbox({})).total, 3);
          assert.deepStrictEqual(
            (yield* events).map((event) => event.type),
            ["run.imported", "run.invalidated", "run.updated"],
          );
        }),
      ),
  );

  it.effect("replaces the placeholder of an invalid directory once its run.json decodes", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const importer = yield* EditorialImportService.EditorialImportService;
        yield* importer.sync;
        yield* addNextRun(dir, 1);
        const runJson = path.join(dir, RUN_2, "run.json");
        const original = yield* fs.readFileString(runJson);
        // The engine is still writing: run.json is cut short before the first import.
        yield* fs.writeFileString(runJson, original.slice(0, 20));
        yield* fs.rename(path.join(dir, RUN_2), path.join(dir, "pending-run"));
        assert.deepStrictEqual((yield* importer.sync).runs, [
          { runId: "pending-run", outcome: "invalid" },
        ]);

        const fixedJson = path.join(dir, "pending-run", "run.json");
        yield* fs.writeFileString(fixedJson, original);
        yield* fs.utimes(fixedJson, mtimeAt(5), mtimeAt(5));
        assert.deepStrictEqual((yield* importer.sync).runs, [
          { runId: RUN_2, outcome: "imported" },
        ]);
        assert.strictEqual(yield* runRow("pending-run"), undefined);
        assert.strictEqual((yield* runRow(RUN_2))?.import_state, "imported");
      }),
    ),
  );

  it.effect("keeps the trend key of a signal across two runs", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        const importer = yield* EditorialImportService.EditorialImportService;
        yield* importer.sync;
        yield* addNextRun(dir, 1);
        const report = yield* importer.sync;
        assert.deepStrictEqual(report.runs, [{ runId: RUN_2, outcome: "imported" }]);

        const sql = yield* EditorialSql;
        const rows = yield* sql<{
          readonly run_id: string;
          readonly dossier_id: string;
          readonly trend_key: string;
          readonly trend_key_rule: string;
        }>`
          SELECT run_id, dossier_id, trend_key, trend_key_rule
          FROM editorial_dossiers ORDER BY trend_key, run_id
        `;
        const keysByRun = (runId: string) =>
          rows
            .filter((row) => row.run_id === runId)
            .map((row) => row.trend_key)
            .toSorted();
        assert.deepStrictEqual(keysByRun(FIXTURE_RUN_ID), keysByRun(RUN_2));
        assert.ok(rows.every((row) => row.trend_key_rule === "signal-id"));
        assert.deepStrictEqual(
          rows.filter((row) => row.trend_key === QUANTUM).map((row) => row.dossier_id),
          ["dos_bbb80d57481e", "dos_bbb80d57481e"],
        );
      }),
    ),
  );

  it.effect("reindexes runs an earlier interpretation indexed and keeps the operator's state", () =>
    withEditorial(({ dir, runDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sql = yield* EditorialSql;
        const importer = yield* EditorialImportService.EditorialImportService;
        const inbox = yield* EditorialInboxCommands;
        yield* addNativeFixtureRun(dir);
        yield* importer.sync;

        // The operator's state, which lives under the trend key.
        yield* inbox.markRead(SESSION, {
          trendKey: CHINA,
          runId: RUN_ID,
          dossierId: CHINA_DOSSIER,
        });
        yield* inbox.snooze(SESSION, { trendKey: JUDGE });
        yield* inbox.dismiss(SESSION, { trendKey: QUANTUM, reason: "Already covered" });
        yield* sql`
          UPDATE editorial_trend_inbox
          SET production_thread_id = 'thread-1', production_linked_at = '2026-10-30T10:00:00.000Z'
          WHERE trend_key = ${CHINA}
        `;
        const stateBefore = yield* inboxRows;

        // What version 1 left, with the same files and content hashes: the native run as a
        // partial run without dossiers, and competition ranks (quantum and judge share #2).
        yield* sql`UPDATE editorial_runs SET interpretation_version = 1`;
        yield* sql`
          UPDATE editorial_runs
          SET dossier_count = 0, config_version = NULL, sources_json = '[]',
            import_state = 'partial'
          WHERE run_id = ${NATIVE_FIXTURE_RUN_ID}
        `;
        yield* sql`DELETE FROM editorial_dossiers WHERE run_id = ${NATIVE_FIXTURE_RUN_ID}`;
        yield* sql`
          UPDATE editorial_dossiers SET volume_rank = 2 WHERE dossier_id = ${JUDGE_DOSSIER}
        `;
        // The native run keeps its inventory: only the version tells it apart. Earlywindow's
        // run.json is touched: its inventory changes and only its content hash is equal.
        const runJson = path.join(runDir, "run.json");
        yield* fs.utimes(runJson, mtimeAt(5), mtimeAt(5));
        const eventsBefore = (yield* events).length;

        const report = yield* importer.sync;
        assert.deepStrictEqual(report.runs, [
          { runId: FIXTURE_RUN_ID, outcome: "updated" },
          { runId: NATIVE_FIXTURE_RUN_ID, outcome: "updated" },
        ]);
        const updated = (yield* events).slice(eventsBefore);
        assert.deepStrictEqual(
          updated.map((event) => [
            event.type,
            event.aggregateId,
            (event.payload as { readonly previousInterpretationVersion: number })
              .previousInterpretationVersion,
          ]),
          [
            ["run.updated", FIXTURE_RUN_ID, 1],
            ["run.updated", NATIVE_FIXTURE_RUN_ID, 1],
          ],
        );

        assert.strictEqual(yield* countRows("editorial_dossiers"), 5);
        const runs = yield* sql<{
          readonly run_id: string;
          readonly dossier_count: number;
          readonly config_version: string | null;
          readonly sources_json: string;
          readonly import_state: string;
          readonly interpretation_version: number;
        }>`
          SELECT run_id, dossier_count, config_version, sources_json, import_state,
            interpretation_version
          FROM editorial_runs ORDER BY run_id
        `;
        assert.deepStrictEqual(
          runs.map((row) => [
            row.run_id,
            row.dossier_count,
            row.config_version,
            JSON.parse(row.sources_json),
            row.import_state,
            row.interpretation_version,
          ]),
          [
            [FIXTURE_RUN_ID, 3, "engine.v0.02", ["hn", "github"], "imported", 2],
            [NATIVE_FIXTURE_RUN_ID, 2, "earlyscript.engine.v1", ["hn", "github"], "imported", 2],
          ],
        );
        const ranks = yield* sql<{ readonly dossier_id: string; readonly volume_rank: number }>`
          SELECT dossier_id, volume_rank FROM editorial_dossiers ORDER BY dossier_id
        `;
        assert.deepStrictEqual(
          ranks.map((row) => [row.dossier_id, row.volume_rank]),
          [
            ["dos_38ceab3f670f", 3],
            ["dos_47ea4d4f2ccc", 1],
            ["dos_82c53bb05e52", 3],
            ["dos_bbb80d57481e", 2],
            ["dos_ead8cfa066df", 1],
          ],
        );

        // Read, snooze, dismissal and production link are the same rows as before.
        assert.deepStrictEqual(yield* inboxRows, stateBefore);
        const trends = new Map(
          (yield* (yield* EditorialReadService).getInbox({
            runId: EditorialRunId.make(RUN_ID),
          })).trends.map((trend) => [trend.trendKey, trend]),
        );
        assert.strictEqual(trends.get(CHINA)?.inbox?.seenRunId, RUN_ID);
        assert.strictEqual(trends.get(CHINA)?.inbox?.production?.threadId, "thread-1");
        assert.ok(trends.get(JUDGE)?.inbox?.snoozed);
        assert.strictEqual(trends.get(QUANTUM)?.inbox?.dismissed?.reason, "Already covered");
        assert.strictEqual(trends.get(JUDGE)?.volumeRank, 3);

        assert.deepStrictEqual((yield* importer.sync).runs, []);
      }),
    ),
  );

  it.effect("indexes a native run with its provenance, config and engine positions", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        yield* addNativeFixtureRun(dir);
        const report = yield* (yield* EditorialImportService.EditorialImportService).sync;
        assert.deepStrictEqual(report.runs, [
          { runId: FIXTURE_RUN_ID, outcome: "imported" },
          { runId: NATIVE_FIXTURE_RUN_ID, outcome: "imported" },
        ]);

        const sql = yield* EditorialSql;
        const [run] = yield* sql<{
          readonly run_schema_version: string | null;
          readonly engine_version: string | null;
          readonly config_version: string | null;
          readonly corpus_hash: string | null;
          readonly corpus_used_hash: string | null;
          readonly sources_json: string;
          readonly coverage_json: string;
          readonly import_state: string;
        }>`
          SELECT run_schema_version, engine_version, config_version, corpus_hash,
            corpus_used_hash, sources_json, coverage_json, import_state
          FROM editorial_runs WHERE run_id = ${NATIVE_FIXTURE_RUN_ID}
        `;
        assert.strictEqual(run?.run_schema_version, "earlyscript.run/1");
        assert.strictEqual(run?.engine_version, "0.1.0");
        assert.strictEqual(run?.config_version, "earlyscript.engine.v1");
        assert.ok(run?.corpus_hash?.startsWith("sha256:"));
        assert.ok(run?.corpus_used_hash?.startsWith("sha256:"));
        assert.notStrictEqual(run?.corpus_hash, run?.corpus_used_hash);
        assert.deepStrictEqual(JSON.parse(run?.sources_json ?? "[]"), ["hn", "github"]);
        assert.strictEqual(JSON.parse(run?.coverage_json ?? "null").window_days, 28);
        assert.strictEqual(run?.import_state, "imported");

        const dossiers = yield* sql<{
          readonly dossier_id: string;
          readonly trend_key: string;
          readonly file_path: string;
          readonly volume_rank: number;
          readonly score_rank: number;
        }>`
          SELECT dossier_id, trend_key, file_path, volume_rank, score_rank
          FROM editorial_dossiers WHERE run_id = ${NATIVE_FIXTURE_RUN_ID} ORDER BY dossier_id
        `;
        // Positions among the run's 15 eligible trends, each row with its own file.
        assert.deepStrictEqual(
          dossiers.map((row) => [
            row.dossier_id,
            row.trend_key,
            row.file_path,
            row.volume_rank,
            row.score_rank,
          ]),
          [
            ["dos_38ceab3f670f", "sig_2da277446bf4", "dossiers/03-dos_38ceab3f670f.json", 3, 1],
            ["dos_47ea4d4f2ccc", "sig_67f2a4ea9b88", "dossiers/01-dos_47ea4d4f2ccc.json", 1, 4],
          ],
        );
      }),
    ),
  );

  it("derives a fallback key from the sorted terms when the dossier has no signal id", () => {
    const a = trendKeyOf({
      dossier_id: "dos_a",
      signal: { top_terms: ["Quantum", "ibm", "circuits"] },
    });
    const b = trendKeyOf({
      dossier_id: "dos_b",
      signal: { top_terms: ["circuits", "quantum", "IBM"] },
    });
    assert.strictEqual(a.rule, "top-terms");
    assert.strictEqual(a.key, b.key);
    assert.match(a.key, /^terms_[0-9a-f]{12}$/);
    assert.notStrictEqual(
      trendKeyOf({ dossier_id: "dos_c", signal: {} }).key,
      trendKeyOf({ dossier_id: "dos_d", signal: {} }).key,
    );
    assert.deepStrictEqual(trendKeyOf({ dossier_id: "dos_e", signal: { id: "sig_x" } }), {
      key: EditorialTrendKey.make("sig_x"),
      rule: "signal-id",
    });
  });

  it.effect("returns a snoozed trend when the next run meets its growth target", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        const importer = yield* EditorialImportService.EditorialImportService;
        const inbox = yield* EditorialInboxCommands;
        const commands = yield* EditorialCommandService;
        yield* importer.sync;

        // Baseline 11 items in 7 days: the default target is max(11 + 3, ceil(16.5)) = 17.
        const snoozed = yield* inbox.snooze(SESSION, { trendKey: QUANTUM });
        assert.deepStrictEqual(snoozed.state.snoozed?.returnWhen, {
          metric: "items7d",
          baseline: 11,
          atLeast: defaultGrowthTarget(11),
        });
        assert.strictEqual(defaultGrowthTarget(11), 17);
        yield* inbox.snooze(SESSION, {
          trendKey: CHINA,
          returnWhen: { metric: "items7d", atLeast: 40 },
        });

        // 18 October drops out of nothing; 19 October adds 12: 0+1+5+2+0+1+12 = 21 >= 17.
        yield* addNextRun(dir, 12);
        const report = yield* importer.sync;
        assert.deepStrictEqual(report.returned, [{ trendKey: QUANTUM, cause: "growth" }]);
        const [quantum, china] = yield* commands.getInboxState([QUANTUM, CHINA]);
        assert.strictEqual(quantum?.snoozedAt, null);
        assert.notStrictEqual(china?.snoozedAt, null);

        const unsnoozed = (yield* events).filter((event) => event.type === "trend.unsnoozed");
        assert.strictEqual(unsnoozed.length, 1);
        assert.strictEqual(unsnoozed[0]?.actor, "system");
        assert.strictEqual(unsnoozed[0]?.actorSessionId, null);
        assert.deepStrictEqual(unsnoozed[0]?.payload, {
          cause: "growth",
          observed: { runId: RUN_2, metric: "items7d", value: 21 },
        });

        // A later pass over the same run returns nothing more.
        assert.deepStrictEqual((yield* importer.sync).returned, []);
      }),
    ),
  );

  it.effect(
    "keeps a snoozed trend away while it does not grow and returns it when it expires",
    () =>
      withEditorial(({ dir }) =>
        Effect.gen(function* () {
          const importer = yield* EditorialImportService.EditorialImportService;
          const inbox = yield* EditorialInboxCommands;
          yield* importer.sync;
          yield* inbox.snooze(SESSION, { trendKey: QUANTUM });
          yield* inbox.snooze(SESSION, { trendKey: CHINA, until: "1970-01-01T00:10:00.000Z" });

          yield* addNextRun(dir, 1);
          assert.deepStrictEqual((yield* importer.sync).returned, []);

          yield* TestClock.adjust(Duration.minutes(11));
          assert.deepStrictEqual((yield* importer.sync).returned, [
            { trendKey: CHINA, cause: "expired" },
          ]);
        }),
      ),
  );

  it.effect("marks a read trend new again only when the next run shows activity after it", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        const importer = yield* EditorialImportService.EditorialImportService;
        const inbox = yield* EditorialInboxCommands;
        const read = yield* EditorialReadService;
        yield* importer.sync;
        const before = yield* read.getInbox({});
        assert.strictEqual(before.newCount, 3);
        for (const trend of before.trends) {
          yield* inbox.markRead(SESSION, {
            trendKey: trend.trendKey as TrendKeyType,
            runId: trend.runId,
            dossierId: trend.dossierId,
          });
        }
        assert.strictEqual((yield* read.getInbox({})).newCount, 0);

        yield* addNextRun(dir, 3);
        yield* importer.sync;
        const after = yield* read.getInbox({});
        assert.strictEqual(after.run?.runId, EditorialRunId.make(RUN_2));
        // Only quantum has items on 19 October, after the cutoff of the run read.
        assert.deepStrictEqual(
          after.trends.filter((trend) => trend.isNew).map((trend) => trend.trendKey),
          [QUANTUM],
        );
        assert.strictEqual(after.newCount, 1);
        assert.strictEqual(after.trends[0]?.dossierId, QUANTUM_DOSSIER);
      }),
    ),
  );

  it.effect("imports at startup and again on each poll", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        const log = yield* EditorialEventLog;
        const subscription = yield* log.subscribe;
        yield* Layer.build(EditorialImportService.layerWatch);
        const first = yield* PubSub.take(subscription);
        assert.deepStrictEqual([first.type, first.aggregateId], ["run.imported", FIXTURE_RUN_ID]);

        yield* addNextRun(dir, 1);
        yield* TestClock.adjust(IMPORT_POLL_INTERVAL);
        const second = yield* PubSub.take(subscription);
        assert.deepStrictEqual([second.type, second.aggregateId], ["run.imported", RUN_2]);
      }),
    ),
  );
});
