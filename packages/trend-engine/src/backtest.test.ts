// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - tests write temporary corpora and read reports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Item } from "@earlyscript/editorial-contracts/item";
import type { SourceId } from "@earlyscript/editorial-contracts/source";

import { checkBacktest, parseCutoffList, runBacktest, runBacktestMatrix } from "./backtest.ts";
import { crossingLabel, labelCandidates, precisionAt, type Story } from "./backtest-label.ts";
import { checkBacktestReport, decideVerdict } from "./backtest-report.ts";
import { daysBetween } from "./days.ts";
import { fingerprintEmbedder } from "./embed/fingerprint.ts";
import {
  item,
  tempDir,
  testConfig,
  writeProfile,
  writeSyntheticCorpus,
} from "./testkit/syntheticCorpus.ts";

const FROM = "2026-09-01";
const TO = "2026-10-12";
/** Seven cutoffs whose 14 follow-up days all fall before TO. */
const COMPLETE_CUTOFFS = "2026-09-22..2026-09-28";
const unit = (values: ReadonlyArray<number>) => {
  const v = Float32Array.from(values);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
};

/** Items of a topic that grows about 2.5 times a week from 2026-09-15, one author each. */
function growing(source: SourceId, title: string, slot: number): Array<Item> {
  return daysBetween(FROM, TO).flatMap((day, d) => {
    const count = d < 14 ? (d % 4 === 0 ? 1 : 0) : Math.round(2.5 ** ((d - 14) / 7));
    return Array.from({ length: count }, (_, k) =>
      item(source, day, slot + k, title, `${source}${slot}_${d}_${k}`),
    );
  });
}

/** HN: the growing Rust topic and two steady ones. */
function hnItems(): Array<Item> {
  return [
    ...growing("hn", "Rust compiler agents ship incremental builds", 1),
    ...daysBetween(FROM, TO).flatMap((day, d) => [
      item("hn", day, 60, "Tomato garden soil watering tips", `gardener${d % 4}`),
      item("hn", day, 61, "Football league scores weekend results", `fan${d % 3}`),
    ]),
  ];
}

/** npm: either the Rust topic HN follows, or a topic HN never follows. */
const npmItems = (topic: "rust" | "offtopic") =>
  growing(
    "npm",
    topic === "rust"
      ? "Rust compiler agents incremental builds package"
      : "developer tooling package manager release lockfile",
    30,
  );

async function setup(extra: Array<Item>) {
  const root = tempDir("trend-backtest");
  const corpusDir = NodePath.join(root, "corpus");
  await writeSyntheticCorpus(corpusDir, {
    items: [...hnItems(), ...extra].toSorted(
      (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
    ),
    extraSources: ["npm"],
    fromDay: FROM,
    toDay: TO,
  });
  return { root, corpusDir, profilePath: writeProfile(root) };
}

const backtest = (s: Awaited<ReturnType<typeof setup>>, out: string, cutoffs: string) =>
  runBacktest({
    corpusDir: s.corpusDir,
    profilePath: s.profilePath,
    outDir: NodePath.join(s.root, out),
    cutoffs: parseCutoffList(cutoffs),
    baselineSources: ["hn", "github"],
    candidateSources: ["hn", "github", "npm"],
    truthSources: ["hn"],
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

it("reuses baseline runs across a matrix without changing independent backtest results", async () => {
  const s = await setup(npmItems("rust"));
  const common = {
    corpusDir: s.corpusDir,
    profilePath: s.profilePath,
    cutoffs: parseCutoffList("2026-09-27,2026-09-28"),
    baselineSources: ["hn"] satisfies Array<SourceId>,
    config: testConfig(),
  };
  const candidateSourceSets: Array<Array<SourceId>> = [
    ["hn", "github", "npm"],
    ["hn", "github"],
  ];
  const supplied = fingerprintEmbedder();
  let disposed = 0;
  const results = await runBacktestMatrix({
    ...common,
    candidateSourceSets,
    outDir: NodePath.join(s.root, "matrix"),
    embedder: {
      ...supplied,
      dispose: async () => {
        disposed++;
      },
    },
  });
  expect(disposed).toBe(1);
  const baselineIds: Array<Array<string>> = [];
  for (const [index, result] of results.entries()) {
    const independent = await runBacktest({
      ...common,
      candidateSources: candidateSourceSets[index]!,
      outDir: NodePath.join(s.root, `independent-${index}`),
      embedder: fingerprintEmbedder(),
    });
    expect(result.report.logical_hash).toBe(independent.report.logical_hash);
    expect(checkBacktestReport(result.report).ok).toBe(true);
    const report = JSON.parse(NodeFS.readFileSync(result.path, "utf8"));
    baselineIds.push(
      report.runs
        .filter((run: { arm: string }) => run.arm === "baseline")
        .map((run: { run_id: string }) => run.run_id),
    );
  }
  expect(baselineIds[1]).toEqual(baselineIds[0]);
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
  it("decides on complete cutoffs: not worse when the source follows a trend HN confirms", async () => {
    const s = await setup(npmItems("rust"));
    const result = await backtest(s, "bt", COMPLETE_CUTOFFS);
    const logical = result.report["logical"] as {
      status: string;
      cutoffs: Array<{
        followup_days: number;
        complete: boolean;
        baseline: {
          centroid_checks: number;
          rows: Array<{ positive: boolean; lead_days: number | null }>;
        };
      }>;
      inputs: { truth_sources: Array<string> };
    };
    expect(logical.inputs.truth_sources).toEqual(["hn"]);
    expect(logical.cutoffs.map((c) => [c.followup_days, c.complete])).toEqual(
      Array.from({ length: 7 }, () => [14, true]),
    );
    expect(logical.cutoffs[0]!.baseline.rows.some((row) => row.positive)).toBe(true);
    // The frozen centroids reproduce the similarities the runs stored for HN evidence.
    expect(logical.cutoffs[0]!.baseline.centroid_checks).toBeGreaterThan(0);
    expect(result.total.complete.cutoffs).toBe(7);
    expect(result.total.partial.cutoffs).toBe(0);
    expect(result.status).toBe("final");
    expect(result.total.complete.baseline.mean_p_at_5).toBe(1);
    expect(result.total.complete.candidate.mean_p_at_5).toBe(1);
    expect(result.verdict.verdict).toBe("not-worse");

    const written = JSON.parse(NodeFS.readFileSync(result.path, "utf8"));
    expect(checkBacktestReport(written).ok).toBe(true);
    for (const run of written.runs) expect(NodeFS.existsSync(run.run_dir)).toBe(true);
    expect(written.runs).toHaveLength(14);
  });

  it("is worse when the candidate source brings trends the truth sources never follow", async () => {
    const s = await setup(npmItems("offtopic"));
    const result = await backtest(s, "bt", COMPLETE_CUTOFFS);
    expect(result.total.complete.baseline.mean_p_at_5).toBe(1);
    expect(result.total.complete.candidate.mean_p_at_5).toBeLessThan(0.98);
    expect(result.verdict.verdict).toBe("worse");
    expect(result.verdict.reasons.join(" ")).toMatch(/P@5 drops/);
  });

  it("keeps cutoffs with a truncated follow-up out of the verdict and marks the report provisional", async () => {
    const s = await setup(npmItems("rust"));
    // 2026-10-05 sees 7 of its 14 follow-up days before the corpus ends.
    const mixed = await backtest(s, "mixed", "2026-09-27,2026-10-05");
    const rows = (mixed.report["logical"] as { cutoffs: Array<{ followup_days: number }> }).cutoffs;
    expect(rows.map((row) => row.followup_days)).toEqual([14, 7]);
    expect(mixed.total.complete.cutoffs).toBe(1);
    expect(mixed.total.partial.cutoffs).toBe(1);
    expect(mixed.status).toBe("provisional");
    expect(mixed.verdict.verdict).toBe("not-worse");

    // Without a complete cutoff nothing shows the source is not worse.
    const partial = await backtest(s, "partial", "2026-10-05,2026-10-08");
    expect(partial.total.complete.cutoffs).toBe(0);
    expect(partial.status).toBe("provisional");
    expect(partial.verdict).toMatchObject({
      verdict: "worse",
      reasons: ["no cutoff with a complete follow-up"],
    });
  });

  it("does not treat a partial truth capture as a fully observed follow-up day", async () => {
    const s = await setup(npmItems("rust"));
    await writeSyntheticCorpus(s.corpusDir, {
      items: [...hnItems(), ...npmItems("rust")].toSorted(
        (a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id),
      ),
      extraSources: ["npm"],
      fromDay: FROM,
      toDay: TO,
      coverage: (row) =>
        row.source === "hn" && row.day === "2026-09-30"
          ? { ...row, status: "partial", note: "HN window incomplete" }
          : row,
    });
    const result = await runBacktest({
      corpusDir: s.corpusDir,
      profilePath: s.profilePath,
      outDir: NodePath.join(s.root, "partial-truth"),
      cutoffs: ["2026-09-27"],
      baselineSources: ["hn"],
      candidateSources: ["hn", "npm"],
      truthSources: ["hn"],
      config: testConfig(),
      embedder: fingerprintEmbedder(),
    });
    expect(result.total.complete.cutoffs).toBe(0);
    expect(result.total.partial.cutoffs).toBe(1);
    expect(result.status).toBe("provisional");
  });

  it("counts a complete cutoff where the candidate stops emitting instead of hiding it", async () => {
    const s = await setup(npmItems("rust").filter((record) => record.published_at < "2026-09-21"));
    const result = await runBacktest({
      corpusDir: s.corpusDir,
      profilePath: s.profilePath,
      outDir: NodePath.join(s.root, "lost-emission"),
      cutoffs: ["2026-09-21", "2026-09-28"],
      baselineSources: ["hn"],
      candidateSources: ["npm"],
      truthSources: ["hn"],
      config: testConfig(),
      embedder: fingerprintEmbedder(),
    });
    expect(result.total.complete.cutoffs).toBe(1);
    expect(result.total.complete.emission_regressions).toBe(1);
    expect(result.verdict.verdict).toBe("worse");
    expect(result.verdict.reasons.join(" ")).toMatch(/emits no candidates/);
  });

  it("reproduces its logical hash, reruns to the same hash and refuses a tampered report", async () => {
    const s = await setup(npmItems("rust"));
    const first = await backtest(s, "first", "2026-09-27,2026-09-28");
    const second = await backtest(s, "second", "2026-09-27,2026-09-28");
    expect(second.report.logical_hash).toBe(first.report.logical_hash);
    expect(second.report.backtest_id).toBe(first.report.backtest_id);

    const rerun = await checkBacktest(first.path, {
      outDir: NodePath.join(s.root, "rerun"),
      options: { embedder: fingerprintEmbedder() },
    });
    expect(rerun.ok).toBe(true);
    expect(rerun.rerun?.logical_hash).toBe(first.report.logical_hash);

    const relocatedCorpus = NodePath.join(s.root, "moved-corpus");
    const relocatedProfile = NodePath.join(s.root, "moved-profile.json");
    NodeFS.renameSync(s.corpusDir, relocatedCorpus);
    NodeFS.renameSync(s.profilePath, relocatedProfile);
    const moved = await checkBacktest(first.path, {
      outDir: NodePath.join(s.root, "moved-rerun"),
      options: {
        corpusDir: relocatedCorpus,
        profilePath: relocatedProfile,
        embedder: fingerprintEmbedder(),
      },
    });
    expect(moved.ok).toBe(true);
    NodeFS.writeFileSync(s.profilePath, "{}");
    await expect(
      checkBacktest(first.path, {
        outDir: NodePath.join(s.root, "wrong-profile"),
        options: {
          corpusDir: relocatedCorpus,
          profilePath: s.profilePath,
          embedder: fingerprintEmbedder(),
        },
      }),
    ).rejects.toThrow(/profile hash differs/);
    NodeFS.renameSync(relocatedCorpus, s.corpusDir);
    NodeFS.renameSync(relocatedProfile, s.profilePath);

    const tampered = JSON.parse(NodeFS.readFileSync(first.path, "utf8"));
    tampered.logical.total.complete.candidate.mean_p_at_5 = 0.5;
    const file = NodePath.join(s.root, "tampered.json");
    NodeFS.writeFileSync(file, JSON.stringify(tampered));
    const checked = await checkBacktest(file);
    expect(checked.ok).toBe(false);
    expect(checked.problems).toContain("logical_hash does not recompute");

    // A report of the first schema fails the check; its rerun writes the current schema.
    const old = JSON.parse(NodeFS.readFileSync(first.path, "utf8"));
    old.schema_version = "earlyscript.backtest/1";
    const oldFile = NodePath.join(s.root, "old.json");
    NodeFS.writeFileSync(oldFile, JSON.stringify(old));
    expect((await checkBacktest(oldFile)).problems[0]).toMatch(/^schema earlyscript.backtest\/1/);
    const regenerated = await checkBacktest(oldFile, {
      outDir: NodePath.join(s.root, "regenerated"),
      options: { embedder: fingerprintEmbedder() },
    });
    expect(regenerated.rerun?.logical_hash).toBe(first.report.logical_hash);
  });
});
