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
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as EditorialPresentation from "./EditorialPresentationService.ts";
import { draftBudgetMonth, EditorialPresentationService } from "./EditorialPresentationService.ts";
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
  /** How many of the next answers describe the data collection instead of the news. */
  readonly offTopic: Ref.Ref<number>;
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
    promptVersion: "trend-presentation.v5",
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
          const offTopic = yield* Ref.getAndUpdate(generator.offTopic, (left) =>
            Math.max(0, left - 1),
          );
          const reply = answer(input, calls.length);
          return offTopic === 0
            ? reply
            : {
                ...reply,
                summary: {
                  ...reply.summary,
                  whatHappened:
                    "En los últimos 7 días el motor registró 11 elementos de 11 autores distintos.",
                },
              };
        }),
    }),
  );

const makeGenerator = Effect.gen(function* () {
  return {
    calls: yield* Ref.make<ReadonlyArray<TrendPresentationGenerationInput>>([]),
    failing: yield* Ref.make<ReadonlySet<string>>(new Set()),
    gate: yield* Ref.make<Deferred.Deferred<void> | null>(null),
    offTopic: yield* Ref.make(0),
  } satisfies Generator;
});

const presentationLayer = (
  generator: Generator,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  EditorialPresentation.layer.pipe(
    Layer.provide(textGenerationLayer(generator)),
    Layer.provide(ServerSettings.layerTest(settings)),
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
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  withEditorial((runs) =>
    Effect.gen(function* () {
      const generator = yield* makeGenerator;
      return yield* effect(generator, runs).pipe(
        Effect.provide(presentationLayer(generator, settings)),
      );
    }),
  );

/** Every provider that settings could fall back to, switched off in Settings › Providers. */
const ALL_PROVIDERS_DISABLED = {
  providerInstances: Object.fromEntries(
    ["codex", "claudeAgent", "cursor", "grok", "muse", "pi", "opencode", "antigravity"].map(
      (driver) => [driver, { driver, enabled: false, config: {} }],
    ),
  ),
} as Parameters<typeof ServerSettings.layerTest>[0];

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
        assert.strictEqual(first.presentation.promptVersion, "trend-presentation.v5");

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

  it.effect("retries once a text about the data collection, naming the problem to the model", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        yield* Ref.set(generator.offTopic, 1);
        const result = yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });

        assert.notInclude(result.presentation.summary.whatHappened, "motor");
        const calls = yield* Ref.get(generator.calls);
        assert.deepStrictEqual(
          calls.map((call) => call.rejectedBecause),
          [
            undefined,
            "it described how the data was collected instead of the news (Qué pasó: «el motor registro»; Qué pasó: «11 elementos»; Qué pasó: «autores distintos»)",
          ],
        );
        assert.deepStrictEqual(
          (yield* presentationRows).map((row) => [row.revision, row.status]),
          [[1, "ready"]],
        );
      }),
    ),
  );

  it.effect("fails the row and stores nothing when the retry also describes the collection", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        yield* Ref.set(generator.offTopic, 2);
        const error = yield* service
          .ensure({ runId: RUN_ID, dossierId: QUANTUM })
          .pipe(Effect.flip);

        assert.strictEqual(error.reason, "generation-failed");
        assert.strictEqual(
          error.message,
          "«Qué pasó» describía cómo se reunieron los datos y no las noticias. Regenera o elige otro modelo en Ajustes › Editorial › Redacción.",
        );
        // The rejected words stay in the log and the retry, never in what the dossier shows.
        assert.notMatch(error.message, /motor|elementos|autores/);
        assert.strictEqual((yield* Ref.get(generator.calls)).length, 2);
        const rows = yield* presentationRows;
        assert.deepStrictEqual(
          rows.map((row) => [row.status, row.title, row.error]),
          [["failed", null, error.message]],
        );
        assert.isUndefined((yield* shown).get(QUANTUM));
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

  it.effect("a new prompt version marks stored text outdated and ensure writes it again", () =>
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

        // Kept, but the dossier draws no story for it: no model call, no row removed.
        const before = (yield* shown).get(QUANTUM);
        assert.strictEqual(before?.status, "outdated");
        assert.strictEqual(before?.title, first.presentation.title);
        assert.strictEqual((yield* Ref.get(generator.calls)).length, 1);

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

  it.effect("a stored text about the collection is outdated, whatever its prompt version", () =>
    withDrafting(() =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        const sql = yield* EditorialSql;
        yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        assert.strictEqual((yield* shown).get(QUANTUM)?.status, "current");
        // A text stored before the voice check, or under an older version of it.
        yield* sql`
          UPDATE editorial_presentations
          SET what_happened = 'El motor registró 11 elementos de 11 autores distintos.'
        `;
        assert.strictEqual((yield* shown).get(QUANTUM)?.status, "outdated");
        assert.deepStrictEqual(
          (yield* presentationRows).map((row) => row.status),
          ["ready"],
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

  it.effect("the monthly cap refuses drafting with a typed error and counts only this month", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-15T12:00:00.000Z"));
        const service = yield* EditorialPresentationService;
        const sql = yield* EditorialSql;
        const month = draftBudgetMonth(Date.parse("2026-11-15T12:00:00.000Z"));
        const previousMonth = draftBudgetMonth(Date.parse(month.from) - 1).from;
        // An attempt of the previous month does not count.
        yield* sql`
          INSERT INTO editorial_presentations (
            presentation_id, run_id, dossier_id, trend_key, input_hash, revision, requested_at, status
          ) VALUES ('p-old', ${RUN_ID}, ${JUDGE}, 'sig', 'sha256:old', 1,
            ${previousMonth}, 'pending')
        `;
        assert.deepStrictEqual(yield* service.getBudget, {
          monthlyLimit: 600,
          usedThisMonth: 0,
          month: "2026-11",
        });

        yield* service.updateBudget(2);
        // A failed attempt does not count: a night without a provider never eats the month.
        yield* Ref.set(generator.failing, new Set(["sig_833479e1f4de"]));
        yield* service.ensure({ runId: RUN_ID, dossierId: CHINA }).pipe(Effect.flip);
        assert.strictEqual((yield* service.getBudget).usedThisMonth, 0);
        yield* Ref.set(generator.failing, new Set());
        yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM });
        yield* service.ensure({ runId: RUN_ID, dossierId: CHINA });
        const refused = yield* service
          .ensure({ runId: RUN_ID, dossierId: JUDGE })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "budget-reached");
        assert.strictEqual(refused.message, "Monthly drafting cap reached (2/2).");
        const regenerate = yield* service
          .regenerate({ runId: RUN_ID, dossierId: QUANTUM })
          .pipe(Effect.flip);
        assert.strictEqual(regenerate.reason, "budget-reached");
        // The refusals wrote nothing and called no provider; a ready text is still returned.
        assert.strictEqual((yield* Ref.get(generator.calls)).length, 3);
        assert.strictEqual((yield* presentationRows).length, 4);
        assert.isTrue((yield* service.ensure({ runId: RUN_ID, dossierId: QUANTUM })).reused);
        assert.deepStrictEqual(yield* service.getBudget, {
          monthlyLimit: 2,
          usedThisMonth: 2,
          month: "2026-11",
        });

        // 0 lifts the cap.
        yield* service.updateBudget(0);
        yield* service.ensure({ runId: RUN_ID, dossierId: JUDGE });
        assert.deepStrictEqual(yield* service.getBudget, {
          monthlyLimit: 0,
          usedThisMonth: 3,
          month: "2026-11",
        });
        // The next month starts from zero.
        yield* TestClock.setTime(Date.parse(month.to));
        assert.strictEqual((yield* service.getBudget).usedThisMonth, 0);
      }),
    ),
  );

  it.effect("a result that cannot be stored frees its unit of the cap", () =>
    withDrafting(() =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        const sql = yield* EditorialSql;
        yield* service.updateBudget(1);
        yield* sql.unsafe(
          "CREATE TRIGGER refuse_ready BEFORE UPDATE OF status ON editorial_presentations WHEN NEW.status = 'ready' BEGIN SELECT RAISE(FAIL, 'injected write failure'); END",
        );
        const failure = yield* service
          .ensure({ runId: RUN_ID, dossierId: QUANTUM })
          .pipe(Effect.flip);
        yield* sql.unsafe("DROP TRIGGER refuse_ready");

        assert.strictEqual(failure.reason, "storage-failed");
        const rows = yield* presentationRows;
        assert.deepStrictEqual(
          rows.map((row) => row.status),
          ["failed"],
        );
        assert.include(rows[0]?.error ?? "", "markReady");
        assert.strictEqual((yield* service.getBudget).usedThisMonth, 0);
        const next = yield* service.ensure({ runId: RUN_ID, dossierId: CHINA });
        assert.isFalse(next.reused);
      }),
    ),
  );

  it.effect("a disabled drafting provider is never called, alone or for the whole run", () =>
    withDrafting(
      (generator) =>
        Effect.gen(function* () {
          const service = yield* EditorialPresentationService;
          assert.isFalse(yield* service.draftingProviderEnabled);
          const refused = yield* service
            .ensure({ runId: RUN_ID, dossierId: QUANTUM })
            .pipe(Effect.flip);
          assert.strictEqual(refused.reason, "provider-disabled");
          const progress = yield* service.ensureAll(RUN_ID, { concurrency: 2 });
          assert.deepStrictEqual([progress.total, progress.ready, progress.failed], [3, 0, 0]);
          assert.strictEqual((yield* Ref.get(generator.calls)).length, 0);
          assert.deepStrictEqual(yield* presentationRows, []);
        }),
      ALL_PROVIDERS_DISABLED,
    ),
  );

  it.effect("ensureAll stops at the cap and leaves the rest undrafted, without failed rows", () =>
    withDrafting((generator) =>
      Effect.gen(function* () {
        const service = yield* EditorialPresentationService;
        yield* service.updateBudget(1);
        // Two in flight never both take the last unit.
        const progress = yield* service.ensureAll(RUN_ID, { concurrency: 2 });
        assert.deepStrictEqual([progress.total, progress.ready, progress.failed], [3, 1, 0]);
        assert.strictEqual((yield* Ref.get(generator.calls)).length, 1);
        assert.deepStrictEqual(
          (yield* presentationRows).map((row) => row.status),
          ["ready"],
        );
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
        // A supplementary character sits across the cut: the boundary must not split its pair.
        const long = `${"x".repeat(499)}😀${"y".repeat(700)}`;
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
        const expected = Array.from(long).slice(0, PRESENTATION_EXCERPT_CHARS).join("");
        assert.isTrue(input.evidence.every((item) => item.excerpt === expected));
        assert.isTrue(input.evidence.every((item) => item.excerpt.isWellFormed()));
        assert.isTrue(input.evidence.every((item) => item.excerpt.endsWith("😀")));
        assert.notStrictEqual(expected, long.slice(0, PRESENTATION_EXCERPT_CHARS));
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
