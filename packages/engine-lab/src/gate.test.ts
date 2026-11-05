// @effect-diagnostics nodeBuiltinImport:off globalDate:off - the gate is computed over real engine outputs of a synthetic corpus.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { evaluateGate, shadowCards } from "./gate.ts";
import type { ArmOutput, ArmTrend, WorkerResult } from "./result.ts";
import { labelSyntheticCards } from "./synthetic.ts";
import { jobSpec, labFixture, weightCandidate } from "./testkit.ts";
import { evaluateJob } from "./worker.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-lab-gate-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
// A corpus in the past: a shadow's views are made after their cutoffs, by the real clock.
const fixture = labFixture(NodePath.join(root, "fixture"), { fromDay: "2026-07-01", days: 26 });
const AFTER = "2026-08-01T00:00:00.000Z";
const seen = (result: WorkerResult) => ({ views: result.views, startedAt: AFTER });
const options = {
  jobsRoot: NodePath.join(root, "jobs"),
  engineRoot: NodePath.resolve(import.meta.dirname, "../../.."),
};
const shadow = async (
  token: string,
  weights: Record<string, number>,
  cutoffs: ReadonlyArray<string>,
) => {
  const result = await evaluateJob(
    jobSpec(fixture, { token, candidate: weightCandidate(fixture, weights), cutoffs }),
    options,
  );
  expect(result.status, JSON.stringify(result.error)).toBe("ok");
  const { cards, members } = shadowCards(result);
  return { result, cards, members };
};

describe("promotion gate", () => {
  it("passes a better candidate over 7 labelled cutoffs after the freeze, and nothing less", async () => {
    const cutoffs = fixture.cutoffs.slice(0, 7);
    const { result, cards, members } = await shadow(
      "job-gate-better",
      { growth: 0.1, log_authors_7d: 0.9 },
      cutoffs,
    );
    // Blind: a card carries no arm, position or score.
    expect(Object.keys(cards[0]!).toSorted()).toEqual(["card_id", "cutoff", "headlines", "terms"]);
    const labels = labelSyntheticCards(cards);
    const frozenDay = "2026-07-01";
    const gate = evaluateGate({ result, members, labels, frozenDay, observed: seen(result) });
    expect(gate.verdict, gate.reasons.join(" ")).toBe("pass");
    expect(gate.g5_advantage.ci_lower).toBeGreaterThan(0);

    const missing = evaluateGate({
      result,
      members,
      labels: labels.slice(1),
      frozenDay,
      observed: seen(result),
    });
    expect(missing.verdict).toBe("inconclusive");
    const early = evaluateGate({
      result,
      members,
      labels,
      frozenDay: cutoffs[3]!.slice(0, 10),
      observed: seen(result),
    });
    expect(early.verdict).toBe("inconclusive");
    const ungraded = evaluateGate({
      result,
      members,
      labels: labels.map((l) => ({ ...l, grade: null })),
      frozenDay,
      observed: seen(result),
    });
    expect(ungraded.verdict).toBe("inconclusive");

    // Astra, B1: the same evidence, run before its days had passed, never counts.
    const viewedEarly = evaluateGate({
      result,
      members,
      labels,
      frozenDay,
      observed: {
        views: result.views.map((view) => ({ ...view, observed_at: "2026-07-02T00:00:00.000Z" })),
        startedAt: AFTER,
      },
    });
    expect(viewedEarly.verdict).toBe("inconclusive");
    expect(viewedEarly.reasons.join(" ")).toContain("viewed before they passed");
    const startedEarly = evaluateGate({
      result,
      members,
      labels,
      frozenDay,
      observed: { views: result.views, startedAt: cutoffs[2]! },
    });
    expect(startedEarly.verdict).toBe("inconclusive");
    const unrecorded = evaluateGate({
      result,
      members,
      labels,
      frozenDay,
      observed: { views: undefined, startedAt: AFTER },
    });
    expect(unrecorded.verdict).toBe("inconclusive");
  });

  it("counts days, not entries: one day seven times never passes (Sol, B3)", async () => {
    const one = await shadow("job-gate-one-day", { growth: 0.1, log_authors_7d: 0.9 }, [
      fixture.cutoffs[6]!,
    ]);
    // Sol's repeat-day case at the gate itself: the worker now refuses such a job outright.
    const result = {
      ...one.result,
      arms: {
        reference: Array(7).fill(one.result.arms.reference[0]!),
        candidate: Array(7).fill(one.result.arms.candidate[0]!),
      },
    };
    const { cards, members } = shadowCards(result);
    const gate = evaluateGate({
      result,
      members,
      labels: labelSyntheticCards(cards),
      frozenDay: "2026-07-01",
      observed: { views: result.arms.reference.map(() => one.result.views[0]!), startedAt: AFTER },
    });
    expect(gate.verdict).toBe("inconclusive");
    expect(gate.distinct_days).toBe(1);
    expect(gate.reasons.join(" ")).toContain("repeats days");
  });

  it("is inconclusive with fewer than 7 cutoffs and fails a clearly worse candidate", async () => {
    const few = await shadow(
      "job-gate-few",
      { growth: 0.1, log_authors_7d: 0.9 },
      fixture.cutoffs.slice(0, 3),
    );
    expect(
      evaluateGate({
        ...few,
        labels: labelSyntheticCards(few.cards),
        frozenDay: "2026-07-01",
        observed: seen(few.result),
      }).verdict,
    ).toBe("inconclusive");
    const worse = await shadow(
      "job-gate-worse",
      { growth: 2, log_authors_7d: 0 },
      fixture.cutoffs.slice(0, 7),
    );
    const gate = evaluateGate({
      ...worse,
      labels: labelSyntheticCards(worse.cards),
      frozenDay: "2026-07-01",
      observed: seen(worse.result),
    });
    expect(gate.verdict).not.toBe("pass");
    expect(gate.g5_advantage.mean).toBeLessThan(0);
  });
});

// Hand-built shadows: the gate's inference over topic families, apart from any engine run.
const DAYS = Array.from({ length: 7 }, (_, d) => `2026-12-0${d + 2}T00:00:00.000Z`);
const trendOf = (position: number, id: string, items: ReadonlyArray<string>): ArmTrend => ({
  position,
  trend_id: id,
  label: id,
  stage: "emerging",
  score: 1,
  components: [],
  items_7d: items.length,
  item_ids: items,
  member_keys: [],
  headlines: [],
});
const armOf = (cutoff: string, top: ReadonlyArray<ArmTrend>): ArmOutput => ({
  cutoff,
  run_id: `run_${cutoff.slice(0, 10)}`,
  status: "ok",
  logical_hash: "sha256:l",
  members_hash: "sha256:m",
  config_hash: "sha256:c",
  profile_hash: "sha256:p",
  eligible: top.length,
  top,
  duration_ms: 0,
});
const handResult = (
  reference: ReadonlyArray<ArmOutput>,
  candidate: ReadonlyArray<ArmOutput>,
): WorkerResult =>
  ({
    token: "job-gate-hand",
    views: reference.map((arm) => ({
      cutoff: arm.cutoff,
      corpus_hash: "sha256:v",
      files: 1,
      observed_at: new Date(Date.parse(arm.cutoff) + 3_600_000).toISOString(),
    })),
    arms: { reference, candidate },
  }) as unknown as WorkerResult;
const handSeen = (result: WorkerResult) => ({
  views: result.views,
  startedAt: "2026-12-10T00:00:00.000Z",
});

describe("promotion gate: enough independent families (Sol, B2)", () => {
  it("is inconclusive when every card falls in one family, whatever the labels say", () => {
    // Sol's case: five topics a day, none overlapping within the day, chained across days.
    const candidate = DAYS.map((cutoff, d) =>
      armOf(
        cutoff,
        Array.from({ length: 5 }, (_, i) => {
          const a = (2 * i + (d % 2)) % 10;
          return trendOf(i + 1, `t${d}-${i}`, [`x${a}`, `x${(a + 1) % 10}`]);
        }),
      ),
    );
    const reference = DAYS.map((cutoff) => armOf(cutoff, []));
    const result = handResult(reference, candidate);
    const { cards, members } = shadowCards(result);
    const labels = cards.map((card) => ({
      card_id: card.card_id,
      label: "yes" as const,
      grade: "core" as const,
    }));
    const gate = evaluateGate({
      result,
      members,
      labels,
      frozenDay: "2026-12-01",
      observed: handSeen(result),
    });
    expect(gate.families).toBe(1);
    expect(gate.verdict).toBe("inconclusive");
    expect(gate.reasons.join(" ")).toContain("distinct topic families");
  });

  it("bounds the advantage in [-1, 1] with families of unequal size, and flags a degenerate resample", () => {
    // One topic every day (a family of seven positions) and four new topics a day.
    const candidate = DAYS.map((cutoff, d) =>
      armOf(cutoff, [
        trendOf(1, `big-${d}`, ["b1", "b2", "b3"]),
        ...Array.from({ length: 4 }, (_, i) => trendOf(i + 2, `u${d}-${i}`, [`u${d}-${i}`])),
      ]),
    );
    const reference = DAYS.map((cutoff) => armOf(cutoff, []));
    const result = handResult(reference, candidate);
    const { cards, members } = shadowCards(result);
    const memberOf = new Map(members.map((m) => [m.card_id, m]));
    // The big topic is core; of the others, those whose index is even.
    const labels = cards.map((card) => {
      const id = memberOf.get(card.card_id)!.trend_ids[0]!;
      const core = id.startsWith("big") || Number(id.at(-1)) % 2 === 0;
      return {
        card_id: card.card_id,
        label: core ? ("yes" as const) : ("no" as const),
        grade: core ? ("core" as const) : null,
      };
    });
    const gate = evaluateGate({
      result,
      members,
      labels,
      frozenDay: "2026-12-01",
      observed: handSeen(result),
    });
    expect(gate.families).toBe(29);
    // The estimand on the full sample: (7 + 14) core positions of 35, minus an empty reference.
    expect(gate.g5_advantage.mean).toBe(0.6);
    expect(gate.candidate.g5 - gate.reference.g5).toBeCloseTo(gate.g5_advantage.mean, 4);
    expect(gate.g5_advantage.ci_upper).toBeLessThanOrEqual(1);
    expect(gate.g5_advantage.ci_lower).toBeGreaterThanOrEqual(-1);
    expect(gate.g5_advantage.ci_lower).toBeLessThan(gate.g5_advantage.ci_upper);
    expect(gate.reasons.join(" ")).not.toContain("degenerate");

    // Every position core: every replicate is 1, which says nothing about uncertainty.
    const allCore = cards.map((card) => ({
      card_id: card.card_id,
      label: "yes" as const,
      grade: "core" as const,
    }));
    const flat = evaluateGate({
      result,
      members,
      labels: allCore,
      frozenDay: "2026-12-01",
      observed: handSeen(result),
    });
    expect(flat.g5_advantage).toEqual({ mean: 1, ci_lower: 1, ci_upper: 1 });
    expect(flat.verdict).toBe("inconclusive");
    expect(flat.reasons.join(" ")).toContain("degenerate");
  });
});
