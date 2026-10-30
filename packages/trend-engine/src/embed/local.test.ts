// @effect-diagnostics nodeBuiltinImport:off - tests write a temporary cache path.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { tempDir, testConfig } from "../testkit/syntheticCorpus.ts";
import { assertRunnableSpec, createLocalEmbedder } from "./local.ts";
import { embeddingSpec } from "./spec.ts";

describe("createLocalEmbedder", () => {
  const pinned = embeddingSpec(testConfig().embedder);

  it("accepts the shipped configuration", () => {
    expect(() => assertRunnableSpec(pinned)).not.toThrow();
  });

  it.each([
    ["revision", { revision: "incorrect-revision" }],
    ["dtype", { dtype: "fp32" }],
    ["pooling", { pooling: "mean" as const }],
  ])("refuses a spec with another %s before touching the cache", (field, change) => {
    const cacheFile = NodePath.join(tempDir("local-embedder"), "embeddings.sqlite");
    expect(() =>
      createLocalEmbedder(
        { ...pinned, ...change },
        { cacheFile, modelDir: NodePath.dirname(cacheFile), workers: 1 },
      ),
    ).toThrow(new RegExp(`only runs ${field} `));
    expect(NodeFS.existsSync(cacheFile)).toBe(false);
  });
});
