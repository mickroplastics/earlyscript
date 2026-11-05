// @effect-diagnostics nodeBuiltinImport:off - the gate is computed over real engine outputs of a synthetic corpus.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { evaluateGate, shadowCards } from "./gate.ts";
import { labelSyntheticCards } from "./synthetic.ts";
import { jobSpec, labFixture, weightCandidate } from "./testkit.ts";
import { evaluateJob } from "./worker.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "engine-lab-gate-"));
afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
const fixture = labFixture(NodePath.join(root, "fixture"), { days: 26 });
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
    const frozenDay = "2026-12-01";
    const gate = evaluateGate({ result, members, labels, frozenDay });
    expect(gate.verdict, gate.reasons.join(" ")).toBe("pass");
    expect(gate.g5_advantage.ci_lower).toBeGreaterThan(0);

    const missing = evaluateGate({ result, members, labels: labels.slice(1), frozenDay });
    expect(missing.verdict).toBe("inconclusive");
    const early = evaluateGate({ result, members, labels, frozenDay: cutoffs[3]!.slice(0, 10) });
    expect(early.verdict).toBe("inconclusive");
    const ungraded = evaluateGate({
      result,
      members,
      labels: labels.map((l) => ({ ...l, grade: null })),
      frozenDay,
    });
    expect(ungraded.verdict).toBe("inconclusive");
  });

  it("is inconclusive with fewer than 7 cutoffs and fails a clearly worse candidate", async () => {
    const few = await shadow(
      "job-gate-few",
      { growth: 0.1, log_authors_7d: 0.9 },
      fixture.cutoffs.slice(0, 3),
    );
    expect(
      evaluateGate({ ...few, labels: labelSyntheticCards(few.cards), frozenDay: "2026-12-01" })
        .verdict,
    ).toBe("inconclusive");
    const worse = await shadow(
      "job-gate-worse",
      { growth: 2, log_authors_7d: 0 },
      fixture.cutoffs.slice(0, 7),
    );
    const gate = evaluateGate({
      ...worse,
      labels: labelSyntheticCards(worse.cards),
      frozenDay: "2026-12-01",
    });
    expect(gate.verdict).not.toBe("pass");
    expect(gate.g5_advantage.mean).toBeLessThan(0);
  });
});
