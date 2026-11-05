// L2-regularised logistic regression by Newton's method, in float64 and fixed loop order,
// so the same rows give the same weights on every machine. The intercept is not penalised.
// Sizes here (a few thousand rows of 1024 dimensions) make the exact Hessian affordable.

import { sigmoid } from "../relevance.ts";

export interface LogisticFit {
  readonly weights: Float64Array;
  readonly bias: number;
  readonly iterations: number;
}

/** Rows are vectors of equal length; labels are 0 or 1. */
export function fitLogistic(
  rows: ReadonlyArray<Float32Array>,
  labels: ReadonlyArray<number>,
  lambda: number,
  options: { readonly maxIterations?: number; readonly tolerance?: number } = {},
): LogisticFit {
  const n = rows.length;
  if (n === 0) throw new Error("no training rows");
  const d = rows[0]!.length;
  const m = d + 1; // last coordinate is the intercept
  const beta = new Float64Array(m);
  const maxIterations = options.maxIterations ?? 50;
  const tolerance = options.tolerance ?? 1e-10;
  const x = new Float64Array(m);
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    const grad = new Float64Array(m);
    const hess = new Float64Array(m * m);
    for (let r = 0; r < n; r++) {
      const row = rows[r]!;
      for (let i = 0; i < d; i++) x[i] = row[i]!;
      x[d] = 1;
      let z = 0;
      for (let i = 0; i < m; i++) z += beta[i]! * x[i]!;
      const p = sigmoid(z);
      const g = p - labels[r]!;
      const w = Math.max(p * (1 - p), 1e-12);
      for (let i = 0; i < m; i++) {
        const xi = x[i]!;
        grad[i]! += g * xi;
        const wxi = w * xi;
        const base = i * m;
        // Upper triangle only; mirrored before solving.
        for (let j = i; j < m; j++) hess[base + j]! += wxi * x[j]!;
      }
    }
    for (let i = 0; i < d; i++) {
      grad[i]! += lambda * beta[i]!;
      hess[i * m + i]! += lambda;
    }
    for (let i = 0; i < m; i++) for (let j = 0; j < i; j++) hess[i * m + j] = hess[j * m + i]!;
    const step = choleskySolve(hess, grad, m);
    let change = 0;
    for (let i = 0; i < m; i++) {
      beta[i]! -= step[i]!;
      change = Math.max(change, Math.abs(step[i]!));
    }
    if (change < tolerance) {
      iterations++;
      break;
    }
  }
  return { weights: beta.slice(0, d), bias: beta[d]!, iterations };
}

/** Solves A x = b for a symmetric positive definite A (row-major, size m), in place on a copy. */
export function choleskySolve(a: Float64Array, b: Float64Array, m: number): Float64Array {
  const l = Float64Array.from(a);
  for (let j = 0; j < m; j++) {
    let diag = l[j * m + j]!;
    for (let k = 0; k < j; k++) diag -= l[j * m + k]! * l[j * m + k]!;
    if (!(diag > 0)) throw new Error("matrix is not positive definite");
    const root = Math.sqrt(diag);
    l[j * m + j] = root;
    for (let i = j + 1; i < m; i++) {
      let sum = l[i * m + j]!;
      for (let k = 0; k < j; k++) sum -= l[i * m + k]! * l[j * m + k]!;
      l[i * m + j] = sum / root;
    }
  }
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= l[i * m + k]! * y[k]!;
    y[i] = sum / l[i * m + i]!;
  }
  const out = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < m; k++) sum -= l[k * m + i]! * out[k]!;
    out[i] = sum / l[i * m + i]!;
  }
  return out;
}

export function predict(fit: LogisticFit, row: Float32Array): number {
  let z = fit.bias;
  for (let i = 0; i < fit.weights.length; i++) z += fit.weights[i]! * row[i]!;
  return sigmoid(z);
}

/** Area under the ROC curve with ties counted as half (Mann-Whitney). */
export function auc(scores: ReadonlyArray<number>, labels: ReadonlyArray<number>): number | null {
  const order = scores.map((s, i) => ({ s, y: labels[i]! })).toSorted((a, b) => a.s - b.s);
  let pos = 0;
  let neg = 0;
  let rankSum = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j < order.length && order[j]!.s === order[i]!.s) j++;
    const midRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (order[k]!.y === 1) {
        pos++;
        rankSum += midRank;
      } else neg++;
    }
    i = j;
  }
  if (pos === 0 || neg === 0) return null;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function logLoss(probs: ReadonlyArray<number>, labels: ReadonlyArray<number>): number {
  let sum = 0;
  probs.forEach((p, i) => {
    const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
    sum -= labels[i] === 1 ? Math.log(q) : Math.log(1 - q);
  });
  return sum / probs.length;
}

export function confusion(
  probs: ReadonlyArray<number>,
  labels: ReadonlyArray<number>,
  threshold: number,
) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  probs.forEach((p, i) => {
    const yes = p >= threshold;
    if (labels[i] === 1) yes ? tp++ : fn++;
    else yes ? fp++ : tn++;
  });
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return { tp, fp, tn, fn, precision, recall, f1, accuracy: (tp + tn) / probs.length };
}
