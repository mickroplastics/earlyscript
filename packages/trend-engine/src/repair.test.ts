// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - tests write a temporary corpus.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { CoverageRecord } from "@earlyscript/editorial-contracts/source";

import { collectCorpus } from "./collect.ts";
import { readCorpus } from "./corpus.ts";
import { repairRobotsOverrideTerms } from "./repair.ts";
import type { SourceAdapter } from "./sources/adapter.ts";
import { fixtureSources, sourceDescriptor, withRobotsOverride } from "./sources/index.ts";
import { tempDir } from "./testkit/syntheticCorpus.ts";

const arxiv = sourceDescriptor("arxiv");
const override = arxiv.robots_override!;

/** An arXiv adapter whose days carry the note a capture wrote before terms_url was kept. */
function arxivAdapter(noteOf: (row: CoverageRecord) => CoverageRecord): SourceAdapter {
  return {
    descriptor: arxiv,
    collectDay: async (day) => ({
      items: [],
      coverage: noteOf({
        source: "arxiv",
        day,
        status: "complete",
        items: 0,
        retrieved_at: `${day}T23:00:00.000Z`,
        note: "4 categories",
      }),
    }),
  };
}

const oldNote = (row: CoverageRecord): CoverageRecord => ({
  ...row,
  note: `robots_override: ${override.reason}; ${row.note}`,
});

const manifestOf = (dir: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "corpus-manifest.json"), "utf8"));
const coverageOf = (dir: string): Array<CoverageRecord> =>
  NodeFS.readFileSync(NodePath.join(dir, "coverage.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe("robots.txt exception in the corpus", () => {
  it("records the terms URL in each day's note and in the manifest on capture", async () => {
    const dir = NodePath.join(tempDir("robots-override"), "corpus");
    await collectCorpus({
      dir,
      from: "2026-10-26",
      to: "2026-10-28",
      adapters: [arxivAdapter((row) => withRobotsOverride(row, override))],
    });
    expect(coverageOf(dir).map((row) => row.robots_override)).toEqual([override, override]);
    expect(coverageOf(dir)[0]!.note).toBe(
      `robots_override: ${override.reason} (terms: ${override.terms_url}); 4 categories`,
    );
    expect(manifestOf(dir).robots_overrides).toEqual([
      { source: "arxiv", day: "2026-10-26", ...override },
      { source: "arxiv", day: "2026-10-27", ...override },
    ]);
  });

  it("repairs days captured without the terms URL and records the repair", async () => {
    const dir = NodePath.join(tempDir("robots-repair"), "corpus");
    await collectCorpus({
      dir,
      from: "2026-10-26",
      to: "2026-10-28",
      adapters: [arxivAdapter(oldNote)],
    });
    expect(manifestOf(dir).robots_overrides).toBeUndefined();

    const repair = await repairRobotsOverrideTerms({
      dir,
      source: "arxiv",
      now: () => "2026-11-01T00:00:00.000Z",
    });
    expect(repair.days).toEqual(["2026-10-26", "2026-10-27"]);
    expect(repair.corpus_hash_after).not.toBe(repair.corpus_hash_before);
    expect(coverageOf(dir).map((row) => row.note)).toEqual([
      `robots_override: ${override.reason} (terms: ${override.terms_url}); 4 categories`,
      `robots_override: ${override.reason} (terms: ${override.terms_url}); 4 categories`,
    ]);
    const manifest = manifestOf(dir);
    expect(manifest.robots_overrides).toHaveLength(2);
    expect(manifest.repairs).toEqual([
      expect.objectContaining({
        repaired_at: "2026-11-01T00:00:00.000Z",
        tool: "engine repair-robots-override",
        source: "arxiv",
        days: ["2026-10-26", "2026-10-27"],
      }),
    ]);
    // The coverage the capture wrote stays in history/, listed in the manifest.
    const before = manifest.repairs[0].coverage_before;
    expect(NodeFS.readFileSync(NodePath.join(dir, before), "utf8")).toContain(
      `robots_override: ${override.reason}; 4 categories`,
    );
    const corpus = await readCorpus({
      dir,
      adapters: fixtureSources(dir, ["arxiv"]),
      untilDay: "2026-10-28",
    });
    expect(corpus.verified).toBe(true);
    expect(corpus.manifestHash).toBe(repair.corpus_hash_after);

    // Idempotent, and a later capture keeps the repair record.
    expect((await repairRobotsOverrideTerms({ dir, source: "arxiv" })).days).toEqual([]);
    await collectCorpus({
      dir,
      from: "2026-10-28",
      to: "2026-10-29",
      adapters: [arxivAdapter((row) => withRobotsOverride(row, override))],
    });
    expect(manifestOf(dir).repairs).toHaveLength(1);
    expect(manifestOf(dir).robots_overrides).toHaveLength(3);
  });
});
