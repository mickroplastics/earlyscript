// @effect-diagnostics nodeBuiltinImport:off - tests write a temporary cache path.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { tempDir, testConfig } from "../testkit/syntheticCorpus.ts";
import { assertRunnableSpec, createLocalEmbedder } from "./local.ts";
import { EmbeddingCache } from "./cache.ts";
import { embeddingKey, embeddingSpec } from "./spec.ts";

describe("createLocalEmbedder", () => {
  const pinned = embeddingSpec(testConfig().embedder);

  it("accepts the shipped configuration", () => {
    expect(() => assertRunnableSpec(pinned)).not.toThrow();
  });

  it("reads cached vectors offline and fails before preparing a model on a miss", async () => {
    const dir = tempDir("cache-only");
    const cacheFile = NodePath.join(dir, "embeddings.sqlite");
    const cache = new EmbeddingCache(cacheFile, embeddingKey(pinned));
    const vector = new Float32Array(1024);
    vector[0] = 1;
    cache.setMany([["cached text", vector]]);
    cache.close();
    const bytes = NodeFS.readFileSync(cacheFile);
    const embedder = createLocalEmbedder(pinned, {
      cacheFile,
      modelDir: NodePath.join(dir, "missing-model"),
      workers: 2,
      allowDownload: false,
      cacheOnly: true,
    });
    try {
      expect(await embedder.embed(["cached text"])).toEqual([vector]);
      await expect(embedder.embed(["missing text"])).rejects.toThrow(
        /^Cache-only mode missing 1 embedding/,
      );
      expect(embedder.stats?.()).toMatchObject({ inferred: 0, workers: 0 });
    } finally {
      await embedder.dispose();
    }
    expect(NodeFS.readFileSync(cacheFile)).toEqual(bytes);
    expect(NodeFS.existsSync(NodePath.join(dir, "missing-model"))).toBe(false);
    expect(() =>
      createLocalEmbedder(pinned, {
        cacheFile: NodePath.join(dir, "absent.sqlite"),
        modelDir: dir,
        workers: 1,
        cacheOnly: true,
      }),
    ).toThrow();
    expect(NodeFS.existsSync(NodePath.join(dir, "absent.sqlite"))).toBe(false);
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

  it("prepares the model once, in the parent, before it starts any worker", async () => {
    const dir = tempDir("local-embedder-model");
    const embedder = createLocalEmbedder(pinned, {
      cacheFile: NodePath.join(dir, "embeddings.sqlite"),
      modelDir: NodePath.join(dir, "models"),
      workers: 4,
    });
    const texts = Array.from({ length: 64 }, (_, index) => `text ${index}`);
    await expect(embedder.embed(texts)).rejects.toThrow(/Model file missing/);
    expect(embedder.stats?.().workers).toBe(0);
    await embedder.dispose();
  });
});
