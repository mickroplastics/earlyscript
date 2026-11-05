// @effect-diagnostics nodeBuiltinImport:off - tests write temporary caches.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Dossier } from "@earlyscript/editorial-contracts/dossier";

import { sha256 } from "../hash.ts";
import { tempDir } from "../testkit/syntheticCorpus.ts";
import { agreement, readOperatorLabels, splitCalibration } from "./calibration-agreement.ts";
import { AI_TERMS, pickCalibration } from "./calibration-items.ts";
import { topicKey, topicText } from "./dev-compare.ts";
import { trainingFamilies } from "./training-families.ts";
import { type CliRunner, judgeEntries, loadJudge } from "./judge.ts";
import { auc, choleskySolve, fitLogistic, predict } from "./logistic.ts";
import { dayFolds } from "./relevance-train.ts";
import type { SampleRow } from "./relevance-sample.ts";

/** Labels "yes" when the text mentions an agent; drops `drop` ids on the first call. */
function fakeCli(calls: Array<string>, drop: ReadonlyArray<string> = []): CliRunner {
  return async ({ prompt, system }) => {
    calls.push(prompt);
    expect(system).toContain("Would SingulariDev make a video");
    const entries = JSON.parse(prompt.slice(prompt.indexOf("["))) as Array<{
      id: string;
      text: string;
    }>;
    const first = calls.length === 1;
    const results = entries
      .filter((e) => !(first && drop.includes(e.id)))
      .map((e) => ({
        id: e.id,
        label: /agent/i.test(e.text) ? "yes" : "no",
        reason: "test",
      }));
    return JSON.stringify({ structured_output: { results }, usage: { input_tokens: 1 } });
  };
}

describe("editorial judge", () => {
  it("uses the frozen rubric and refuses one that changed", () => {
    const judge = loadJudge();
    expect(judge.config.model).toBe("claude-sonnet-5-5");
    const dir = tempDir("judge-config");
    NodeFS.writeFileSync(NodePath.join(dir, "judge.json"), JSON.stringify(judge.config));
    NodeFS.writeFileSync(NodePath.join(dir, judge.config.rubric), `${judge.rubric}\nedited`);
    expect(() => loadJudge(NodePath.join(dir, "judge.json"))).toThrow(/rubric_sha256/);
  });

  it("labels in batches with positional ids, caches by text and retries an incomplete reply", async () => {
    const judge = loadJudge();
    const small = { ...judge, config: { ...judge.config, batch_size: 2 } };
    const cacheDir = tempDir("judge-cache");
    const entries = [
      { id: "itm_hn_1", text: "Coding agent reviews pull requests" },
      { id: "itm_hn_2", text: "Tomato garden" },
      { id: "itm_gh_3", text: "Coding agent reviews pull requests" },
      { id: "itm_hn_4", text: "Football scores" },
    ];
    const calls: Array<string> = [];
    const { labels, stats } = await judgeEntries(entries, {
      judge: small,
      cacheDir,
      concurrency: 1,
      cli: fakeCli(calls, ["e2"]),
    });
    expect(labels.map((l) => l.label)).toEqual(["yes", "no", "yes", "no"]);
    expect(labels[0]!.key).toBe(labels[2]!.key);
    // Three distinct texts: two batches, one retried.
    expect(stats).toEqual({ entries: 4, cached: 0, calls: 3, retries: 1 });
    expect(calls.every((p) => !p.includes("itm_"))).toBe(true);
    expect(NodeFS.readdirSync(NodePath.join(cacheDir, "calls")).length).toBe(2);
    const again = await judgeEntries(entries, { judge: small, cacheDir, cli: fakeCli([]) });
    expect(again.stats.cached).toBe(3);
    expect(again.stats.calls).toBe(0);
    expect(again.labels).toEqual(labels);
  });
});

describe("logistic probe", () => {
  // Two noisy clusters in 6 dimensions, generated from a hash so the test is fixed.
  const rows: Array<Float32Array> = [];
  const labels: Array<number> = [];
  for (let k = 0; k < 200; k++) {
    const y = k % 2;
    const h = sha256(`row${k}`);
    const v = new Float32Array(6);
    for (let i = 0; i < 6; i++)
      v[i] = (parseInt(h.slice(7 + 2 * i, 9 + 2 * i), 16) / 255 - 0.5) * 1.5;
    v[0]! += y === 1 ? 1 : -1;
    rows.push(v);
    labels.push(y);
  }

  it("is deterministic, separates the clusters and reaches a stationary point", () => {
    const a = fitLogistic(rows, labels, 1);
    const b = fitLogistic(rows, labels, 1);
    expect([...a.weights]).toEqual([...b.weights]);
    expect(a.bias).toBe(b.bias);
    const probs = rows.map((r) => predict(a, r));
    expect(auc(probs, labels)!).toBeGreaterThan(0.85);
    const grad = new Float64Array(6);
    rows.forEach((r, k) => {
      const g = probs[k]! - labels[k]!;
      for (let i = 0; i < 6; i++) grad[i]! += g * r[i]!;
    });
    for (let i = 0; i < 6; i++) expect(Math.abs(grad[i]! + a.weights[i]!)).toBeLessThan(1e-8);
  });

  it("solves a positive definite system and computes AUC with ties", () => {
    const x = choleskySolve(Float64Array.from([4, 2, 2, 3]), Float64Array.from([2, 1]), 2);
    expect(x[0]).toBeCloseTo(0.5, 12);
    expect(x[1]).toBeCloseTo(0, 12);
    expect(auc([0.1, 0.4, 0.4, 0.9], [0, 0, 1, 1])).toBe(0.875);
    expect(auc([0.1, 0.2], [1, 1])).toBeNull();
  });

  it("splits folds by whole days in order", () => {
    const days = ["d1", "d1", "d2", "d3", "d3", "d3", "d4", "d5"];
    const folds = dayFolds(days, 3);
    expect(folds).toEqual([0, 0, 0, 1, 1, 1, 2, 2]);
  });
});

describe("calibration cards", () => {
  const row = (id: string, source: SampleRow["source"], title: string): SampleRow => ({
    id,
    source,
    day: "2026-10-05",
    published_at: "2026-10-05T00:00:00.000Z",
    permalink: `https://example.test/${id}`,
    title,
    excerpt: "",
    judge_text: title,
    embed_text: title,
  });
  it("takes judge-yes items, AI headlines the judge rejected and other negatives", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, k) => row(`hy${k}`, "hn", `Claude Code tip ${k}`)),
      ...Array.from({ length: 10 }, (_, k) => row(`hh${k}`, "hn", `OpenAI valuation news ${k}`)),
      ...Array.from({ length: 10 }, (_, k) => row(`hp${k}`, "hn", `Tomato garden ${k}`)),
    ];
    const labelOf = new Map(rows.map((r) => [r.id, r.id.startsWith("hy") ? "yes" : "no"]));
    const picked = pickCalibration(rows, labelOf);
    const count = (stratum: string) => picked.filter((p) => p.stratum === stratum).length;
    expect(count("hn:yes")).toBe(5);
    expect(count("hn:hard_negative")).toBe(4);
    expect(count("hn:no")).toBe(5);
    expect(
      picked
        .filter((p) => p.stratum === "hn:hard_negative")
        .every((p) => AI_TERMS.test(p.row.title)),
    ).toBe(true);
    expect(new Set(picked.map((p) => p.row.id)).size).toBe(picked.length);
  });
});

describe("calibration agreement", () => {
  const pair = (operator: string, judge: string) => ({ operator, judge, stratum: "item" });

  it("measures agreement and kappa among resolved cards and with doubts as no", () => {
    const result = agreement([
      ...Array.from({ length: 8 }, () => pair("yes", "core")),
      ...Array.from({ length: 8 }, () => pair("no", "no")),
      pair("yes", "no"),
      pair("no", "adjacent"),
      pair("unsure", "core"),
    ]);
    expect(result.resolved).toBe(18);
    expect(result.operator_unsure).toBe(1);
    expect(result.resolved_agreement).toBeCloseTo(16 / 18, 12);
    // Both sides say yes half the time: kappa = (po - 0.5) / 0.5.
    expect(result.resolved_kappa).toBeCloseTo((16 / 18 - 0.5) / 0.5, 12);
    expect(result.doubts_as_no_agreement).toBeCloseTo(16 / 19, 12);
    expect(result.accepted).toBe(true);
  });

  it("does not accept a judge on a few resolved cards or with cards missing (Sol U2-B2)", () => {
    const fewResolved = agreement([
      pair("yes", "core"),
      pair("no", "no"),
      ...Array.from({ length: 38 }, () => pair("yes", "unsure")),
    ]);
    expect(fewResolved.resolved_agreement).toBe(1);
    expect(fewResolved.judge_resolved_share).toBeCloseTo(2 / 40, 12);
    expect(fewResolved.accepted).toBe(false);
    const complete = Array.from({ length: 10 }, (_, k) =>
      pair(k % 2 ? "yes" : "no", k % 2 ? "core" : "no"),
    );
    expect(agreement(complete).accepted).toBe(true);
    expect(agreement(complete, 40).missing).toBe(30);
    expect(agreement(complete, 40).accepted).toBe(false);
  });

  it("does not accept a calibration the operator barely resolved (Sol motor-v2 S1)", () => {
    // Two resolved, agreeing cards and 38 operator doubts: perfect agreement, insufficient.
    const doubts = agreement([
      pair("yes", "core"),
      pair("no", "no"),
      ...Array.from({ length: 38 }, () => pair("unsure", "core")),
    ]);
    expect(doubts.resolved_agreement).toBe(1);
    expect(doubts.resolved_kappa).toBe(1);
    expect(doubts.operator_resolved_share).toBeCloseTo(2 / 40, 12);
    expect(doubts.accepted).toBe(false);
    expect(doubts.reason).toMatch(/^insuficiente/);
  });

  it("reads the labelling page export and checks it was made for these cards (Sol U2-B1)", () => {
    const cards = new TextEncoder().encode('{"unit":"item","card_id":"itemcal-01"}\n');
    const exported = (cardsHash: string) =>
      JSON.stringify(
        {
          schema_version: "earlyscript.editorial-labels/1",
          labeler: "miguel",
          set_name: "calibracion-100",
          cards_hash: cardsHash,
          universe_hash: null,
          exported_at: "2026-11-05T03:58:56.562Z",
          cards: 1,
          labels: [
            { card_id: "itemcal-01", unit: "item", label: "unsure", labeled_at: "t1" },
            { card_id: "itemcal-01", unit: "item", label: "yes", labeled_at: "t2" },
          ],
        },
        null,
        2,
      );
    expect(readOperatorLabels(exported(sha256(cards)), cards)).toEqual([
      { card_id: "itemcal-01", unit: "item", label: "yes", labeled_at: "t2" },
    ]);
    expect(() => readOperatorLabels(exported("sha256:other"), cards)).toThrow(/cards_hash/);
    expect(() => readOperatorLabels('{"labels":[]}', cards)).toThrow(/editorial-labels/);
  });

  it("splits every unit and label stratum in half with a fixed order", () => {
    const labels = [
      ...Array.from({ length: 6 }, (_, k) => ({
        card_id: `t${k}`,
        unit: "topic" as const,
        label: "yes",
      })),
      ...Array.from({ length: 4 }, (_, k) => ({
        card_id: `n${k}`,
        unit: "topic" as const,
        label: "no",
      })),
      ...Array.from({ length: 4 }, (_, k) => ({
        card_id: `i${k}`,
        unit: "item" as const,
        label: "yes",
      })),
    ];
    const split = splitCalibration(labels, { topic: 5, item: 2 });
    expect(split).toEqual(splitCalibration(labels, { topic: 5, item: 2 }));
    expect(split.revision.length).toBe(7);
    expect(split.revision.filter((id) => id.startsWith("t")).length).toBe(3);
    expect(split.revision.filter((id) => id.startsWith("n")).length).toBe(2);
    expect(new Set([...split.revision, ...split.validation]).size).toBe(labels.length);
  });
});

describe("development topic card", () => {
  it("shows the terms and the five most recent evidence headlines", () => {
    const evidence = Array.from({ length: 7 }, (_, k) => ({
      item_id: `i${k}`,
      title: `headline ${k}`,
      published_at: `2026-10-${String(10 + k).padStart(2, "0")}T00:00:00.000Z`,
    }));
    const text = topicText({
      trend: { top_terms: ["agents", "coding"] },
      evidence,
    } as unknown as Dossier);
    expect(text).toBe(
      "Topic key terms: agents, coding\nRecent headlines:\n- headline 6\n- headline 5\n- headline 4\n- headline 3\n- headline 2",
    );
  });
});

describe("development judgments", () => {
  it("share a judgment only between identical cards of the same cut and signal (Sol U2-S3)", () => {
    const dossier = (titles: Array<string>) =>
      ({
        trend: { id: "sig_a", top_terms: ["agents"] },
        evidence: titles.map((title, k) => ({
          item_id: `i${k}`,
          title,
          published_at: `2026-10-1${k}T00:00:00.000Z`,
        })),
      }) as unknown as Dossier;
    const a = dossier(["one", "two"]);
    expect(topicKey("2026-10-20", a)).toBe(topicKey("2026-10-20", dossier(["one", "two"])));
    expect(topicKey("2026-10-20", a)).not.toBe(topicKey("2026-10-20", dossier(["one", "three"])));
    expect(topicKey("2026-10-20", a)).not.toBe(topicKey("2026-10-21", a));
  });
});

describe("training families", () => {
  it("lists the signals with a training item, with their centroid (Sol U2-S2)", () => {
    const signal = (id: string, itemIds: Array<string>) => ({
      id,
      itemIds,
      firstMs: Date.parse("2026-10-02T00:00:00Z"),
      lastMs: 0,
      sum: new Float32Array(2),
      centroid: Float32Array.from([0.6, 0.8]),
    });
    const item = (id: string, title: string) => [id, { title, cleanBody: "" }] as const;
    const items = new Map([
      item("a1", "agent harness"),
      item("a2", "agent harness tips"),
      item("b1", "tomato"),
    ]) as unknown as Parameters<typeof trainingFamilies>[1];
    const families = trainingFamilies(
      [signal("sig_b", ["b1"]), signal("sig_a", ["a1", "a2"])],
      items,
      new Set(["a2"]),
    );
    expect(families.map((f) => [f.signal_id, f.training_items, f.items_total])).toEqual([
      ["sig_a", ["a2"], 2],
    ]);
    expect(families[0]!.terms).toEqual(["agent", "harness"]);
    const back = new Float32Array(
      Uint8Array.from(Buffer.from(families[0]!.centroid, "base64")).buffer,
    );
    expect([...back].map((x) => Math.round(x * 10) / 10)).toEqual([0.6, 0.8]);
  });
});
