import { describe, expect, it } from "vite-plus/test";

import {
  dot,
  normalized,
  signalId,
  type StackInput,
  stackItems,
  type StackResult,
} from "./cluster.ts";
import { DAY_MS } from "./days.ts";
import { fingerprintEmbedder } from "./embed/fingerprint.ts";
import { prepare } from "./prepare.ts";
import { referenceStackItems } from "./testkit/cluster.reference.ts";
import { syntheticItems, testConfig } from "./testkit/syntheticCorpus.ts";

const START_MS = Date.parse("2026-08-01T00:00:00Z");

/** Mulberry32: a seeded generator, so the corpora are the same on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (next: () => number) =>
  Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());

/**
 * Unit vectors around a shared direction, as Qwen3's are, with topics that come and go
 * over `days`, so signals join, open, expire and outgrow the first pool.
 */
function clusteredItems(options: {
  seed: number;
  count: number;
  dim: number;
  topics: number;
  days: number;
  duplicates?: boolean;
}): Array<StackInput> {
  const next = random(options.seed);
  const direction = () => Array.from({ length: options.dim }, () => gaussian(next));
  const shared = direction();
  const topics = Array.from({ length: options.topics }, direction);
  const items: Array<StackInput> = [];
  for (let n = 0; n < options.count; n++) {
    const day = Math.floor((n / options.count) * options.days);
    const topic = topics[(day + Math.floor(next() * 6)) % options.topics]!;
    const noise = 0.6 + next() * 1.4;
    const vector = new Float32Array(options.dim);
    for (let i = 0; i < options.dim; i++) {
      vector[i] = 0.9 * shared[i]! + topic[i]! + noise * gaussian(next);
    }
    const publishedMs = START_MS + day * DAY_MS + Math.floor(next() * DAY_MS);
    items.push({
      id: `itm_${String(n).padStart(5, "0")}`,
      publishedMs,
      vector: normalized(vector),
    });
    if (options.duplicates && n % 17 === 0) {
      items.push({
        id: `itm_${String(n).padStart(5, "0")}b`,
        publishedMs,
        vector: items.at(-1)!.vector,
      });
    }
  }
  return items.toSorted(
    (a, b) => a.publishedMs - b.publishedMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

const bytes = (vector: Float32Array) =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("hex");

/** Everything a run reads from a signal, with vectors compared bit for bit. */
const comparable = (result: StackResult) => ({
  comparisons: result.comparisons,
  signals: result.signals.map((s) => ({
    id: s.id,
    itemIds: s.itemIds,
    firstMs: s.firstMs,
    lastMs: s.lastMs,
    sum: bytes(s.sum),
    centroid: bytes(s.centroid),
  })),
});

/** Inputs are copied because both implementations write into each signal's sum. */
function expectSameAsReference(items: ReadonlyArray<StackInput>, threshold: number, days: number) {
  const copy = () => items.map((item) => ({ ...item, vector: item.vector.slice() }));
  const fast = comparable(stackItems(copy(), threshold, days));
  expect(fast).toEqual(comparable(referenceStackItems(copy(), threshold, days)));
  return fast;
}

describe("stackItems", () => {
  it("returns the reference signals on clustered 1024-dimension vectors", () => {
    const items = clusteredItems({ seed: 1, count: 1500, dim: 1024, topics: 40, days: 70 });
    const result = expectSameAsReference(items, 0.7, 30);
    const joined = result.signals.filter((s) => s.itemIds.length > 1).length;
    // The corpus exercises every path: joins, signals that open and expire, a grown pool.
    expect(joined).toBeGreaterThan(50);
    expect(result.signals.length - joined).toBeGreaterThan(100);
    expect(result.comparisons).toBeLessThan((items.length * (items.length - 1)) / 2);
  });

  it("returns the reference signals across thresholds, windows and duplicate vectors", () => {
    const items = clusteredItems({
      seed: 2,
      count: 600,
      dim: 1024,
      topics: 25,
      days: 40,
      duplicates: true,
    });
    for (const threshold of [-2, 0, 0.3, 0.5, 0.6, 0.7, 0.8, 0.95, 2]) {
      for (const days of [0, 3, 30]) expectSameAsReference(items, threshold, days);
    }
  });

  it("returns the reference signals on odd dimensions", () => {
    for (const dim of [1, 3, 7, 130]) {
      const items = clusteredItems({ seed: dim, count: 300, dim, topics: 8, days: 20 });
      for (const threshold of [0.2, 0.7, 0.9]) expectSameAsReference(items, threshold, 10);
    }
  });

  it("returns the reference signals on the synthetic corpus", async () => {
    const config = testConfig();
    const kept = prepare(syntheticItems(), config.text).filter((item) => item.excluded === null);
    const vectors = await fingerprintEmbedder().embed(kept.map((item) => item.text));
    const items = kept.map((item, k) => ({
      id: item.id,
      publishedMs: item.publishedMs,
      vector: vectors[k]!,
    }));
    for (const threshold of [0.3, 0.5, 0.7, 0.9]) expectSameAsReference(items, threshold, 30);
  });

  it("breaks an exact cosine tie towards the smaller signal id, like the reference", () => {
    const dim = 1024;
    const unit = (entries: Record<number, number>) => {
      const vector = new Float32Array(dim);
      for (const [i, value] of Object.entries(entries)) vector[Number(i)] = value;
      return vector;
    };
    // Two signals 0.64 apart, both 0.8 from the third item: an exact tie above 0.7.
    const ids = ["itm_a", "itm_b"].toSorted((a, b) => (signalId(a) < signalId(b) ? 1 : -1));
    const items: Array<StackInput> = [
      { id: ids[0]!, publishedMs: START_MS, vector: unit({ 0: 0.8, 1: 0.6 }) },
      { id: ids[1]!, publishedMs: START_MS + 1, vector: unit({ 0: 0.8, 2: 0.6 }) },
      { id: "itm_c", publishedMs: START_MS + 2, vector: unit({ 0: 1 }) },
    ];
    const result = expectSameAsReference(items, 0.7, 30);
    expect(result.signals.map((s) => s.itemIds)).toEqual([[ids[0]], [ids[1], "itm_c"]]);
  });

  it("rescans the centroid the first item of a pair changed or opened", () => {
    // Items go through the first checkpoint in pairs: the second of each pair must see the
    // signal the first one opened or moved, here with near-duplicates and an odd count.
    const next = random(9);
    const base = Array.from({ length: 1024 }, () => gaussian(next));
    const items: Array<StackInput> = Array.from({ length: 9 }, (_, n) => {
      const vector = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) vector[i] = base[i]! + 0.3 * gaussian(next);
      return { id: `itm_${n}`, publishedMs: START_MS + n, vector: normalized(vector) };
    });
    const result = expectSameAsReference(items, 0.8, 30);
    expect(result.signals.map((s) => s.itemIds.length)).toEqual([9]);
    expectSameAsReference(items.slice(0, 2), 0.8, 30);
    expectSameAsReference(items.slice(0, 1), 0.8, 30);
  });

  it("keeps a candidate whose pruning bound sits exactly at a saturated threshold", () => {
    // Three identical near-unit vectors and a threshold one hair below their cosine:
    // the reference joins all three. A pruning slack with the wrong sign, or a bound
    // computed against the wrong tail norm, splits them into three signals instead.
    const next = random(424242);
    const vector = normalized(Float32Array.from({ length: 1024 }, () => next() * 2 - 1)).map(
      (x) => x * (1 - 1e-7),
    );
    const items = [0, 1, 2].map((n) => ({
      id: `itm_${n}`,
      publishedMs: START_MS + n,
      vector: Float32Array.from(vector),
    }));
    const threshold = dot(vector, vector) - 1e-10;
    const fast = expectSameAsReference(items, threshold, 30);
    expect(fast.signals).toHaveLength(1);
    expect(fast.signals[0]!.itemIds).toEqual(["itm_0", "itm_1", "itm_2"]);
  });

  it("matches the reference around representable neighbours of the threshold", () => {
    // Cosine exactly at, one ULP below and one ULP above the threshold, in dimensions
    // that are and are not multiples of the pruning cuts.
    const ulp = (x: number, direction: 1n | -1n) => {
      const view = new DataView(new ArrayBuffer(8));
      view.setFloat64(0, x);
      view.setBigUint64(0, view.getBigUint64(0) + direction);
      return view.getFloat64(0);
    };
    for (const dim of [1021, 1023, 1024]) {
      const a = new Float32Array(dim);
      a[0] = 1;
      for (const target of [0.7 - 1e-7, 0.7, 0.7 + 1e-7]) {
        const b = new Float32Array(dim);
        b[0] = target;
        b[dim - 1] = Math.sqrt(1 - target * target);
        const unitB = normalized(b);
        const cosine = dot(a, unitB);
        const items = [a, unitB, unitB].map((v, n) => ({
          id: `itm_${n}`,
          publishedMs: START_MS + n,
          vector: Float32Array.from(v),
        }));
        for (const threshold of [cosine, ulp(cosine, -1n), ulp(cosine, 1n), target]) {
          expectSameAsReference(items, threshold, 30);
        }
      }
    }
  });

  it("returns no signals for no items", () => {
    expect(stackItems([], 0.7, 30)).toEqual({ signals: [], comparisons: 0 });
  });
});
