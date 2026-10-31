import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EditorialDossierId, EditorialRunId, EditorialTrendKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialInboxCommands } from "./EditorialInboxCommands.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { withEditorial } from "./editorialLayer.testkit.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";

// Three dossiers of the run Earlywindow made on 27 October 2026 (cutoff 19 October), as the
// engine wrote them minus retrieval stamps.
const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");
const QUANTUM = EditorialDossierId.make("dos_bbb80d57481e");
const CHINA = EditorialDossierId.make("dos_ead8cfa066df");
const JUDGE = EditorialDossierId.make("dos_82c53bb05e52");
const QUANTUM_KEY = EditorialTrendKey.make("sig_69a4b83dd577");
const CHINA_KEY = EditorialTrendKey.make("sig_833479e1f4de");
const JUDGE_KEY = EditorialTrendKey.make("sig_7c382e796d60");
const SESSION = { sessionId: "session-operator" };

const imported = Effect.gen(function* () {
  yield* (yield* EditorialImportService).sync;
  return yield* EditorialReadService;
});

describe("EditorialReadService", () => {
  it.effect("reads nothing before any run is imported", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* withEditorial(({ dir }) =>
        Effect.gen(function* () {
          yield* fs.remove(path.join(dir, RUN_ID), { recursive: true });
          const service = yield* imported;
          assert.deepStrictEqual(yield* service.listRuns, []);
          const inbox = yield* service.getInbox({});
          assert.strictEqual(inbox.run, null);
          assert.deepStrictEqual(inbox.trends, []);
          assert.strictEqual(inbox.newCount, 0);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("derives both ranks, weekly counts and the 14-day sparkline from the dossiers", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        const service = yield* imported;
        const runs = yield* service.listRuns;
        assert.deepStrictEqual(
          runs.map((run) => [run.runId, run.cutoffAt, run.dossierCount]),
          [[RUN_ID, "2026-10-19T00:00:00.000Z", 3]],
        );

        const inbox = yield* service.getInbox({});
        assert.strictEqual(inbox.sort, "new-first-growth");
        assert.strictEqual(inbox.newCount, 3);
        // Growth: China 1.45, LLM judge 0.88, quantum 0.69.
        assert.deepStrictEqual(
          inbox.trends.map((trend) => trend.dossierId),
          [CHINA, JUDGE, QUANTUM],
        );
        assert.deepStrictEqual(
          inbox.trends.map((trend) => trend.trendKey),
          [CHINA_KEY, JUDGE_KEY, QUANTUM_KEY],
        );
        const quantum = inbox.trends.find((trend) => trend.dossierId === QUANTUM);
        assert.ok(quantum);
        assert.strictEqual(quantum.label, "quantum computing ibm open");
        assert.strictEqual(
          quantum.subtitle,
          "Designing more efficient quantum circuits with Claude",
        );
        assert.strictEqual(quantum.items7d, 11);
        assert.strictEqual(quantum.items28d, 38);
        assert.strictEqual(quantum.authors7d, 11);
        // 16 for China, 11 for both quantum and LLM judge: they share #2.
        assert.strictEqual(quantum.volumeRank, 2);
        assert.strictEqual(quantum.scoreRank, 3);
        assert.strictEqual(quantum.affinity, 0.608747);
        // ln 2: the engine's log growth for a week that doubled.
        assert.closeTo(quantum.growth ?? 0, Math.LN2, 1e-6);
        assert.strictEqual(quantum.sourceCount, 1);
        assert.deepStrictEqual(quantum.sources, ["hn"]);
        assert.deepStrictEqual(quantum.sparkline, [2, 2, 1, 0, 0, 0, 0, 2, 0, 1, 5, 2, 0, 1]);
        assert.deepStrictEqual(quantum.inbox, {
          isNew: true,
          seenRunId: null,
          seenAt: null,
          snoozed: null,
          dismissed: null,
          production: null,
        });

        assert.deepStrictEqual(
          (yield* service.getInbox({ sort: "volume" })).trends.map((trend) => trend.dossierId),
          [CHINA, JUDGE, QUANTUM],
        );
        assert.deepStrictEqual(
          (yield* service.getInbox({ sort: "affinity", limit: 2 })).trends.map(
            (trend) => trend.dossierId,
          ),
          [JUDGE, CHINA],
        );
      }),
    ),
  );

  it.effect("combines each trend with its inbox state: read, snoozed, dismissed, production", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        const service = yield* imported;
        const inbox = yield* EditorialInboxCommands;
        const sql = yield* EditorialSql;

        yield* inbox.markRead(SESSION, { trendKey: CHINA_KEY, runId: RUN_ID, dossierId: CHINA });
        yield* inbox.snooze(SESSION, { trendKey: JUDGE_KEY });
        yield* inbox.dismiss(SESSION, { trendKey: QUANTUM_KEY, reason: "Already covered" });
        // Production links come from the video thread unit; the row is what the read side sees.
        yield* sql`
          UPDATE editorial_trend_inbox
          SET production_thread_id = 'thread-1', production_linked_at = '2026-10-30T10:00:00.000Z'
          WHERE trend_key = ${CHINA_KEY}
        `;

        const result = yield* service.getInbox({});
        assert.strictEqual(result.newCount, 0);
        assert.strictEqual(result.snoozedCount, 1);
        assert.strictEqual(result.dismissedCount, 1);
        const byKey = new Map(result.trends.map((trend) => [trend.trendKey, trend]));
        assert.strictEqual(byKey.get(CHINA_KEY)?.inbox?.seenRunId, RUN_ID);
        assert.deepStrictEqual(byKey.get(CHINA_KEY)?.inbox?.production, {
          threadId: "thread-1",
          linkedAt: "2026-10-30T10:00:00.000Z",
        });
        assert.strictEqual(byKey.get(JUDGE_KEY)?.inbox?.snoozed?.returnWhen?.metric, "items7d");
        assert.strictEqual(byKey.get(JUDGE_KEY)?.isNew, false);
        assert.deepStrictEqual(byKey.get(QUANTUM_KEY)?.inbox?.dismissed?.reason, "Already covered");

        yield* inbox.reopen(SESSION, { trendKey: QUANTUM_KEY });
        yield* inbox.unsnooze(SESSION, { trendKey: JUDGE_KEY });
        const reopened = yield* service.getInbox({});
        assert.strictEqual(reopened.newCount, 2);
        assert.deepStrictEqual(
          reopened.trends.map((trend) => [trend.dossierId, trend.isNew]),
          // New first, then growth.
          [
            [JUDGE, true],
            [QUANTUM, true],
            [CHINA, false],
          ],
        );

        const dossier = yield* service.getDossier({ runId: RUN_ID, dossierId: CHINA });
        assert.strictEqual(dossier.trend.inbox?.production?.threadId, "thread-1");
        assert.strictEqual(dossier.trend.isNew, false);
      }),
    ),
  );

  it.effect("pages the evidence of a dossier and keeps the 28-day curve and coverage", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        const service = yield* imported;
        const dossier = yield* service.getDossier({
          runId: RUN_ID,
          dossierId: QUANTUM,
          evidenceOffset: 6,
          evidenceLimit: 6,
        });
        assert.strictEqual(dossier.curve.length, 28);
        assert.strictEqual(dossier.affinityThreshold, 0.6);
        assert.deepStrictEqual(
          dossier.coverage.map((entry) => [entry.source, entry.daysComplete, entry.daysPartial]),
          [
            ["hn", 28, 0],
            ["github", 0, 28],
          ],
        );
        assert.strictEqual(dossier.evidenceTotal, 10);
        assert.strictEqual(dossier.evidenceOffset, 6);
        assert.strictEqual(dossier.evidence.length, 4);
        // The range spans every selected item, older than the 28-day window included.
        assert.deepStrictEqual(dossier.evidenceRange, {
          from: "2026-09-09T08:27:14.000Z",
          to: "2026-10-16T18:00:18.000Z",
        });

        const missingDossier = yield* service
          .getDossier({ runId: RUN_ID, dossierId: EditorialDossierId.make("dos_missing") })
          .pipe(Effect.flip);
        assert.strictEqual(missingDossier.reason, "dossier-not-found");
        const missingRun = yield* service
          .getInbox({ runId: EditorialRunId.make("run_missing") })
          .pipe(Effect.flip);
        assert.strictEqual(missingRun.reason, "run-not-found");
      }),
    ),
  );

  it.effect("skips a malformed dossier and reloads a run when its files change", () =>
    withEditorial(({ runDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* imported;
        assert.strictEqual((yield* service.getInbox({})).total, 3);

        yield* fs.writeFileString(path.join(runDir, "dossiers", "99-dos_broken.json"), "{");
        yield* fs.remove(path.join(runDir, "dossiers", "13-dos_bbb80d57481e.json"));
        yield* (yield* EditorialImportService).sync;
        const inbox = yield* service.getInbox({});
        assert.deepStrictEqual(
          inbox.trends.map((trend) => trend.dossierId),
          [CHINA, JUDGE],
        );
        const sql = yield* EditorialSql;
        const [row] = yield* sql<{
          readonly import_state: string;
          readonly skipped_files_json: string;
        }>`
          SELECT import_state, skipped_files_json FROM editorial_runs
        `;
        assert.strictEqual(row?.import_state, "partial");
        assert.deepStrictEqual(JSON.parse(row?.skipped_files_json ?? "[]"), [
          "dossiers/99-dos_broken.json",
        ]);
      }),
    ),
  );
});
