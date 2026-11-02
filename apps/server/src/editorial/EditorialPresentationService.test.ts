import { assert, describe, it } from "@effect/vitest";
import {
  EditorialDossierId,
  EditorialRunId,
  PRESENTATION_EVIDENCE_LIMIT,
  PRESENTATION_EXCERPT_CHARS,
  TextGenerationError,
} from "@t3tools/contracts";
import {
  hashTrendPresentationInput,
  type TrendPresentationGenerationInput,
  type TrendPresentationGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as EditorialPresentation from "./EditorialPresentationService.ts";
import { EditorialPresentationService } from "./EditorialPresentationService.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import { SINGULARIDEV_PROFILE_V1, presentationProfileFromBytes } from "./channelProfile.ts";
import { withEditorial } from "./editorialLayer.testkit.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";
import { presentationsForRun } from "./presentationRead.ts";
import { EditorialRunDirectory } from "./RunDirectory.ts";

const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");
const QUANTUM = EditorialDossierId.make("dos_bbb80d57481e");
const CHINA = EditorialDossierId.make("dos_ead8cfa066df");
const JUDGE = EditorialDossierId.make("dos_82c53bb05e52");

interface Generator {
  readonly calls: Ref.Ref<ReadonlyArray<TrendPresentationGenerationInput>>;
  /** Trend ids (signal ids) whose generation fails. */
  readonly failing: Ref.Ref<ReadonlySet<string>>;
  /** When set, every generation waits for it before answering. */
  readonly gate: Ref.Ref<Deferred.Deferred<void> | null>;
}

const answer = (
  input: TrendPresentationGenerationInput,
  call: number,
): TrendPresentationGenerationResult => {
  const first = input.evidence[0]?.itemId ?? "none";
  return {
    title: `Título ${call} de ${input.trend.terms.slice(0, 2).join(" ")}`,
    summary: {
      whatHappened: `Pasó algo [${first}].`,
      whyItMatters: "Toca agentes de código.",
      videoAngle: "Un video posible.",
    },
    citedItemIds: [first],
    warnings: call === 1 ? [] : ["regenerated"],
    provider: "claudeAgent",
    model: "claude-haiku-5-5",
    promptVersion: "trend-presentation.v3",
    generatedAt: `2026-10-31T12:00:0${call % 10}.000Z`,
    inputHash: "provider-hash",
  };
};

const textGenerationLayer = (generator: Generator) =>
  Layer.succeed(
    TextGeneration,
    TextGeneration.of({
      generateCommitMessage: () => Effect.die("unused"),
      generatePrContent: () => Effect.die("unused"),
      generateBranchName: () => Effect.die("unused"),
      generateThreadTitle: () => Effect.die("unused"),
      generateReviewGuide: () => Effect.die("unused"),
      generateTrendPresentation: (input) =>
        Effect.gen(function* () {
          const gate = yield* Ref.get(generator.gate);
          if (gate !== null) yield* Deferred.await(gate);
          const calls = yield* Ref.updateAndGet(generator.calls, (all) => [...all, input]);
          if ((yield* Ref.get(generator.failing)).has(input.trend.id)) {
            return yield* new TextGenerationError({
              operation: "generateTrendPresentation",
              detail: "simulated failure",
            });
          }
          return answer(input, calls.length);
        }),
    }),
  );

const makeGenerator = Effect.gen(function* () {
  return {
    calls: yield* Ref.make<ReadonlyArray<TrendPresentationGenerationInput>>([]),
    failing: yield* Ref.make<ReadonlySet<string>>(new Set()),
    gate: yield* Ref.make<Deferred.Deferred<void> | null>(null),
  } satisfies Generator;
});

const presentationLayer = (generator: Generator) =>
  EditorialPresentation.layer.pipe(
    Layer.provide(textGenerationLayer(generator)),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "editorial-presentation-" })),
  );

/**
 * Runs `effect` with the presentation service over the editorial services of a fresh
 * database and a copy of the fixture run (shared run directory, read side, importer).
 */
const withDrafting = <A, E, R>(
  effect: (
    generator: Generator,
    runs: { readonly dir: string; readonly runDir: string },
  ) => Effect.Effect<A, E, R>,
) =>
  withEditorial((runs) =>
    Effect.gen(function* () {
      const generator = yield* makeGenerator;
      return yield* effect(generator, runs).pipe(Effect.provide(presentationLayer(generator)));
    }),
  );

/** What each dossier of the run shows, as the read side computes it. */
const shown = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  const directory = yield* EditorialRunDirectory;
  return yield* presentationsForRun(sql, directory, RUN_ID);
});

const presentationRows = Effect.gen(function* () {
  const sql = yield* EditorialSql;
  return yield* sql<{
    readonly dossier_id: string;
    readonly trend_key: string;
    readonly revision: number;
    readonly status: string;
    readonly title: string | null;
    readonly error: string | null;
  }>`
    SELECT dossier_id, trend_key, revision, status, title, error
    FROM editorial_presentations ORDER BY dossier_id, revision
  `;
});

describe("EditorialPresentationService", () => {
  it("hashes the fixed profile to the hash the engine recorded in the dossiers", () => {
    const profile = presentationProfileFromBytes(SINGULARIDEV_PROFILE_V1, 1);
    assert.strictEqual(
      profile.hash,
      "sha256:db510e303cb7f3cff7099230a00d36b1918f28a0e6aa6b8be01727649b8bb80d",
    );
    assert.include(profile.text, "Channel: SingulariDev");
  });

  it.effect("ensure generates once and returns the stored presentation for the same input", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        const first = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        const second = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });

        assert.isFalse(first.reused);
        assert.isTrue(second.reused);
        assert.deepStrictEqual(second.presentation, first.presentation);
        assert.strictEqual(first.presentation.model, "claude-haiku-5-5");
        assert.strictEqual(first.presentation.promptVersion, "trend-presentation.v3");

        const calls = yield* Ref.get(generator.calls);
        assert.strictEqual(calls.length, 1);
        const input = calls[0]!;
        // Deterministic engine data and evidence, never more than twelve items.
        assert.strictEqual(input.trend.id, "sig_69a4b83dd577");
        assert.deepStrictEqual(input.trend.terms.slice(0, 3), ["quantum", "computing", "ibm"]);
        assert.isAtMost(input.evidence.length, 12);
        assert.isTrue(input.evidence.every((item) => item.url.startsWith("https://")));
        assert.strictEqual(input.profile.version, 1);

        const rows = yield* presentationRows;
        assert.deepStrictEqual(
          rows.map((row) => [row.dossier_id, row.trend_key, row.revision, row.status]),
          [[QUANTUM, "sig_69a4b83dd577", 1, "ready"]],
        );
      }),
    ),
  );

  it.effect("regenerate adds a revision, keeps the previous row and reads back the newest", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        const first = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        const regenerated = yield* service.regenerate({ runId: RUN_ID, dossierId: QUANTUM });

        assert.isFalse(regenerated.reused);
        assert.notStrictEqual(regenerated.presentation.title, first.presentation.title);
        assert.deepStrictEqual(regenerated.warnings, ["regenerated"]);
        assert.strictEqual((yield* Ref.get(generator.calls)).length, 2);

        const rows = yield* presentationRows;
        assert.deepStrictEqual(
          rows.map((row) => [row.revision, row.status, row.title]),
          [
            [1, "ready", first.presentation.title],
            [2, "ready", regenerated.presentation.title],
          ],
        );
        const ready = yield* shown;
        assert.strictEqual(ready.get(QUANTUM)?.title, regenerated.presentation.title);
        assert.strictEqual(ready.get(QUANTUM)?.status, "current");
        // ensure now returns the newest revision without generating.
        const again = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        assert.isTrue(again.reused);
        assert.strictEqual(again.presentation.title, regenerated.presentation.title);
      }),
    ),
  );

  it.effect("ensureAll records a failure, keeps going and resumes only what is missing", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        yield* Ref.set(generator.failing, new Set(["sig_833479e1f4de"]));

        const firstPass = yield* service.ensureAll(RUN_ID, { concurrency: 2 });
        assert.deepStrictEqual(
          [firstPass.total, firstPass.ready, firstPass.failed, firstPass.status],
          [3, 2, 1, "idle"],
        );
        const failedRow = (yield* presentationRows).find((row) => row.dossier_id === CHINA);
        assert.strictEqual(failedRow?.status, "failed");
        assert.include(failedRow?.error ?? "", "simulated failure");

        yield* Ref.set(generator.failing, new Set());
        const secondPass = yield* service.ensureAll(RUN_ID);
        assert.deepStrictEqual([secondPass.ready, secondPass.failed], [3, 0]);
        const calls = yield* Ref.get(generator.calls);
        // Three in the first pass, then only the failed dossier.
        assert.strictEqual(calls.length, 4);
        assert.strictEqual(calls[3]?.trend.id, "sig_833479e1f4de");
        assert.deepStrictEqual(
          (yield* presentationRows)
            .filter((row) => row.dossier_id === CHINA)
            .map((row) => [row.revision, row.status]),
          [
            [1, "failed"],
            [2, "ready"],
          ],
        );
      }),
    ),
  );

  it.effect("startRun drafts in the background and reports progress until it finishes", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        const gate = yield* Deferred.make<void>();
        yield* Ref.set(generator.gate, gate);

        const started = yield* service.startRun(RUN_ID);
        assert.deepStrictEqual([started.status, started.total, started.ready], ["running", 3, 0]);
        assert.isNotNull(started.startedAt);
        // A second request while it runs reports the same job instead of starting another.
        const again = yield* service.startRun(RUN_ID);
        assert.strictEqual(again.startedAt, started.startedAt);

        yield* Deferred.succeed(gate, undefined);
        const finished = yield* service.awaitRun(RUN_ID);
        assert.deepStrictEqual([finished.status, finished.ready, finished.failed], ["idle", 3, 0]);
        assert.isNotNull(finished.finishedAt);
        assert.strictEqual((yield* Ref.get(generator.calls)).length, 3);

        const missing = yield* service
          .startRun(EditorialRunId.make("run_missing"))
          .pipe(Effect.flip);
        assert.strictEqual(missing.reason, "run-not-found");
      }),
    ),
  );

  it.effect("a new prompt version marks stored text stale and ensure writes it again", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        const sql = yield* EditorialSql;
        const first = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        const input = (yield* Ref.get(generator.calls))[0]!;
        // The stored row as the previous prompt left it: same input, older prompt version.
        yield* sql`
          UPDATE editorial_presentations
          SET input_hash = ${hashTrendPresentationInput(input, "trend-presentation.v2")},
              prompt_version = 'trend-presentation.v2'
        `;

        const before = (yield* shown).get(QUANTUM);
        assert.strictEqual(before?.status, "stale");
        assert.strictEqual(before?.title, first.presentation.title);

        const again = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        assert.isFalse(again.reused);
        assert.strictEqual((yield* Ref.get(generator.calls)).length, 2);
        const after = (yield* shown).get(QUANTUM);
        assert.strictEqual(after?.status, "current");
        assert.strictEqual(after?.title, again.presentation.title);
        assert.deepStrictEqual(
          (yield* presentationRows).map((row) => [row.revision, row.status]),
          [
            [1, "ready"],
            [2, "ready"],
          ],
        );
      }),
    ),
  );

  it.effect("an unknown dossier fails without writing a row", () =>
    withDrafting(() =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        const error = yield* service
          .ensure({ runId: RUN_ID, dossierId: EditorialDossierId.make("dos_missing") })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "dossier-not-found");
        assert.deepStrictEqual(yield* presentationRows, []);
      }),
    ),
  );

  it.effect("marks rows left pending by a previous process as failed", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        const sql = yield* EditorialSql;
        yield* sql`
          INSERT INTO editorial_presentations (
            presentation_id, run_id, dossier_id, trend_key, input_hash, revision, requested_at, status
          ) VALUES ('p-1', ${RUN_ID}, ${JUDGE}, 'sig', 'sha256:x', 1, '2026-10-31T00:00:00.000Z', 'pending')
        `;
        const generator = yield* makeGenerator;
        // Building the service is the restart.
        const rows = yield* presentationRows.pipe(Effect.provide(presentationLayer(generator)));
        assert.deepStrictEqual(
          rows.map((row) => [row.status, row.error]),
          [["failed", "interrupted by a server restart"]],
        );
      }),
    ),
  );
});

describe("EditorialReadService with presentations", () => {
  it.effect("fills presentation in the inbox and the dossier only where one is ready", () =>
    withDrafting(() =>
      Effect.gen(function* () {
        yield* (yield* EditorialImportService).sync;
        const read = yield* EditorialReadService;
        const before = yield* read.getInbox({});
        assert.isTrue(before.trends.every((trend) => trend.presentation === undefined));

        const service = yield* EditorialPresentationService;
        const drafted = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });

        const inbox = yield* read.getInbox({});
        const byId = new Map(inbox.trends.map((trend) => [trend.dossierId, trend]));
        assert.deepStrictEqual(byId.get(QUANTUM)?.presentation, drafted.presentation);
        assert.strictEqual(byId.get(QUANTUM)?.presentation?.status, "current");
        assert.isUndefined(byId.get(CHINA)?.presentation);
        // The engine's words stay next to the assistant's title.
        assert.strictEqual(byId.get(QUANTUM)?.label, "quantum computing ibm open");

        const dossier = yield* read.getDossier({ runId: RUN_ID, dossierId: QUANTUM });
        assert.deepStrictEqual(dossier.trend.presentation, drafted.presentation);
        const other = yield* read.getDossier({ runId: RUN_ID, dossierId: JUDGE });
        assert.isUndefined(other.trend.presentation);
      }),
    ),
  );

  it.effect("sends at most twelve evidence items, each excerpt cut to 500 characters", () =>
    withDrafting((generator, runs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = `${runs.runDir}/dossiers/13-dos_bbb80d57481e.json`;
        const dossier = JSON.parse(yield* fs.readFileString(file)) as {
          evidence: Array<Record<string, unknown>>;
        };
        // An imported run may store longer excerpts than the engine's default: twenty of 1,200.
        const long = "x".repeat(1_200);
        const template = dossier.evidence[0]!;
        dossier.evidence = Array.from({ length: 20 }, (_, index) => ({
          ...template,
          itemId: `${String(template["itemId"])}-${index}`,
          excerpt: long,
        }));
        yield* fs.writeFileString(file, JSON.stringify(dossier));
        yield* (yield* EditorialImportService).sync;

        yield* (yield* EditorialPresentationService).ensure({ runId: RUN_ID, dossierId: QUANTUM });
        const input = (yield* Ref.get(generator.calls))[0]!;
        assert.strictEqual(input.evidence.length, PRESENTATION_EVIDENCE_LIMIT);
        assert.isTrue(
          input.evidence.every(
            (item) => item.excerpt === long.slice(0, PRESENTATION_EXCERPT_CHARS),
          ),
        );
        assert.strictEqual(PRESENTATION_EXCERPT_CHARS, 500);
      }),
    ),
  );

  it.effect("a changed excerpt marks the presentation stale before anyone drafts again", () =>
    withDrafting((_generator, runs) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* (yield* EditorialImportService).sync;
        const read = yield* EditorialReadService;
        const service = yield* EditorialPresentationService;
        const drafted = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });

        const file = `${runs.runDir}/dossiers/13-dos_bbb80d57481e.json`;
        const dossier = JSON.parse(yield* fs.readFileString(file)) as {
          evidence: Array<{ excerpt?: string }>;
        };
        dossier.evidence[0]!.excerpt = "IBM published a new quantum roadmap.";
        yield* fs.writeFileString(file, JSON.stringify(dossier));

        // The read shows the old text, marked stale, before ensure runs.
        const stale = yield* read.getDossier({ runId: RUN_ID, dossierId: QUANTUM });
        assert.strictEqual(stale.trend.presentation?.status, "stale");
        assert.strictEqual(stale.trend.presentation?.title, drafted.presentation.title);
        const inbox = yield* read.getInbox({});
        const row = inbox.trends.find((trend) => trend.dossierId === QUANTUM);
        assert.strictEqual(row?.presentation?.status, "stale");

        const changed = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        assert.isFalse(changed.reused);
        const current = yield* read.getDossier({ runId: RUN_ID, dossierId: QUANTUM });
        assert.strictEqual(current.trend.presentation?.status, "current");
        assert.strictEqual(current.trend.presentation?.title, changed.presentation.title);
        // Unchanged evidence is still reused.
        assert.isTrue((yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM })).reused);
      }),
    ),
  );
});
