import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EditorialDossierId, EditorialRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeWithRunsDir } from "./EditorialReadService.ts";

// Three dossiers of the run Earlywindow made on 27 October 2026 (cutoff 19 October), in its
// dossier/1 format, as the engine wrote them.
const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");
const QUANTUM = EditorialDossierId.make("dos_bbb80d57481e");
const CHINA = EditorialDossierId.make("dos_ead8cfa066df");
const JUDGE = EditorialDossierId.make("dos_82c53bb05e52");
// Two of the 15 dossiers of the trend engine's run of 31 October 2026, in the native format,
// with the evidence cut to three items; run.json lists only those two files.
const NATIVE_RUN_ID = EditorialRunId.make("run_20261031_20261031T003855_5e57bf");
const MARKETS = EditorialDossierId.make("dos_47ea4d4f2ccc");
const WORKERS = EditorialDossierId.make("dos_38ceab3f670f");

const fixtureRunsDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(import.meta.dirname, "fixtures", "runs");
});

/** A writable copy of the fixture runs directory. */
const copyFixtureRuns = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "editorial-runs-" });
  yield* fs.copy(yield* fixtureRunsDir, dir);
  return { dir, runDir: path.join(dir, RUN_ID) };
});

describe("EditorialReadService", () => {
  it.effect("reads nothing from a missing or empty runs directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const empty = yield* fs.makeTempDirectoryScoped({ prefix: "editorial-empty-" });
      for (const dir of [empty, path.join(empty, "missing")]) {
        const service = yield* makeWithRunsDir(dir);
        assert.deepStrictEqual(yield* service.listRuns, []);
        const inbox = yield* service.getInbox({});
        assert.strictEqual(inbox.run, null);
        assert.deepStrictEqual(inbox.trends, []);
        assert.strictEqual(inbox.newCount, 0);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists a native and an Earlywindow run, newest cutoff first", () =>
    Effect.gen(function* () {
      const service = yield* makeWithRunsDir(yield* fixtureRunsDir);
      const runs = yield* service.listRuns;
      assert.deepStrictEqual(
        runs.map((run) => [
          run.runId,
          run.cutoffAt,
          run.configVersion,
          run.sources,
          run.dossierCount,
        ]),
        [
          [NATIVE_RUN_ID, "2026-10-31T00:00:00.000Z", "earlyscript.engine.v1", ["hn", "github"], 2],
          [RUN_ID, "2026-10-19T00:00:00.000Z", "engine.v0.02", ["hn", "github"], 3],
        ],
      );

      // The latest run is the default; its trends are new, the older run's are not.
      const latest = yield* service.getInbox({});
      assert.strictEqual(latest.run?.runId, NATIVE_RUN_ID);
      assert.deepStrictEqual(
        latest.trends.map((trend) => trend.dossierId),
        [WORKERS, MARKETS],
      );
      assert.strictEqual(latest.newCount, 2);
      assert.strictEqual((yield* service.getInbox({ runId: RUN_ID })).newCount, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("takes counts, positions and sources of a native dossier from the engine", () =>
    Effect.gen(function* () {
      const service = yield* makeWithRunsDir(yield* fixtureRunsDir);
      const inbox = yield* service.getInbox({ runId: NATIVE_RUN_ID });
      const markets = inbox.trends.find((trend) => trend.dossierId === MARKETS);
      assert.ok(markets);
      assert.strictEqual(markets.label, "markets money street wall");
      assert.strictEqual(markets.stage, "growing");
      assert.strictEqual(markets.items7d, 25);
      assert.strictEqual(markets.authors7d, 24);
      // Positions among the run's 15 eligible trends, not among the two in the fixture.
      assert.strictEqual(markets.volumeRank, 1);
      assert.strictEqual(markets.scoreRank, 4);
      assert.strictEqual(markets.score, 1.348184);
      assert.strictEqual(markets.growth, 0.955511);
      assert.strictEqual(markets.affinity, 0.755509);
      assert.deepStrictEqual(markets.sources, ["hn"]);
      assert.strictEqual(markets.subtitle, "Google struggling to make money from AI Mode");
      assert.deepStrictEqual(markets.sparkline, [0, 0, 3, 2, 1, 1, 2, 3, 4, 3, 5, 3, 6, 1]);

      const dossier = yield* service.getDossier({ runId: NATIVE_RUN_ID, dossierId: MARKETS });
      assert.strictEqual(dossier.rankMethod, "weighted_sum.v0.01");
      assert.deepStrictEqual(
        dossier.rankComponents.map((component) => component.name),
        ["growth", "log_authors_7d", "include_score"],
      );
      assert.strictEqual(dossier.affinityThreshold, 0.6);
      assert.strictEqual(dossier.curve.length, 28);
      assert.strictEqual(dossier.evidenceTotal, 3);
      assert.deepStrictEqual(dossier.evidenceRange, {
        from: "2026-10-23T14:01:41.000Z",
        to: "2026-10-29T11:38:56.000Z",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rebuilds counts, positions and the 14-day sparkline of Earlywindow dossiers", () =>
    Effect.gen(function* () {
      const service = yield* makeWithRunsDir(yield* fixtureRunsDir);
      const inbox = yield* service.getInbox({ runId: RUN_ID });
      assert.strictEqual(inbox.sort, "new-first-growth");
      // Growth: China 1.45, LLM judge 0.88, quantum 0.69.
      assert.deepStrictEqual(
        inbox.trends.map((trend) => trend.dossierId),
        [CHINA, JUDGE, QUANTUM],
      );
      const quantum = inbox.trends.find((trend) => trend.dossierId === QUANTUM);
      assert.ok(quantum);
      assert.strictEqual(quantum.label, "quantum computing ibm open");
      assert.strictEqual(quantum.subtitle, "Designing more efficient quantum circuits with Claude");
      assert.strictEqual(quantum.items7d, 11);
      assert.strictEqual(quantum.items28d, 38);
      assert.strictEqual(quantum.authors7d, 11);
      // 16 for China, 11 for both quantum and LLM judge: the lower signal id breaks the tie.
      assert.strictEqual(quantum.volumeRank, 2);
      assert.strictEqual(inbox.trends.find((trend) => trend.dossierId === JUDGE)?.volumeRank, 3);
      assert.strictEqual(quantum.scoreRank, 3);
      assert.strictEqual(quantum.affinity, 0.608747);
      // ln 2: the engine's log growth for a week that doubled.
      assert.closeTo(quantum.growth ?? 0, Math.LN2, 1e-6);
      assert.strictEqual(quantum.sourceCount, 1);
      assert.deepStrictEqual(quantum.sources, ["hn"]);
      assert.deepStrictEqual(quantum.sparkline, [2, 2, 1, 0, 0, 0, 0, 2, 0, 1, 5, 2, 0, 1]);

      assert.deepStrictEqual(
        (yield* service.getInbox({ runId: RUN_ID, sort: "volume" })).trends.map(
          (trend) => trend.dossierId,
        ),
        [CHINA, JUDGE, QUANTUM],
      );
      assert.deepStrictEqual(
        (yield* service.getInbox({ runId: RUN_ID, sort: "affinity", limit: 2 })).trends.map(
          (trend) => trend.dossierId,
        ),
        [JUDGE, CHINA],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("pages the evidence of a dossier and keeps the 28-day curve and coverage", () =>
    Effect.gen(function* () {
      const service = yield* makeWithRunsDir(yield* fixtureRunsDir);
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
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips a malformed dossier and reloads a run when its files change", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, runDir } = yield* copyFixtureRuns;
      const service = yield* makeWithRunsDir(dir);
      assert.strictEqual((yield* service.getInbox({ runId: RUN_ID })).total, 3);

      yield* fs.writeFileString(path.join(runDir, "dossiers", "99-dos_broken.json"), "{");
      yield* fs.remove(path.join(runDir, "dossiers", "13-dos_bbb80d57481e.json"));
      const inbox = yield* service.getInbox({ runId: RUN_ID });
      assert.deepStrictEqual(
        inbox.trends.map((trend) => trend.dossierId),
        [CHINA, JUDGE],
      );

      // A native run.json that fails its schema is skipped, not read as Earlywindow's.
      yield* fs.writeFileString(
        path.join(dir, NATIVE_RUN_ID, "run.json"),
        JSON.stringify({
          schema_version: "earlyscript.run/1",
          run_id: NATIVE_RUN_ID,
          cutoff_at: "2026-10-31T00:00:00.000Z",
        }),
      );
      assert.deepStrictEqual(
        (yield* service.listRuns).map((run) => run.runId),
        [RUN_ID],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
