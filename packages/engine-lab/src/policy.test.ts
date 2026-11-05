import { DEFAULT_CONFIG_PATH, loadConfig } from "@earlyscript/trend-engine/run";
import { describe, expect, it } from "vite-plus/test";

import { applyFilePatch, parsePatch } from "./patch.ts";
import { applyConfigChange, assertNotSealed, LabPolicyError } from "./policy.ts";

const { config: v1 } = loadConfig(DEFAULT_CONFIG_PATH);

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof LabPolicyError ? error.code : `other: ${String(error)}`;
  }
  return "accepted";
};

describe("config changes", () => {
  it("sets known weights without normalizing them and records the diff", () => {
    const { config, diff } = applyConfigChange(v1, {
      weights: { growth: 0.1, log_authors_7d: 0.9 },
    });
    expect(config.rank.weighted.weights).toEqual({
      growth: 0.1,
      log_authors_7d: 0.9,
      include_score: 0.3,
    });
    expect(diff).toEqual([
      { path: "rank.weighted.weights.growth", from: 0.5, to: 0.1 },
      { path: "rank.weighted.weights.log_authors_7d", from: 0.2, to: 0.9 },
    ]);
  });

  it.each([
    [
      "unknown top-level key",
      { weights: { growth: 1 }, cluster: { threshold: 0.5 } },
      "invalid-change",
    ],
    ["unknown weight", { weights: { stars: 1 } }, "invalid-change"],
    ["NaN as a string", { weights: { growth: "NaN" } }, "invalid-change"],
    ["infinity", { weights: { growth: Number.POSITIVE_INFINITY } }, "invalid-change"],
    ["above the bound", { weights: { growth: 2.5 } }, "invalid-change"],
    ["negative", { weights: { growth: -0.1 } }, "invalid-change"],
    ["all zero", { weights: { growth: 0, log_authors_7d: 0, include_score: 0 } }, "invalid-change"],
    ["relevance weight without a model", { weights: { relevance: 1 } }, "invalid-change"],
    [
      "relevance thresholds without a model",
      { relevance: { item_min: 0.3 } },
      "unsupported-change",
    ],
    ["profile", { profile: { include: ["x"] } }, "unsupported-change"],
    ["feeds", { feeds: [] }, "unsupported-change"],
    ["no change", { weights: { growth: 0.5 } }, "invalid-change"],
  ])("refuses %s", (_name, change, code) => {
    expect(codeOf(() => applyConfigChange(v1, change))).toBe(code);
  });

  it("changes relevance thresholds of a base that has a model, within 0..1", () => {
    const base = {
      ...v1,
      relevance: {
        model: "m.json",
        sha256: "sha256:x",
        item_min: 0.26,
        signal_min: 0.4,
        profile_gate: false,
      },
    };
    expect(
      applyConfigChange(base, { relevance: { signal_min: 0.5 } }).config.relevance?.signal_min,
    ).toBe(0.5);
    expect(codeOf(() => applyConfigChange(base, { relevance: { signal_min: 1.5 } }))).toBe(
      "invalid-change",
    );
    expect(codeOf(() => applyConfigChange(base, { relevance: { novelty: {} } }))).toBe(
      "invalid-change",
    );
  });
});

describe("sealed partitions", () => {
  it("refuses the frozen evaluation's test cutoffs and its files", () => {
    expect(
      codeOf(() =>
        assertNotSealed({ cutoffs: ["2026-10-17T00:00:00.000Z"], paths: ["/data/dev"] }),
      ),
    ).toBe("accepted");
    expect(
      codeOf(() => assertNotSealed({ cutoffs: ["2026-11-06T00:00:00.000Z"], paths: [] })),
    ).toBe("sealed-partition");
    expect(codeOf(() => assertNotSealed({ cutoffs: ["2026-09-13"], paths: [] }))).toBe(
      "sealed-partition",
    );
    for (const path of [
      "/home/mick/earlyscript-data/eval-prospectivo/x.json",
      "/x/eval-largo/corpus",
      "/x/ledger.jsonl",
    ]) {
      expect(codeOf(() => assertNotSealed({ cutoffs: [], paths: [path] }))).toBe(
        "sealed-partition",
      );
    }
  });
});

const RANK = "packages/trend-engine/src/rank.ts";
const base = "line one\nline two\nline three\n";
const diff = (path: string, body: string) => `--- a/${path}\n+++ b/${path}\n${body}`;

describe("code patches", () => {
  it("applies a hunk by its context even with a wrong line number", () => {
    const [file] = parsePatch(diff(RANK, "@@ -40,2 +40,2 @@\n line one\n-line two\n+line 2\n"));
    expect(applyFilePatch(base, file!)).toBe("line one\nline 2\nline three\n");
  });

  it.each([
    [
      "a file outside the allowed ones",
      diff("packages/trend-engine/src/editorial-eval.ts", "@@ -1 +1 @@\n-a\n+b\n"),
      "invalid-change",
    ],
    [
      "the topic identity",
      diff("packages/trend-engine/src/topic-identity.ts", "@@ -1 +1 @@\n-a\n+b\n"),
      "invalid-change",
    ],
    ["a rename", `rename from ${RANK}\nrename to x.ts\n`, "invalid-change"],
    ["a new file", `--- /dev/null\n+++ b/${RANK}\n@@ -0,0 +1 @@\n+x\n`, "invalid-change"],
    ["no file", "just text\n", "invalid-change"],
    ["too large", diff(RANK, `@@ -1 +1 @@\n-a\n+${"x".repeat(30_000)}\n`), "invalid-change"],
  ])("refuses %s", (_name, patch, code) => {
    expect(codeOf(() => parsePatch(patch))).toBe(code);
  });

  it("refuses a hunk whose context the base file does not have: a stale base", () => {
    const [file] = parsePatch(diff(RANK, "@@ -1,2 +1,2 @@\n line zero\n-line two\n+line 2\n"));
    expect(codeOf(() => applyFilePatch(base, file!))).toBe("stale-base");
  });
});
