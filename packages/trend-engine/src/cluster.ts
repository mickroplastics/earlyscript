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
 * Items must arrive sorted by (published_at, id). Each joins the active signal with the
 * highest cosine when strictly above the threshold, ties to the smaller id; otherwise it
 * opens a signal. Active means it received an item in the last `activeDays`.
 */
export function stackItems(
  items: ReadonlyArray<StackInput>,
  threshold: number,
  activeDays: number,
): StackResult {
  const signals: Array<StackedSignal> = [];
  let active: Array<StackedSignal> = [];
  let comparisons = 0;
  const windowMs = activeDays * DAY_MS;
  for (const item of items) {
    active = active.filter((signal) => item.publishedMs - signal.lastMs <= windowMs);
    let best: StackedSignal | undefined;
    let bestCosine = -Infinity;
    for (const signal of active) {
      const cosine = dot(item.vector, signal.centroid);
      comparisons++;
      if (cosine > bestCosine || (cosine === bestCosine && best && signal.id < best.id)) {
        best = signal;
        bestCosine = cosine;
      }
    }
    if (best && bestCosine > threshold) {
      best.itemIds.push(item.id);
      best.lastMs = item.publishedMs;
      for (let j = 0; j < item.vector.length; j++) best.sum[j]! += item.vector[j]!;
      best.centroid = normalized(best.sum);
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
      active.push(signal);
    }
  }
  return { signals, comparisons };
}
