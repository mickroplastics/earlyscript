// @effect-diagnostics nodeBuiltinImport:off - plain library.
// Incremental stacking, ported from Earlywindow's src/engine/cluster.ts (method 0.01, step 5).
import * as NodeCrypto from "node:crypto";

import { DAY_MS } from "./days.ts";

export interface StackInput {
  readonly id: string;
  readonly publishedMs: number;
  readonly vector: Float32Array;
}

export interface StackedSignal {
  readonly id: string;
  readonly itemIds: Array<string>;
  readonly firstMs: number;
  lastMs: number;
  readonly sum: Float32Array;
  centroid: Float32Array;
}

export interface StackResult {
  readonly signals: Array<StackedSignal>;
  /** Cosine comparisons against active signals: the cost that grows with the corpus. */
  readonly comparisons: number;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i]! * b[i]!;
  return result;
}

export function normalized(vector: Float32Array): Float32Array {
  const norm = Math.sqrt(dot(vector, vector));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("vector has zero or invalid norm");
  return vector.map((v) => v / norm);
}

export const signalId = (firstItemId: string): string =>
  `sig_${NodeCrypto.createHash("sha256").update(firstItemId).digest("hex").slice(0, 12)}`;

/**
 * Checkpoints as shares of the dimensions. At each one a centroid is dropped when the
 * cosine so far plus the Cauchy-Schwarz bound of the remaining coordinates cannot exceed
 * the threshold. Qwen3 vectors carry 58 % of their energy in the first half.
 */
const CHECKPOINTS = [1 / 2, 5 / 8, 3 / 4, 7 / 8];
/**
 * Covers the rounding of the prefix, the full sum and the tail norms (about 1e-13 for
 * 1024 dimensions), so a dropped centroid's exact cosine is never above the threshold.
 */
const SLACK = 1e-9;

/** Active centroids in one Float32Array, a slot each, with the norms the bound needs. */
class CentroidPool {
  readonly dim: number;
  readonly cuts: ReadonlyArray<number>;
  data: Float32Array;
  /** Per slot: norm of the coordinates from each cut on, then the full norm. */
  tails: Float64Array;
  lastMs: Float64Array;
  signals: Array<StackedSignal | undefined> = [];
  private readonly free: Array<number> = [];
  private used = 0;

  constructor(dim: number, cuts: ReadonlyArray<number>) {
    this.dim = dim;
    this.cuts = cuts;
    this.data = new Float32Array(64 * dim);
    this.tails = new Float64Array(64 * (cuts.length + 1));
    this.lastMs = new Float64Array(64);
  }

  add(signal: StackedSignal): number {
    let slot = this.free.pop();
    if (slot === undefined) {
      slot = this.used++;
      if (slot === this.lastMs.length) this.grow();
    }
    this.signals[slot] = signal;
    this.set(slot, signal.centroid, signal.lastMs);
    return slot;
  }

  set(slot: number, centroid: Float32Array, lastMs: number): void {
    this.data.set(centroid, slot * this.dim);
    this.lastMs[slot] = lastMs;
    tailNorms(centroid, this.cuts, this.tails, slot * (this.cuts.length + 1));
  }

  release(slot: number): void {
    this.signals[slot] = undefined;
    this.free.push(slot);
  }

  private grow(): void {
    const capacity = this.lastMs.length * 2;
    const data = new Float32Array(capacity * this.dim);
    data.set(this.data);
    this.data = data;
    const tails = new Float64Array(capacity * (this.cuts.length + 1));
    tails.set(this.tails);
    this.tails = tails;
    const lastMs = new Float64Array(capacity);
    lastMs.set(this.lastMs);
    this.lastMs = lastMs;
  }
}

/** Writes the norm of vector[cut..] for each cut, then the full norm, at out[offset..]. */
function tailNorms(
  vector: ArrayLike<number>,
  cuts: ReadonlyArray<number>,
  out: Float64Array,
  offset: number,
): void {
  let squares = 0;
  let i = vector.length;
  for (let c = cuts.length - 1; c >= -1; c--) {
    const cut = c < 0 ? 0 : cuts[c]!;
    while (i > cut) {
      i--;
      squares += vector[i]! * vector[i]!;
    }
    out[offset + (c < 0 ? cuts.length : c)] = Math.sqrt(squares);
  }
}

/**
 * acc[k] += x[i] * data[slots[k] * dim + i] for i in [from, to), left to right, four
 * centroids per pass. Each sum keeps dot()'s order and double precision, so a cosine
 * built over several calls is bit-identical to dot(); only independent sums interleave.
 */
function accumulate(
  x: Float64Array,
  data: Float32Array,
  dim: number,
  slots: Int32Array,
  acc: Float64Array,
  count: number,
  from: number,
  to: number,
): void {
  let k = 0;
  for (; k + 4 <= count; k += 4) {
    const o0 = slots[k]! * dim;
    const o1 = slots[k + 1]! * dim;
    const o2 = slots[k + 2]! * dim;
    const o3 = slots[k + 3]! * dim;
    let s0 = acc[k]!;
    let s1 = acc[k + 1]!;
    let s2 = acc[k + 2]!;
    let s3 = acc[k + 3]!;
    for (let i = from; i < to; i++) {
      const v = x[i]!;
      s0 += v * data[o0 + i]!;
      s1 += v * data[o1 + i]!;
      s2 += v * data[o2 + i]!;
      s3 += v * data[o3 + i]!;
    }
    acc[k] = s0;
    acc[k + 1] = s1;
    acc[k + 2] = s2;
    acc[k + 3] = s3;
  }
  for (; k < count; k++) {
    const o = slots[k]! * dim;
    let s = acc[k]!;
    for (let i = from; i < to; i++) s += x[i]! * data[o + i]!;
    acc[k] = s;
  }
}

/**
 * Items must arrive sorted by (published_at, id). Each joins the active signal with the
 * highest cosine when strictly above the threshold, ties to the smaller id; otherwise it
 * opens a signal. Active means it received an item in the last `activeDays`.
 */
export function stackItems(
  items: ReadonlyArray<StackInput>,
  threshold: number,
  activeDays: number,
): StackResult {
  // Same signals as dot() over every active centroid: sums keep dot()'s order, and the
  // bound only drops centroids whose cosine cannot pass the threshold.
  const signals: Array<StackedSignal> = [];
  let comparisons = 0;
  if (items.length === 0) return { signals, comparisons };
  const windowMs = activeDays * DAY_MS;
  const dim = items[0]!.vector.length;
  const cuts = [
    ...new Set(CHECKPOINTS.map((share) => Math.floor(dim * share)).filter((c) => c > 0)),
  ];
  const stride = cuts.length + 1;
  const pool = new CentroidPool(dim, cuts);
  const x = new Float64Array(dim);
  const xTails = new Float64Array(stride);
  let active = new Int32Array(64);
  let activeCount = 0;
  let slots = new Int32Array(64);
  let acc = new Float64Array(64);

  for (const item of items) {
    if (item.vector.length !== dim)
      throw new Error(`item ${item.id} has ${item.vector.length} dimensions, not ${dim}`);
    let kept = 0;
    for (let k = 0; k < activeCount; k++) {
      const slot = active[k]!;
      if (item.publishedMs - pool.lastMs[slot]! <= windowMs) active[kept++] = slot;
      else pool.release(slot);
    }
    activeCount = kept;
    comparisons += activeCount;

    if (slots.length < activeCount) {
      slots = new Int32Array(active.length);
      acc = new Float64Array(active.length);
    }
    slots.set(active.subarray(0, activeCount));
    acc.fill(0, 0, activeCount);
    x.set(item.vector);
    tailNorms(x, cuts, xTails, 0);
    let count = activeCount;
    let from = 0;
    for (let c = 0; c < cuts.length && count > 0; c++) {
      accumulate(x, pool.data, dim, slots, acc, count, from, cuts[c]!);
      from = cuts[c]!;
      let survivors = 0;
      for (let k = 0; k < count; k++) {
        const t = slots[k]! * stride;
        const bound =
          acc[k]! +
          xTails[c]! * pool.tails[t + c]! +
          SLACK * (1 + xTails[cuts.length]! * pool.tails[t + cuts.length]!);
        if (bound > threshold) {
          slots[survivors] = slots[k]!;
          acc[survivors++] = acc[k]!;
        }
      }
      count = survivors;
    }
    accumulate(x, pool.data, dim, slots, acc, count, from, dim);

    let best: StackedSignal | undefined;
    let bestSlot = -1;
    let bestCosine = -Infinity;
    for (let k = 0; k < count; k++) {
      const cosine = acc[k]!;
      const signal = pool.signals[slots[k]!]!;
      if (cosine > bestCosine || (cosine === bestCosine && best && signal.id < best.id)) {
        best = signal;
        bestSlot = slots[k]!;
        bestCosine = cosine;
      }
    }
    if (best && bestCosine > threshold) {
      best.itemIds.push(item.id);
      best.lastMs = item.publishedMs;
      for (let j = 0; j < dim; j++) best.sum[j]! += item.vector[j]!;
      best.centroid = normalized(best.sum);
      pool.set(bestSlot, best.centroid, best.lastMs);
    } else {
      const signal: StackedSignal = {
        id: signalId(item.id),
        itemIds: [item.id],
        firstMs: item.publishedMs,
        lastMs: item.publishedMs,
        sum: item.vector.slice(),
        centroid: item.vector,
      };
      signals.push(signal);
      if (activeCount === active.length) {
        const grown = new Int32Array(active.length * 2);
        grown.set(active);
        active = grown;
      }
      active[activeCount++] = pool.add(signal);
    }
  }
  return { signals, comparisons };
}
