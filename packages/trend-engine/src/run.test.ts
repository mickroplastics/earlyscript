// @effect-diagnostics nodeBuiltinImport:off - tests write temporary corpora.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { checkRun, readRun } from "./check.ts";
import { readCorpus } from "./corpus.ts";
import { fingerprintEmbedder } from "./embed/fingerprint.ts";
import type { Embedder } from "./embed/spec.ts";
import { runEngine } from "./run.ts";
import { fixtureSources } from "./sources/index.ts";
import {
  CUTOFF,
  FUTURE_WORD,
  syntheticItems,
  tempDir,
  testConfig,
  writeProfile,
  writeSyntheticCorpus,
} from "./testkit/syntheticCorpus.ts";

const LOST_DAY = "2026-10-05";

/** Records every text the run embeds. */
function recordingEmbedder(seen: Array<string>): Embedder {
  const inner = fingerprintEmbedder();
  return {
    ...inner,
    embed: async (texts) => {
      seen.push(...texts);
      return inner.embed(texts);
    },
  };
}

async function setup(options: Parameters<typeof writeSyntheticCorpus>[1] = {}) {
  const root = tempDir("trend-engine");
  const corpusDir = NodePath.join(root, "corpus");
  await writeSyntheticCorpus(corpusDir, options);
  return { root, corpusDir, profilePath: writeProfile(root), outDir: NodePath.join(root, "runs") };
}

describe("runEngine", () => {
  it("reads nothing at or after the cutoff", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    // A broken file after the cutoff proves the day is never opened.
    NodeFS.writeFileSync(NodePath.join(corpusDir, "hn", "2026-10-11.jsonl"), "not json\n");
    const seen: Array<string> = [];
    const record = await runEngine({
      corpusDir,
      cutoff: CUTOFF,
      profilePath,
      outDir,
      config: testConfig(),
      embedder: recordingEmbedder(seen),
      allowUnverifiedCorpus: true,
    });
    expect(record.status).toBe("ok");
    expect(seen.some((text) => text.includes(FUTURE_WORD))).toBe(false);
    const future = syntheticItems().filter((item) => item.published_at >= CUTOFF).length;
    expect(record.stats?.["items"]).toMatchObject({ read: syntheticItems().length - future });
    const { dossiers } = readRun(NodePath.join(outDir, record.run_id));
    expect(dossiers.length).toBeGreaterThan(0);
    for (const dossier of dossiers) {
      expect(dossier.curve.every((point) => point.day < CUTOFF.slice(0, 10))).toBe(true);
      expect(dossier.evidence.every((item) => item.published_at < CUTOFF)).toBe(true);
    }
  });

  it("reproduces the logical hash and keeps both rankings in every dossier", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    const run = () =>
      runEngine({
        corpusDir,
        cutoff: CUTOFF,
        profilePath,
        outDir,
        config: testConfig(),
        embedder: fingerprintEmbedder(),
      });
    const first = await run();
    const second = await run();
    expect(first.status).toBe("ok");
    expect(first.logical_hash).toBe(second.logical_hash);
    expect(first.stats?.["signals_hash"]).toBe(second.stats?.["signals_hash"]);
    expect(first.corpus?.verified).toBe(true);

    const dir = NodePath.join(outDir, first.run_id);
    const { dossiers } = readRun(dir);
    const growing = dossiers.find((d) => d.trend.top_terms.includes("compiler"));
    expect(growing).toBeDefined();
    expect(growing?.trend.stage).toBe("growing");
    expect(growing?.rankings.baseline.method).toBe("baseline.items_7d");
    expect(growing?.rankings.baseline.score).toBe(growing?.trend.items_7d);
    expect(growing?.rankings.weighted.components.map((c) => c.name)).toEqual([
      "growth",
      "log_authors_7d",
      "include_score",
    ]);
    expect(dossiers.map((d) => d.rankings.baseline.position)).toEqual(
      dossiers.map((_, k) => k + 1),
    );
    for (const item of growing?.evidence ?? []) {
      expect(item.permalink).toMatch(/^https:/);
      expect(item.source).toMatch(/^(hn|github)$/);
    }

    expect(checkRun(dir).ok).toBe(true);
    const file = NodePath.join(dir, readRun(dir).record.files[0]!);
    const tampered = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    tampered.trend.items_7d += 1;
    NodeFS.writeFileSync(file, JSON.stringify(tampered));
    expect(checkRun(dir).ok).toBe(false);
  });

  it("keeps evidence and marks the gap when a day is lost", async () => {
    const full = await setup();
    const lost = await setup({
      coverage: (row) => (row.source === "hn" && row.day === LOST_DAY ? null : row),
    });
    const run = (s: typeof full, coverageRule: "per_source" | "all_sources" = "per_source") =>
      runEngine({
        corpusDir: s.corpusDir,
        cutoff: CUTOFF,
        profilePath: s.profilePath,
        outDir: s.outDir,
        config: testConfig({ coverage_rule: coverageRule }),
        embedder: fingerprintEmbedder(),
      });
    const before = await run(full);
    const after = await run(lost);
    expect(after.status).toBe("ok");
    expect(after.stats?.["missing_days"]).toEqual([{ source: "hn", day: LOST_DAY }]);
    expect(after.coverage?.data_gaps).toContainEqual({
      source: "hn",
      day: LOST_DAY,
      reason: "not_collected",
    });

    const growing = (record: typeof before, dir: string) =>
      readRun(NodePath.join(dir, record.run_id)).dossiers.find((d) =>
        d.trend.top_terms.includes("compiler"),
      )!;
    const kept = growing(after, lost.outDir);
    expect(kept.trend.stage).toBe("growing");
    expect(kept.coverage.uncertain).toBe(true);
    expect(kept.curve.find((point) => point.day === LOST_DAY)?.known).toBe(false);
    // Only the lost day's three items are missing; every other day keeps its evidence.
    const reference = growing(before, full.outDir);
    expect(kept.trend.items_total).toBe(reference.trend.items_total! - 3);
    expect(kept.trend.items_7d).toBe(reference.trend.items_7d - 3);
    expect(kept.evidence.length).toBe(reference.evidence.length);

    // Earlywindow v0.02's rule empties the list for the same loss.
    expect((await run(lost, "all_sources")).dossiers).toBe(0);
  });

  it("fails on a corpus that no longer matches its manifest unless allowed", async () => {
    const { corpusDir, profilePath, outDir } = await setup();
    NodeFS.writeFileSync(NodePath.join(corpusDir, "stray.txt"), "not in the manifest\n");
    const record = await runEngine({
      corpusDir,
      cutoff: CUTOFF,
      profilePath,
      outDir,
      config: testConfig(),
      embedder: fingerprintEmbedder(),
    });
    expect(record.status).toBe("failed");
    expect(record.error).toMatch(/do not match corpus-manifest/);
    const corpus = await readCorpus({
      dir: corpusDir,
      adapters: fixtureSources(corpusDir, ["hn", "github"]),
      untilDay: CUTOFF.slice(0, 10),
      allowUnverified: true,
    });
    expect(corpus.verified).toBe(false);
    expect(corpus.missingDays).toEqual([]);
  });
});
