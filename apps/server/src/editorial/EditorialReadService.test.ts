import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EditorialDossierId, EditorialRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeWithRunsDir } from "./EditorialReadService.ts";

// Three dossiers of the run Earlywindow made on 27 October 2026 (cutoff 19 October), as the
// engine wrote them minus retrieval stamps.
const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");
const QUANTUM = EditorialDossierId.make("dos_bbb80d57481e");
const CHINA = EditorialDossierId.make("dos_ead8cfa066df");
const JUDGE = EditorialDossierId.make("dos_82c53bb05e52");

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

  it.effect("derives both ranks, weekly counts and the 14-day sparkline from the dossiers", () =>
    Effect.gen(function* () {
      const service = yield* makeWithRunsDir(yield* fixtureRunsDir);
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
      const quantum = inbox.trends.find((trend) => trend.dossierId === QUANTUM);
      assert.ok(quantum);
      assert.strictEqual(quantum.label, "quantum computing ibm open");
      assert.strictEqual(quantum.subtitle, "Designing more efficient quantum circuits with Claude");
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
      assert.strictEqual((yield* service.getInbox({})).total, 3);

      yield* fs.writeFileString(path.join(runDir, "dossiers", "99-dos_broken.json"), "{");
      yield* fs.remove(path.join(runDir, "dossiers", "13-dos_bbb80d57481e.json"));
      const inbox = yield* service.getInbox({});
      assert.deepStrictEqual(
        inbox.trends.map((trend) => trend.dossierId),
        [CHINA, JUDGE],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
