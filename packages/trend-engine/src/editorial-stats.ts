// Pure statistics of `engine eval-editorial score` (protocol P1.1): slot credits of a top 5,
// paired bootstrap by topic family and by moving blocks of cutoffs, and Cohen's kappa.
// Everything is deterministic for a given seed.

export type LabelValue = "yes" | "no" | "unsure" | "pending";

/** Graded yes: core (founders and developers building with AI agents and automation) or adjacent. */
export type Grade = "core" | "adjacent";

/** mulberry32: a small seeded generator; the same seed gives the same draws on every platform. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fisher-Yates with a seeded generator; the input is not changed. */
export function seededShuffle<T>(values: ReadonlyArray<T>, seed: number): Array<T> {
  const out = [...values];
  const random = seededRandom(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Why a slot of a top 5 earns nothing, or `null` when it carries its topic's label. */
export type SlotZero = "empty" | "duplicate" | "unavailable_at_cutoff";

/**
 * One position of one arm's top 5 at one cutoff. `family` is null for an empty position. The
 * label is the topic's label at this cutoff (`null`: no judgement yet).
 */
export interface Slot {
  readonly arm: string;
  readonly cutoff: string;
  readonly position: number;
  readonly topicId: string | null;
  readonly family: string | null;
  readonly label: LabelValue | null;
  readonly grade: Grade | null;
  readonly zero: SlotZero | null;
}

/** Credit of a counted slot for a metric; the zero rules apply before it. */
export type Credit = (slot: Slot) => number;

/** G@5: core 1, adjacent 0.5, anything else 0 (a yes without grade cannot be graded: NaN). */
export const gradedCredit: Credit = (slot) => {
  if (slot.zero !== null || slot.label !== "yes") return 0;
  return slot.grade === "core" ? 1 : slot.grade === "adjacent" ? 0.5 : Number.NaN;
};

export const coreCredit: Credit = (slot) =>
  slot.zero === null && slot.label === "yes" && slot.grade === "core" ? 1 : 0;

/** Credit of a slot: 1 for a confirmed yes; an unresolved slot counts 1 only for the upper bound. */
export function slotCredit(slot: Slot, bound: "strict" | "upper"): number {
  if (slot.zero !== null) return 0;
  if (slot.label === "yes") return 1;
  if (slot.label === "no") return 0;
  return bound === "upper" ? 1 : 0;
}

/**
 * Builds the k slots of a top-k list. Positions beyond the list are empty; the second and later
 * positions of an opportunity already seen higher in the same list are duplicates (P1.1 rule 4).
 * The opportunity is the topic at this cutoff, merged with this cutoff's data only, so a later
 * cutoff never changes these credits (U1-B1); the family serves only the bootstrap.
 */
export function topSlots(
  arm: string,
  cutoff: string,
  entries: ReadonlyArray<{
    readonly topicId: string;
    readonly family: string;
    readonly label: LabelValue | null;
    readonly grade?: Grade | null;
    readonly unavailable: boolean;
    /** Set by the pool from a direct comparison within the arm; absent: same opportunity. */
    readonly duplicate?: boolean;
  }>,
  k: number,
): Array<Slot> {
  const seen = new Set<string>();
  return Array.from({ length: k }, (_, index): Slot => {
    const entry = entries[index];
    if (!entry) {
      return {
        arm,
        cutoff,
        position: index + 1,
        topicId: null,
        family: null,
        label: null,
        grade: null,
        zero: "empty",
      };
    }
    const duplicate = entry.duplicate ?? seen.has(entry.topicId);
    seen.add(entry.topicId);
    return {
      arm,
      cutoff,
      position: index + 1,
      topicId: entry.topicId,
      family: entry.family,
      label: entry.label,
      grade: entry.grade ?? null,
      zero: duplicate ? "duplicate" : entry.unavailable ? "unavailable_at_cutoff" : null,
    };
  });
}

/**
 * Weighted mean credit of an arm: sum of weight x credit over the sum of weights. With every
 * weight 1 it is the mean over cutoffs of P@k with denominator k, since each cutoff has k slots.
 */
export function weightedPrecision(
  slots: ReadonlyArray<Slot>,
  weightOf: (slot: Slot) => number,
  bound: "strict" | "upper" | Credit = "strict",
): number | null {
  const credit: Credit = typeof bound === "function" ? bound : (slot) => slotCredit(slot, bound);
  let num = 0;
  let den = 0;
  for (const slot of slots) {
    const w = weightOf(slot);
    if (w === 0) continue;
    num += w * credit(slot);
    den += w;
  }
  return den === 0 || Number.isNaN(num) ? null : num / den;
}

/**
 * Resampling unit of a slot for the family bootstrap: its family, or, for an empty position,
 * the cutoff (the empties of a cutoff move together, paired across arms).
 */
export const familyUnit = (slot: Slot): string => slot.family ?? `empty:${slot.cutoff}`;

export interface Interval {
  readonly low: number | null;
  readonly high: number | null;
}

export function percentile(sorted: ReadonlyArray<number>, q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const interval = (values: Array<number>, alpha: number): Interval => {
  values.sort((a, b) => a - b);
  return { low: percentile(values, alpha / 2), high: percentile(values, 1 - alpha / 2) };
};

/** Draws of a bootstrap: one weight map per replicate, from units to multiplicities. */
export type Draws = ReadonlyArray<ReadonlyMap<string, number>>;

/** Cluster bootstrap: each replicate draws as many units as there are, with replacement. */
export function unitDraws(units: ReadonlyArray<string>, replicates: number, seed: number): Draws {
  const sorted = [...new Set(units)].toSorted();
  const random = seededRandom(seed);
  return Array.from({ length: replicates }, () => {
    const weights = new Map<string, number>();
    for (let k = 0; k < sorted.length; k++) {
      const unit = sorted[Math.floor(random() * sorted.length)]!;
      weights.set(unit, (weights.get(unit) ?? 0) + 1);
    }
    return weights;
  });
}

/**
 * Moving blocks of `blockDays` calendar days (U1-S3): each replicate draws ceil(span / L)
 * windows [start, start + L) with start uniform from first - (L - 1) to last, so every day is
 * equally likely to be covered and the ends of the calendar never join. A cutoff's weight is the
 * number of drawn windows that contain it; a window over a gap without cutoffs adds nothing.
 */
export function blockDraws(
  cutoffs: ReadonlyArray<string>,
  blockDays: number,
  replicates: number,
  seed: number,
): Draws {
  const sorted = [...new Set(cutoffs)].toSorted();
  const random = seededRandom(seed);
  if (sorted.length === 0)
    return Array.from({ length: replicates }, () => new Map<string, number>());
  const dayMs = 86_400_000;
  const length = Math.max(1, blockDays);
  const days = sorted.map((c) => Date.parse(`${c.slice(0, 10)}T00:00:00Z`) / dayMs);
  const first = days[0]!;
  const last = days.at(-1)!;
  const span = last - first + 1;
  const blocks = Math.ceil(span / length);
  const starts = span + length - 1;
  return Array.from({ length: replicates }, () => {
    const weights = new Map<string, number>();
    for (let b = 0; b < blocks; b++) {
      const start = first - (length - 1) + Math.floor(random() * starts);
      days.forEach((d, k) => {
        if (d >= start && d < start + length)
          weights.set(sorted[k]!, (weights.get(sorted[k]!) ?? 0) + 1);
      });
    }
    return weights;
  });
}

/** Percentile interval of an arm's precision over the draws; `unitOf` maps a slot to its unit. */
export function bootstrapPrecision(
  slots: ReadonlyArray<Slot>,
  draws: Draws,
  unitOf: (slot: Slot) => string,
  alpha = 0.05,
  credit: Credit | "strict" = "strict",
): Interval {
  const values: Array<number> = [];
  for (const weights of draws) {
    const p = weightedPrecision(slots, (slot) => weights.get(unitOf(slot)) ?? 0, credit);
    if (p !== null) values.push(p);
  }
  return interval(values, alpha);
}

/** Paired interval of precision(a) - precision(b): both arms use the same draw. */
export function bootstrapDifference(
  a: ReadonlyArray<Slot>,
  b: ReadonlyArray<Slot>,
  draws: Draws,
  unitOf: (slot: Slot) => string,
  alpha = 0.05,
  credit: Credit | "strict" = "strict",
): Interval {
  const values: Array<number> = [];
  for (const weights of draws) {
    const w = (slot: Slot) => weights.get(unitOf(slot)) ?? 0;
    const pa = weightedPrecision(a, w, credit);
    const pb = weightedPrecision(b, w, credit);
    if (pa !== null && pb !== null) values.push(pa - pb);
  }
  return interval(values, alpha);
}

export interface Agreement {
  readonly n: number;
  readonly agreement: number | null;
  readonly kappa: number | null;
  /** Topics both labelled, left out because one side is unsure or pending. */
  readonly excluded: number;
}

/** Percent agreement and Cohen's kappa over the yes/no labels both labelers gave. */
export function cohenKappa(
  a: ReadonlyMap<string, LabelValue>,
  b: ReadonlyMap<string, LabelValue>,
): Agreement {
  let n = 0;
  let same = 0;
  let aYes = 0;
  let bYes = 0;
  let excluded = 0;
  for (const [key, la] of a) {
    const lb = b.get(key);
    if (lb === undefined) continue;
    if ((la !== "yes" && la !== "no") || (lb !== "yes" && lb !== "no")) {
      excluded++;
      continue;
    }
    n++;
    if (la === lb) same++;
    if (la === "yes") aYes++;
    if (lb === "yes") bYes++;
  }
  if (n === 0) return { n, agreement: null, kappa: null, excluded };
  const po = same / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  return { n, agreement: po, kappa: pe === 1 ? null : (po - pe) / (1 - pe), excluded };
}
