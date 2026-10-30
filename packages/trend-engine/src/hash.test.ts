import { describe, expect, it } from "vite-plus/test";

import { logicalHash } from "./dossier.ts";
import { embeddingKey } from "./embed/spec.ts";
import { canonicalJson } from "./hash.ts";
import { positions, score } from "./rank.ts";

describe("hashes", () => {
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });

  it("logical hash ignores run ids and timestamps but not results", () => {
    const dossier = {
      run_id: "run_a",
      dossier_id: "dos_a",
      created_at: "2026-10-30T00:00:00Z",
      trend: { growth: 1.25 },
    };
    const same = {
      ...dossier,
      run_id: "run_b",
      dossier_id: "dos_b",
      created_at: "2026-10-31T00:00:00Z",
    };
    const other = { ...dossier, trend: { growth: 1.2501 } };
    const hash = (value: object) => logicalHash([value as any]);
    expect(hash(same)).toBe(hash(dossier));
    expect(hash(other)).not.toBe(hash(dossier));
  });

  it("embedding key changes with platform, arch and runtime", () => {
    const spec = {
      model: "m",
      revision: "r",
      dtype: "q8",
      pooling: "last_token" as const,
      batch_size: 1,
      runtime: "rt",
      platform: "linux",
      arch: "x64",
    };
    const keys = new Set([
      embeddingKey(spec),
      embeddingKey({ ...spec, platform: "darwin" }),
      embeddingKey({ ...spec, arch: "arm64" }),
      embeddingKey({ ...spec, runtime: "rt2" }),
    ]);
    expect(keys.size).toBe(4);
  });
});

describe("rank", () => {
  it("adds weighted components with reference zero and orders ties by id", () => {
    const scored = score(
      "weighted",
      { growth: 0.5, include_score: 0.3 },
      { growth: 2, include_score: null },
    );
    expect(scored).toEqual({
      method: "weighted",
      score: 1,
      components: [
        { name: "growth", value: 2, weight: 0.5, contribution: 1 },
        { name: "include_score", value: null, weight: 0.3, contribution: 0 },
      ],
    });
    const order = positions(
      [
        { id: "b", s: 3 },
        { id: "a", s: 3 },
        { id: "c", s: 5 },
      ],
      (e) => e.s,
    );
    expect([...order]).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
  });
});
