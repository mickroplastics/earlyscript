// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - tests write temporary corpora and read reports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Item } from "@earlyscript/editorial-contracts/item";
import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { checkBacktest, parseCutoffList, runBacktest } from "./backtest.ts";
import { crossingLabel, labelCandidates, precisionAt, type Story } from "./backtest-label.ts";
import { checkBacktestReport, decideVerdict } from "./backtest-report.ts";
import { daysBetween } from "./days.ts";
import { fingerprintEmbedder } from "./embed/fingerprint.ts";
import {
  item,
  syntheticItems,
  tempDir,
  testConfig,
  writeProfile,
  writeSyntheticCorpus,
} from "./testkit/syntheticCorpus.ts";

const CUTOFFS = ["2026-10-08", "2026-10-09"];
const unit = (values: ReadonlyArray<number>) => {
  const v = Float32Array.from(values);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

/** npm items from 2026-10-03: either the growing Rust topic or a topic HN never follows. */
function npmItems(topic: "rust" | "offtopic"): Array<Item> {
  const title =
    topic === "rust"
      ? "Rust compiler agents incremental builds package"
      : "developer tooling package manager release lockfile";
  return daysBetween("2026-10-03", "2026-10-12").flatMap((day, d) =>
    [0, 1, 2].map((k) => item("npm", day, 30 + k, title, `maintainer${d}_${k}`)),
  );
}

async function setup(extra: Array<Item>, extraSources: ReadonlyArray<SourceId> = ["npm"]) {
  const root = tempDir("trend-backtest");
  const corpusDir = NodePath.join(root, "corpus");
  await writeSyntheticCorpus(corpusDir, { items: [...syntheticItems(), ...extra], extraSources });
  return { root, corpusDir, profilePath: writeProfile(root) };
}

const backtest = (s: Awaited<ReturnType<typeof setup>>, out: string) =>
  runBacktest({
    corpusDir: s.corpusDir,
    profilePath: s.profilePath,
    outDir: NodePath.join(s.root, out),
    cutoffs: CUTOFFS,
    baselineSources: ["hn", "github"],
    candidateSources: ["hn", "github", "npm"],
    config: testConfig(),
    embedder: fingerprintEmbedder(),
  });

describe("Earlywindow's retrospective label", () => {
  const cutoffMs = Date.parse("2026-10-10T00:00:00Z");
  const story = (id: string, day: string, author: string | null, vector = unit([1, 0])) => ({
    id,
    publishedMs: Date.parse(`${day}T12:00:00Z`),
    author,
    vector,
  });

  it("is positive on the first day the tail reaches 5 stories from 2 authors", () => {
    const tail: Array<Story> = [
      story("a", "2026-10-10", "x"),
      story("b", "2026-10-10", "x"),
      story("c", "2026-10-11", "x"),
      story("d", "2026-10-12", "y"),
      story("e", "2026-10-12", "y"),
      story("f", "2026-10-12", "y"),
    ];
    // The fifth story arrives on the 12th, but the label waits for the end of that day.
    expect(crossingLabel(tail, cutoffMs, 5, 2)).toEqual({
      positive: true,
      event_day: "2026-10-12",
      lead_days: 2,
      followup_stories: 6,
      followup_authors: 2,
    });
    // One author never crosses, however many stories.
    expect(crossingLabel(tail.slice(0, 3), cutoffMs, 3, 2).positive).toBe(false);
  });

  it("gives each follow-up story to one candidate above the threshold, before the window ends", () => {
    const near = unit([1, 0.1]);
    const stories = [
      ...[0, 1, 2, 3, 4].map((k) => story(`s${k}`, "2026-10-11", `a${k}`, near)),
      // Below the threshold for both, and outside the 14-day window.
      story("far", "2026-10-11", "z", unit([0, 1])),
      story("late", "2026-10-24", "w", near),
    ];
    const labels = labelCandidates(
      [
        { id: "sig_b", centroid: unit([1, 0]) },
        { id: "sig_a", centroid: unit([1, 0]) },
      ],
      stories,
      cutoffMs,
      0.7,
    );
    // Tied cosines go to the smaller id; the other candidate gets nothing.
    expect(labels.get("sig_a")).toMatchObject({
      positive: true,
      lead_days: 1,
      followup_stories: 5,
    });
    expect(labels.get("sig_b")).toMatchObject({ positive: false, followup_stories: 0 });
  });

  it("divides by min(k, candidates) and reads cutoff ranges inclusively", () => {
    expect(precisionAt([true, false, true], 5)).toBeCloseTo(2 / 3);
    expect(precisionAt([], 5)).toBeNull();
    expect(parseCutoffList("2026-10-29..2026-10-31,2026-11-02")).toEqual([
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-02",
    ]);
  });
});

describe("decideVerdict", () => {
  const arm = (p: number | null, lead: number | null) => ({
    mean_p_at_5: p,
    median_lead_days: lead,
  });
  it("tolerates a P@5 drop of 0.02 and no shorter lead", () => {
    expect(decideVerdict({ baseline: arm(1, 1), candidate: arm(0.98, 1) }).verdict).toBe(
      "not-worse",
    );
    expect(decideVerdict({ baseline: arm(1, 1), candidate: arm(0.97, 2) }).verdict).toBe("worse");
    expect(decideVerdict({ baseline: arm(0.9, 2), candidate: arm(1, 1) }).verdict).toBe("worse");
    expect(decideVerdict({ baseline: arm(1, 1), candidate: arm(null, null) }).verdict).toBe(
      "worse",
    );
    expect(decideVerdict({ baseline: arm(null, null), candidate: arm(null, null) }).verdict).toBe(
      "not-worse",
    );
  });
});

describe("runBacktest", () => {
  it("is not worse when the candidate source follows a trend the baseline already confirms", async () => {
    const s = await setup(npmItems("rust"));
    const result = await backtest(s, "bt");
    const logical = result.report["logical"] as {
      cutoffs: Array<{
        followup_days_in_corpus: number;
        paired: boolean;
        baseline: { rows: Array<{ positive: boolean; lead_days: number | null }> };
        candidate: { centroid_checks: number };
      }>;
      inputs: { truth_sources: Array<string> };
    };
    expect(logical.inputs.truth_sources).toEqual(["hn", "github"]);
    expect(logical.cutoffs.map((c) => c.followup_days_in_corpus)).toEqual([4, 3]);
    expect(logical.cutoffs.every((c) => c.paired)).toBe(true);
    // The Rust topic keeps three HN stories a day after the cutoff: positive on the next day.
    const rust = logical.cutoffs[0]!.baseline.rows.find((row) => row.positive);
    expect(rust?.lead_days).toBe(1);
    expect(logical.cutoffs[0]!.candidate.centroid_checks).toBeGreaterThan(0);
    expect(result.total.baseline.mean_p_at_5).toBe(1);
    expect(result.total.candidate.mean_p_at_5).toBe(1);
    expect(result.verdict.verdict).toBe("not-worse");

    const written = JSON.parse(NodeFS.readFileSync(result.path, "utf8"));
    expect(checkBacktestReport(written).ok).toBe(true);
    // Every run of both arms is kept next to the report.
    for (const run of written.runs) expect(NodeFS.existsSync(run.run_dir)).toBe(true);
    expect(written.runs).toHaveLength(4);
  });

  it("is worse when the candidate source brings trends the truth sources never follow", async () => {
    const s = await setup(npmItems("offtopic"));
    const result = await backtest(s, "bt");
    expect(result.total.baseline.mean_p_at_5).toBe(1);
    expect(result.total.candidate.mean_p_at_5).toBeLessThan(0.98);
    expect(result.verdict.verdict).toBe("worse");
    expect(result.verdict.reasons.join(" ")).toMatch(/P@5 drops/);
  });

  it("reproduces its logical hash, reruns to the same hash and refuses a tampered report", async () => {
    const s = await setup(npmItems("rust"));
    const first = await backtest(s, "first");
    const second = await backtest(s, "second");
    expect(second.report.logical_hash).toBe(first.report.logical_hash);
    expect(second.report.backtest_id).toBe(first.report.backtest_id);

    const rerun = await checkBacktest(first.path, {
      outDir: NodePath.join(s.root, "rerun"),
      options: { embedder: fingerprintEmbedder() },
    });
    expect(rerun.ok).toBe(true);
    expect(rerun.rerun?.logical_hash).toBe(first.report.logical_hash);

    const tampered = JSON.parse(NodeFS.readFileSync(first.path, "utf8"));
    tampered.logical.total.candidate.mean_p_at_5 = 0.5;
    const file = NodePath.join(s.root, "tampered.json");
    NodeFS.writeFileSync(file, JSON.stringify(tampered));
    const checked = await checkBacktest(file);
    expect(checked.ok).toBe(false);
    expect(checked.problems).toContain("logical_hash does not recompute");
  });
});
