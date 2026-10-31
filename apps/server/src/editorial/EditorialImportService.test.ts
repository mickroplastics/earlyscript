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
import { FIXTURE_RUN_ID, withEditorial } from "./editorialLayer.testkit.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { EditorialEventLog } from "./persistence/EditorialEventLog.ts";
import { trendKeyOf } from "./trendKey.ts";

const SESSION = { sessionId: "session-operator" };
const QUANTUM_FILE = "13-dos_bbb80d57481e.json";
const QUANTUM_DOSSIER = EditorialDossierId.make("dos_bbb80d57481e");
const QUANTUM = EditorialTrendKey.make("sig_69a4b83dd577");
const CHINA = EditorialTrendKey.make("sig_833479e1f4de");
const { IMPORT_POLL_INTERVAL } = EditorialImportService;
const RUN_2 = "run_20261020_20261028T003754_aaaaaa";

/** A fixed mtime in seconds, after the copy's, so each rewrite looks changed. */
const mtimeAt = (seconds: number) => Date.UTC(2030, 0, 1) / 1000 + seconds;

const events = Effect.gen(function* () {
  const log = yield* EditorialEventLog;
  return yield* log.readSince(0);
});

const countRows = (table: "editorial_runs" | "editorial_dossiers") =>
  Effect.gen(function* () {
    const sql = yield* EditorialSql;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM ${sql(table)}
    `;
    return rows[0]?.count ?? 0;
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
        corpus: { corpus_used_hash: "sha256:used-next", corpus_manifest_hash: "sha256:manifest" },
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

  it.effect("reimports changed content once and never announces the same content twice", () =>
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
        const imported = (yield* events).filter((event) => event.type === "run.imported");
        assert.strictEqual(imported.length, 2);
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

        const [latest] = yield* sql<{ readonly corpus_used_hash: string | null }>`
          SELECT corpus_used_hash FROM editorial_runs WHERE run_id = ${RUN_2}
        `;
        assert.strictEqual(latest?.corpus_used_hash, "sha256:used-next");
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
