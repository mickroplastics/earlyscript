// The stacking of src/cluster.ts before the contiguous kernel (main d505a14ede), kept only
// so tests can check that the fast version returns the same signals, sums and centroids.
import { DAY_MS } from "../days.ts";
import { signalId, type StackInput, type StackedSignal, type StackResult } from "../cluster.ts";

/**
 * Items must arrive sorted by (published_at, id). Each joins the active signal with the
 * highest cosine when strictly above the threshold, ties to the smaller id; otherwise it
 * opens a signal. Active means it received an item in the last `activeDays`.
 */
export function referenceStackItems(
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
      const cosine = referenceDot(item.vector, signal.centroid);
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
      best.centroid = referenceNormalized(best.sum);
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

function referenceDot(a: Float32Array, b: Float32Array): number {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i]! * b[i]!;
  return result;
}

function referenceNormalized(vector: Float32Array): Float32Array {
  const norm = Math.sqrt(referenceDot(vector, vector));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("vector has zero or invalid norm");
  return vector.map((v) => v / norm);
}
