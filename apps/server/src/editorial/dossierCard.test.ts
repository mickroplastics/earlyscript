import { assert, describe, it } from "@effect/vitest";
import { EditorialDossierId, EditorialRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { priorDecisionOf, sameTopicByItems, type ThreadDecisionRow } from "./cardDecisions.ts";
import { readDossierExtras } from "./dossierCard.ts";
import { EditorialImportService } from "./EditorialImportService.ts";
import { EditorialReadService } from "./EditorialReadService.ts";
import {
  addNativeFixtureRun,
  FIXTURE_RUN_ID,
  NATIVE_FIXTURE_RUN_ID,
  withEditorial,
} from "./editorialLayer.testkit.ts";
import { EditorialSql } from "./persistence/EditorialDatabase.ts";

const NATIVE_RUN = EditorialRunId.make(NATIVE_FIXTURE_RUN_ID);
const MARKETS = EditorialDossierId.make("dos_47ea4d4f2ccc");
const WORKERS = EditorialDossierId.make("dos_38ceab3f670f");
const MARKETS_FILE = "01-dos_47ea4d4f2ccc.json";
const MARKETS_KEY = "sig_67f2a4ea9b88";
const QUANTUM = EditorialDossierId.make("dos_bbb80d57481e");

// The provisional v3 block, named after the fields of the v3 mock-up (`maqueta-cortes.json`).
const CARD_BLOCK = {
  section: "moving",
  position: 3,
  state: "señal débil",
  since: "2026-10-27",
  perennial_antecedent: false,
  weeks_by_source: [
    { source: "hn", status: "comparable", weeks: [1, 3, 0, 5] },
    { source: "github", status: "comparable", weeks: [0, 0, "?", 2] },
    { source: "rss", status: "parcial", weeks: [0, 0, 0, 1] },
    { source: "wikipedia", status: "no usada", weeks: null },
  ],
  first_source: "hn",
  first_day: "2026-09-19",
  second_source: "github",
  second_day: "2026-10-28",
  nearest_include: "developer tooling, SDKs and protocols for building AI products",
  keyword_hits: [
    { term: "agent", items: 1 },
    { term: "model", items: 2 },
  ],
  saturated: false,
  headlines: [
    {
      title: "Google struggling to make AI mode searches pay",
      source: "hn",
      url: "https://www.theregister.com/ai-and-ml/2026/10/29/google-struggling-to-make-ai-mode-searches-pay/5306181",
      day: "2026-10-29",
    },
  ],
  incomplete_sources: ["rss"],
};
const JUDGES_BLOCK = {
  opinions: [
    {
      judge: "opus",
      model: "claude-opus-5-5",
      utility: 4,
      fit: "core",
      reason: "JUDGE-REASON-OPUS",
      angle: "Who pays for AI search",
    },
    {
      judge: "sol",
      model: "gpt-6.1-sol",
      utility: 3,
      fit: "adjacent",
      reason: "JUDGE-REASON-SOL",
      angle: null,
    },
  ],
};

/** The native fixture run with the v3 blocks added to the markets dossier. */
const withCardRun = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* addNativeFixtureRun(dir);
    const file = path.join(dir, NATIVE_FIXTURE_RUN_ID, "dossiers", MARKETS_FILE);
    const dossier = JSON.parse(yield* fs.readFileString(file));
    yield* fs.writeFileString(
      file,
      JSON.stringify({ ...dossier, card: CARD_BLOCK, judges: JUDGES_BLOCK }, null, 1),
    );
  });

const insertDecision = (input: {
  readonly threadId: string;
  readonly trendKey: string;
  readonly runId: string;
  readonly dossierId: string;
  readonly decidedAt: string;
  readonly cohort?: "human" | "trial";
}) =>
  Effect.gen(function* () {
    const sql = yield* EditorialSql;
    yield* sql`
      INSERT INTO editorial_video_threads (thread_id, environment_id, operation_id, mode,
        trend_key, run_id, dossier_id, created_by, created_at, cohort)
      VALUES (${input.threadId}, 'env-1', ${`op-${input.threadId}`}, 'assisted',
        ${input.trendKey}, ${input.runId}, ${input.dossierId}, 'operator', ${input.decidedAt},
        ${input.cohort ?? "human"})
    `;
    yield* sql`
      INSERT INTO editorial_decisions (decision_id, thread_id, action, utility, reason,
        clock_definitive, actor, decided_at)
      VALUES (${`dec-${input.threadId}`}, ${input.threadId}, 'accept', 4, 'already planned',
        1, 'operator', ${input.decidedAt})
    `;
  });

const imported = Effect.gen(function* () {
  yield* (yield* EditorialImportService).sync;
  return yield* EditorialReadService;
});

describe("brief trend card", () => {
  it.effect("reads the v3 card block and never puts the judges in the inbox", () =>
    withEditorial(({ dir }) =>
      Effect.gen(function* () {
        yield* withCardRun(dir);
        const service = yield* imported;
        const inbox = yield* service.getInbox({ runId: NATIVE_RUN });
        const markets = inbox.trends.find((trend) => trend.dossierId === MARKETS);
        const card = markets?.card;
        assert.ok(card);
        assert.strictEqual(card.origin, "v3");
        assert.strictEqual(card.section, "moving");
        assert.strictEqual(card.position, 3);
        assert.strictEqual(card.movement, "weak");
        assert.strictEqual(card.since, "2026-10-27");
        assert.deepStrictEqual(card.curve, [
          { source: "hn", status: "comparable", weeks: [1, 3, 0, 5] },
          { source: "github", status: "comparable", weeks: [0, 0, null, 2] },
          { source: "rss", status: "partial", weeks: [0, 0, 0, 1] },
          { source: "wikipedia", status: "unused", weeks: [] },
        ]);
        assert.strictEqual(card.sourceCount, 2);
        assert.deepStrictEqual(card.firstSource, { source: "hn", day: "2026-09-19" });
        assert.deepStrictEqual(card.fit.terms, ["agent", "model"]);
        assert.strictEqual(card.saturated, false);
        // The headline's item id is found in the evidence by its URL.
        assert.strictEqual(card.headlines[0]?.itemId, "itm_hn_50287431");
        assert.deepStrictEqual(
          card.evidence.map((item) => [item.itemId, item.day]),
          [
            ["itm_hn_50287431", "2026-10-29"],
            ["itm_hn_50251518", "2026-10-26"],
            ["itm_hn_50209163", "2026-10-23"],
          ],
        );
        assert.deepStrictEqual(card.incompleteSources, ["rss"]);
        assert.isNull(card.decision ?? null);
        assert.isNull(card.priorDecision ?? null);
        const wire = JSON.stringify(inbox);
        assert.notInclude(wire, "JUDGE-REASON");
        assert.notInclude(wire, "claude-opus-5-5");
        const dossier = yield* service.getDossier({ runId: NATIVE_RUN, dossierId: MARKETS });
        assert.notInclude(JSON.stringify(dossier), "JUDGE-REASON");

        // The other dossier of the run has no block: a derived card, nothing invented.
        const workers = inbox.trends.find((trend) => trend.dossierId === WORKERS)?.card;
        assert.strictEqual(workers?.origin, "derived");
        assert.isNull(workers?.movement);
        assert.isNull(workers?.section);
        assert.isNull(workers?.saturated);
        assert.strictEqual(workers?.curve[0]?.status, "total");
      }),
    ),
  );

  it.effect("derives a card for an Earlywindow dossier/1 from its curve and evidence", () =>
    withEditorial(() =>
      Effect.gen(function* () {
        const service = yield* imported;
        const inbox = yield* service.getInbox({ runId: EditorialRunId.make(FIXTURE_RUN_ID) });
        const quantum = inbox.trends.find((trend) => trend.dossierId === QUANTUM);
        const card = quantum?.card;
        assert.ok(card);
        assert.strictEqual(card.origin, "derived");
        // Four weeks of the 28-day curve; their sum is the 28-day count.
        assert.strictEqual(card.curve.length, 1);
        const weeks = card.curve[0]!.weeks;
        assert.strictEqual(weeks.length, 4);
        assert.strictEqual(
          weeks.reduce<number>((total, week) => total + (week ?? 0), 0),
          quantum!.items28d,
        );
        assert.strictEqual(weeks[3], quantum!.items7d);
        assert.isAtMost(card.evidence.length, 10);
        assert.strictEqual(card.headlines.length, 2);
      }),
    ),
  );

  it.effect(
    "shows the judges only after a decision with utility, and 'ya decidido' before the cutoff",
    () =>
      withEditorial(({ dir }) =>
        Effect.gen(function* () {
          yield* withCardRun(dir);
          const service = yield* imported;
          const input = { runId: NATIVE_RUN, dossierId: MARKETS };
          assert.deepStrictEqual(yield* service.getJudgeOpinion(input), { _tag: "hidden" });
          // A rehearsal's decision does not open it.
          yield* insertDecision({
            threadId: "thread-trial",
            trendKey: MARKETS_KEY,
            runId: NATIVE_FIXTURE_RUN_ID,
            dossierId: MARKETS,
            decidedAt: "2026-11-01T09:00:00.000Z",
            cohort: "trial",
          });
          assert.deepStrictEqual(yield* service.getJudgeOpinion(input), { _tag: "hidden" });

          // A decision after the cutoff (31 October): the card's decision, not "ya decidido".
          yield* insertDecision({
            threadId: "thread-after",
            trendKey: MARKETS_KEY,
            runId: NATIVE_FIXTURE_RUN_ID,
            dossierId: MARKETS,
            decidedAt: "2026-11-01T10:00:00.000Z",
          });
          const shown = yield* service.getJudgeOpinion(input);
          assert.strictEqual(shown._tag, "shown");
          if (shown._tag === "shown") {
            assert.strictEqual(shown.decidedAt, "2026-11-01T10:00:00.000Z");
            assert.strictEqual(shown.view.utility, 3.5);
            assert.deepStrictEqual(
              shown.view.opinions.map((opinion) => opinion.reason),
              ["JUDGE-REASON-OPUS", "JUDGE-REASON-SOL"],
            );
          }
          const after = (yield* service.getInbox({ runId: NATIVE_RUN })).trends.find(
            (trend) => trend.dossierId === MARKETS,
          )?.card;
          assert.strictEqual(after?.decision?.threadId, "thread-after");
          assert.isNull(after?.priorDecision ?? null);

          // An earlier thread on the same trend, decided before the cutoff: "ya decidido".
          yield* insertDecision({
            threadId: "thread-before",
            trendKey: MARKETS_KEY,
            runId: NATIVE_FIXTURE_RUN_ID,
            dossierId: MARKETS,
            decidedAt: "2026-10-20T10:00:00.000Z",
          });
          const before = (yield* service.getInbox({ runId: NATIVE_RUN })).trends;
          assert.strictEqual(
            before.find((trend) => trend.dossierId === MARKETS)?.card?.priorDecision?.threadId,
            "thread-before",
          );
          assert.strictEqual(
            before.find((trend) => trend.dossierId === MARKETS)?.card?.decision?.threadId,
            "thread-after",
          );
          // The workers trend shares no item with it.
          assert.isNull(
            before.find((trend) => trend.dossierId === WORKERS)?.card?.priorDecision ?? null,
          );
          // The workers trend has no decision: its opinion stays closed.
          const none = yield* service.getJudgeOpinion({ runId: NATIVE_RUN, dossierId: WORKERS });
          assert.deepStrictEqual(none, { _tag: "hidden" });
        }),
      ),
  );
});

describe("readDossierExtras", () => {
  it("tolerates missing, malformed and partial blocks", () => {
    assert.deepStrictEqual(readDossierExtras("{"), { card: null, judges: null });
    assert.deepStrictEqual(readDossierExtras("[]"), { card: null, judges: null });
    const partial = readDossierExtras(JSON.stringify({ card: { movement: "rebound" } }));
    assert.strictEqual(partial.card?.movement, "rebound");
    assert.isNull(partial.card?.weeksBySource ?? null);
    // A judge without a reason, or a utility out of scale, is not an opinion.
    const judges = readDossierExtras(
      JSON.stringify({
        judges: { opinions: [{ judge: "opus", utility: 9, reason: "fine" }, { judge: "sol" }] },
      }),
    ).judges;
    assert.deepStrictEqual(
      judges?.opinions.map((opinion) => opinion.utility),
      [null],
    );
    assert.isNull(judges?.utility);
  });
});

describe("dossier/2 movement block (Opus A)", () => {
  it("reads its weeks W0..W4 as W3..W0, its codes, first sources, fit and '?' rows", () => {
    const card = readDossierExtras(
      JSON.stringify({
        evidence: [
          {
            item_id: "itm_hn_1",
            permalink: "https://news.ycombinator.com/item?id=1",
            external_url: "https://example.com/a",
          },
        ],
        movement: {
          section: "background",
          slot: "background",
          position: 2,
          movement: "senal_fuerte",
          movement_since: "2026-10-09",
          perennial: true,
          by_source: [
            { source: "hn", status: "comparable", weeks: [5, 0, 3, 1, 9] },
            { source: "npm", status: "comparable", weeks: [2, null, 0, 0, 0] },
            { source: "rss", status: "parcial", weeks: [1, 0, 0, 0, 0] },
            { source: "wikipedia", status: "no_usada", weeks: [] },
          ],
          first_source: { source: "hn", at: "2026-09-01T10:00:00.000Z", item_id: "itm_hn_9" },
          second_source: null,
          fit: {
            nearest_include: "AI coding agents and agent harnesses for developers",
            matched_terms: ["agent"],
            headlines: [
              {
                item_id: "itm_hn_1",
                source: "hn",
                title: "A",
                permalink: "https://news.ycombinator.com/item?id=1",
              },
            ],
          },
          saturation: { perennial: true, items_life: 40 },
        },
      }),
    ).card;
    assert.strictEqual(card?.section, "background");
    assert.strictEqual(card?.movement, "senal_fuerte");
    assert.strictEqual(card?.since, "2026-10-09");
    assert.deepStrictEqual(card?.weeksBySource?.[0]?.weeks, [1, 3, 0, 5]);
    assert.deepStrictEqual(card?.weeksBySource?.[1]?.weeks, [0, 0, null, 2]);
    assert.deepStrictEqual(card?.firstSource, { source: "hn", day: "2026-09-01" });
    assert.deepStrictEqual(card?.keywordTerms, ["agent"]);
    assert.strictEqual(card?.headlines?.[0]?.url, "https://example.com/a");
    assert.deepStrictEqual(card?.incompleteSources, ["npm"]);
    assert.strictEqual(card?.saturated, true);
  });
});

describe("same topic for 'ya decidido'", () => {
  const row = (overrides: Partial<ThreadDecisionRow>): ThreadDecisionRow => ({
    thread_id: "t1",
    trend_key: "sig_a",
    run_id: "run_1",
    dossier_id: "dos_1",
    action: "reject",
    utility: 2,
    reason: "no",
    decided_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  });
  const trend = { trendKey: "sig_b", itemIds: new Set(["i1", "i2", "i3", "i4"]) };

  it("matches the same trend or half of the smaller evidence, two items at least", () => {
    assert.isTrue(sameTopicByItems(trend, { trendKey: "sig_b", itemIds: new Set() }));
    assert.isTrue(sameTopicByItems(trend, { trendKey: "sig_c", itemIds: new Set(["i1", "i2"]) }));
    assert.isFalse(sameTopicByItems(trend, { trendKey: "sig_c", itemIds: new Set(["i1"]) }));
    assert.isFalse(
      sameTopicByItems(trend, { trendKey: "sig_c", itemIds: new Set(["i1", "x", "y", "z", "w"]) }),
    );
  });

  it("takes the newest decision strictly before the cutoff", () => {
    const rows = [
      row({ thread_id: "late", trend_key: "sig_b", decided_at: "2026-10-10T00:00:00.000Z" }),
      row({ thread_id: "on-time", trend_key: "sig_b", decided_at: "2026-10-04T00:00:00.000Z" }),
      row({ thread_id: "other", trend_key: "sig_z", decided_at: "2026-10-03T00:00:00.000Z" }),
    ];
    const prior = priorDecisionOf(trend, "2026-10-05T00:00:00.000Z", rows, () => null);
    assert.strictEqual(prior?.threadId, "on-time");
    assert.strictEqual(prior?.action, "reject");
    assert.isNull(priorDecisionOf(trend, "2026-10-04T00:00:00.000Z", rows, () => null));
  });
});
