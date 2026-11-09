// Metrics of v3's development (contract v4.2 §4 and §5a): capture window and recall of
// takeoffs per list, own and paired anticipation against R2 with censoring, U@10 per arm and
// cutoff with validity and paired support, intervals by topic families and by 7-day blocks with
// Bonferroni over the four contrasts, and structural eligibility of the variants.
import { familiesOf } from "./gate.ts";
import { canonicalJson, sha256 } from "./hash.ts";
import { dayStart, DAY_MS, plusDays, type V3List, type V3Topic } from "./v3-data.ts";
import {
  type BagIndex,
  destinationOf,
  type ItemIndex,
  type Takeoff,
  V3_CUTOFFS,
} from "./v3-oracle.ts";

export const V3_VARIANTS = ["V1", "V2", "V3", "V4"] as const;
export type V3Variant = (typeof V3_VARIANTS)[number];
export const V3_REFERENCES = ["R4", "R2", "R5", "v1", "v2"] as const;
export const V3_ARMS = [...V3_VARIANTS, ...V3_REFERENCES] as const;
/** The four contrasts of the chosen variant (§5a), Bonferroni over them. */
export const V3_CONTRASTS = ["R4", "R2", "R5", "v2"] as const;

export const V3_CAPTURE = {
  regla:
    "una lista capta un despegue de fecha T si un tema de sus 10 primeros (para v3, «En movimiento») tiene por destino en la bolsa de T+7 el tema del despegue, en algún corte de [max(T−14, 4 oct), min(T+6, 30 oct)]",
  antes: 14,
  despues: 6,
  primer_corte_de_lista: "2026-10-04",
  ultimo_corte_de_lista: "2026-10-30",
  tamano_lista: 10,
  recall: "captados / despegues (desconocidos fuera del denominador y declarados)",
  anticipacion: "T − primer día de captación (negativo = tarde); ausencia = censura, contada",
  emparejada: "anticipación(brazo) − anticipación(R2) sobre los despegues que ambas captan, con n",
  evaluable_min_despegues: 15,
  subconjunto_seleccion: "despegues con include_score >= 0,40 en T",
  include_min_seleccion: 0.4,
} as const;

export const V3_RESAMPLING = {
  replicas: 2000,
  semilla: 20261109,
  familias:
    "familiesOf de gate.ts (P1.3/P2): tarjetas unidas entre cortes si comparten la mitad de los ítems de la menor",
  bloques_dias: 7,
  bloques: "blockDraws de P1.1: ventanas de 7 días con inicio uniforme en [primero − 6, último]",
  alfa: 0.05,
  bonferroni: 4,
  min_familias: 5,
} as const;
export const V3_RESAMPLING_HASH = sha256(canonicalJson(V3_RESAMPLING));

export const V3_ELIGIBILITY = {
  regla:
    "mediana sobre los 21 cortes (corte sin lista = 0 emitidas): >= 7 temas emitidos; >= 20 % de la lista con include_score >= 0,40; descartes solo por exclusión",
  min_emitidos: 7,
  min_share_include: 0.2,
  include_min: 0.4,
  razones_de_exclusion: ["exclude", "exclusion", "exclusión", "exclude_relative"],
} as const;

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const s = values.toSorted((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function quantiles(values: ReadonlyArray<number>) {
  if (values.length === 0) return { n: 0, q1: null, median: null, q3: null };
  const s = values.toSorted((a, b) => a - b);
  const q = (p: number) => {
    const h = (s.length - 1) * p;
    const lo = Math.floor(h);
    return s[lo]! + (h - lo) * (s[Math.min(lo + 1, s.length - 1)]! - s[lo]!);
  };
  return { n: s.length, q1: q(0.25), median: q(0.5), q3: q(0.75) };
}

/** The capture window of a takeoff, clipped to the computed lists and declared. */
export function captureWindow(T: string) {
  const from = plusDays(T, -V3_CAPTURE.antes);
  const to = plusDays(T, V3_CAPTURE.despues);
  const clippedFrom =
    from < V3_CAPTURE.primer_corte_de_lista ? V3_CAPTURE.primer_corte_de_lista : from;
  const clippedTo = to > V3_CAPTURE.ultimo_corte_de_lista ? V3_CAPTURE.ultimo_corte_de_lista : to;
  return { from: clippedFrom, to: clippedTo, clipped: clippedFrom !== from || clippedTo !== to };
}

export interface TakeoffCapture {
  readonly T: string;
  readonly topic_id: string;
  readonly include_score: number | null;
  readonly window: { readonly from: string; readonly to: string; readonly clipped: boolean };
  /** Arm -> first day of capture (null = censored). */
  readonly first: Readonly<Record<string, string | null>>;
  /** Arm -> T − first day (negative = late), null when censored. */
  readonly anticipation: Readonly<Record<string, number | null>>;
}

const daysBetween = (a: string, b: string) => Math.round((dayStart(b) - dayStart(a)) / DAY_MS);

/**
 * Capture of every takeoff by every arm. `listOf(arm, day)` gives A's list (null when absent),
 * `bagOf(day)` the bag index of that day.
 */
export function captures(options: {
  readonly takeoffs: ReadonlyArray<Takeoff>;
  readonly arms: ReadonlyArray<string>;
  readonly listOf: (arm: string, day: string) => V3List | null;
  readonly bagOf: (day: string) => BagIndex;
  readonly items: ItemIndex;
}): Array<TakeoffCapture> {
  return options.takeoffs.map((takeoff) => {
    const window = captureWindow(takeoff.T);
    const bag = options.bagOf(plusDays(takeoff.T, 7));
    const first: Record<string, string | null> = {};
    const anticipation: Record<string, number | null> = {};
    for (const arm of options.arms) {
      first[arm] = null;
      for (let d = window.from; d <= window.to; d = plusDays(d, 1)) {
        const list = options.listOf(arm, d);
        const top = (list?.moving ?? []).slice(0, V3_CAPTURE.tamano_lista);
        if (
          top.some((c) => destinationOf(c, d, bag, options.items)?.topic_id === takeoff.topic_id)
        ) {
          first[arm] = d;
          break;
        }
      }
      anticipation[arm] = first[arm] === null ? null : daysBetween(first[arm]!, takeoff.T);
    }
    return {
      T: takeoff.T,
      topic_id: takeoff.topic_id,
      include_score: takeoff.include_score,
      window,
      first,
      anticipation,
    };
  });
}

export interface RecallSummary {
  readonly takeoffs: number;
  readonly captured: number;
  readonly censored: number;
  readonly recall: number | null;
  readonly takeoffs_inc040: number;
  readonly captured_inc040: number;
  readonly recall_inc040: number | null;
  readonly on_or_before_T: number;
  readonly late: number;
  readonly anticipation: ReturnType<typeof quantiles>;
  readonly paired_vs_R2: ReturnType<typeof quantiles> & { readonly censored_either: number };
}

export function recallOf(rows: ReadonlyArray<TakeoffCapture>, arm: string): RecallSummary {
  const got = rows.filter((r) => r.anticipation[arm] !== null && r.anticipation[arm] !== undefined);
  const inc = rows.filter((r) => (r.include_score ?? -1) >= V3_CAPTURE.include_min_seleccion);
  const incGot = inc.filter((r) => r.anticipation[arm] != null);
  const values = got.map((r) => r.anticipation[arm]!);
  const both = rows.filter((r) => r.anticipation[arm] != null && r.anticipation["R2"] != null);
  return {
    takeoffs: rows.length,
    captured: got.length,
    censored: rows.length - got.length,
    recall: rows.length === 0 ? null : got.length / rows.length,
    takeoffs_inc040: inc.length,
    captured_inc040: incGot.length,
    recall_inc040: inc.length === 0 ? null : incGot.length / inc.length,
    on_or_before_T: values.filter((v) => v >= 0).length,
    late: values.filter((v) => v < 0).length,
    anticipation: quantiles(values),
    paired_vs_R2: {
      ...quantiles(both.map((r) => r.anticipation[arm]! - r.anticipation["R2"]!)),
      censored_either: rows.length - both.length,
    },
  };
}

/** §4: recall is evaluable with >= 15 takeoffs and a non-zero denominator in the subset used. */
export const recallEvaluable = (takeoffs: number, subsetDenominator: number) =>
  takeoffs >= V3_CAPTURE.evaluable_min_despegues && subsetDenominator > 0;

/** One card the judges scored (B: judge-score output). */
export interface JudgedCard {
  readonly topic_id: string;
  readonly item_ids: ReadonlyArray<string>;
  readonly utility_opus: number | null;
  readonly utility_sol: number | null;
}
/** One arm's cards at one cutoff, "En movimiento" only. */
export interface JudgedCut {
  readonly arm: string;
  readonly cutoff: string;
  readonly emitted: number;
  readonly cards: ReadonlyArray<JudgedCard>;
}

export const cardUtility = (c: JudgedCard) =>
  c.utility_opus === null || c.utility_sol === null ? null : (c.utility_opus + c.utility_sol) / 2;

/** Valid for an arm: >= 5 cards emitted and both judges answered every one. */
export const validCut = (cut: JudgedCut) =>
  cut.emitted >= 5 &&
  cut.cards.length === cut.emitted &&
  cut.cards.every((c) => cardUtility(c) !== null);

export const u10 = (cut: JudgedCut): number | null => {
  if (!validCut(cut)) return null;
  const values = cut.cards.map((c) => cardUtility(c)!);
  return values.reduce((a, b) => a + b, 0) / values.length;
};

export type JudgedIndex = ReadonlyMap<string, ReadonlyMap<string, JudgedCut>>;
export function judgedIndex(cuts: ReadonlyArray<JudgedCut>): JudgedIndex {
  const out = new Map<string, Map<string, JudgedCut>>();
  for (const cut of cuts) {
    let arm = out.get(cut.arm);
    if (!arm) out.set(cut.arm, (arm = new Map()));
    if (arm.has(cut.cutoff)) throw new Error(`U@10: ${cut.arm} ${cut.cutoff} twice`);
    arm.set(cut.cutoff, cut);
  }
  return out;
}

/** The paired support: cutoffs valid for every arm compared. */
export function pairedSupport(
  index: JudgedIndex,
  arms: ReadonlyArray<string>,
  cutoffs: ReadonlyArray<string> = V3_CUTOFFS,
): Array<string> {
  return cutoffs.filter((d) =>
    arms.every((arm) => {
      const cut = index.get(arm)?.get(d);
      return cut !== undefined && validCut(cut);
    }),
  );
}

export function meanU10(index: JudgedIndex, arm: string, support: ReadonlyArray<string>) {
  if (support.length === 0) return null;
  const values = support.map((d) => u10(index.get(arm)!.get(d)!)!);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** mulberry32, the generator of editorial-stats.ts (same seed, same draws). */
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

const percentile = (sorted: ReadonlyArray<number>, q: number): number | null => {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

type Draws = ReadonlyArray<ReadonlyMap<string, number>>;

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

/** The 7-day moving blocks of editorial-stats.ts blockDraws; `starts` lists the drawn window starts. */
export function blockDraws(
  cutoffs: ReadonlyArray<string>,
  blockDays: number,
  replicates: number,
  seed: number,
  starts?: Array<Array<number>>,
): Draws {
  const sorted = [...new Set(cutoffs)].toSorted();
  const random = seededRandom(seed);
  if (sorted.length === 0)
    return Array.from({ length: replicates }, () => new Map<string, number>());
  const length = Math.max(1, blockDays);
  const days = sorted.map((c) => dayStart(c) / DAY_MS);
  const first = days[0]!;
  const span = days.at(-1)! - first + 1;
  const blocks = Math.ceil(span / length);
  const possible = span + length - 1;
  return Array.from({ length: replicates }, () => {
    const weights = new Map<string, number>();
    const drawn: Array<number> = [];
    for (let b = 0; b < blocks; b++) {
      const start = first - (length - 1) + Math.floor(random() * possible);
      drawn.push(start);
      days.forEach((d, k) => {
        if (d >= start && d < start + length)
          weights.set(sorted[k]!, (weights.get(sorted[k]!) ?? 0) + 1);
      });
    }
    starts?.push(drawn);
    return weights;
  });
}

export interface Interval {
  readonly low: number | null;
  readonly high: number | null;
  readonly estimable: boolean;
  readonly units: number;
}

const intervalOf = (
  values: Array<number>,
  alpha: number,
  units: number,
  minUnits: number,
): Interval => {
  values.sort((a, b) => a - b);
  const degenerate = values.length === 0 || values[0] === values.at(-1);
  if (units < minUnits || degenerate) return { low: null, high: null, estimable: false, units };
  return {
    low: percentile(values, alpha / 2),
    high: percentile(values, 1 - alpha / 2),
    estimable: true,
    units,
  };
};

/**
 * U@10(a) − U@10(b) on the paired support, its family interval and its block interval, at the
 * Bonferroni level. A family is a set of cards (of both arms, all support cutoffs) linked by
 * shared items; a replicate weights each card by its family's draw and each cutoff mean is the
 * weighted mean of its cards; a cutoff left without weight for either arm drops for both.
 */
export function u10Contrast(
  index: JudgedIndex,
  a: string,
  b: string,
  cutoffs: ReadonlyArray<string> = V3_CUTOFFS,
) {
  const support = pairedSupport(index, [a, b], cutoffs);
  const ma = meanU10(index, a, support);
  const mb = meanU10(index, b, support);
  const diff = ma === null || mb === null ? null : ma - mb;
  const members = support.flatMap((d) =>
    [a, b].flatMap((arm) =>
      index
        .get(arm)!
        .get(d)!
        .cards.map((card, k) => ({
          card_id: `${arm}\n${d}\n${k}`,
          item_ids: [...card.item_ids],
          arm,
          d,
          u: cardUtility(card)!,
        })),
    ),
  );
  const families = familiesOf(members);
  const alpha = V3_RESAMPLING.alfa / V3_RESAMPLING.bonferroni;
  const famUnits = [...new Set(families.values())];
  const famValues: Array<number> = [];
  for (const w of unitDraws(famUnits, V3_RESAMPLING.replicas, V3_RESAMPLING.semilla)) {
    let total = 0;
    let n = 0;
    for (const d of support) {
      const mean = (arm: string) => {
        let s = 0;
        let ws = 0;
        for (const m of members)
          if (m.arm === arm && m.d === d) {
            const weight = w.get(families.get(m.card_id)!) ?? 0;
            s += weight * m.u;
            ws += weight;
          }
        return ws === 0 ? null : s / ws;
      };
      const x = mean(a);
      const y = mean(b);
      if (x === null || y === null) continue;
      total += x - y;
      n++;
    }
    if (n > 0) famValues.push(total / n);
  }
  const blockValues: Array<number> = [];
  const perCut = new Map(
    support.map((d) => [d, u10(index.get(a)!.get(d)!)! - u10(index.get(b)!.get(d)!)!]),
  );
  for (const w of blockDraws(
    support,
    V3_RESAMPLING.bloques_dias,
    V3_RESAMPLING.replicas,
    V3_RESAMPLING.semilla,
  )) {
    let total = 0;
    let ws = 0;
    for (const [d, v] of perCut) {
      const weight = w.get(d) ?? 0;
      total += weight * v;
      ws += weight;
    }
    if (ws > 0) blockValues.push(total / ws);
  }
  return {
    a,
    b,
    support: support.length,
    support_cutoffs: support,
    u10_a: ma,
    u10_b: mb,
    diff,
    families: intervalOf(famValues, alpha, famUnits.length, V3_RESAMPLING.min_familias),
    blocks: intervalOf(blockValues, alpha, support.length, 1),
    alpha,
  };
}

const isExclusion = (reason: string) =>
  (V3_ELIGIBILITY.razones_de_exclusion as ReadonlyArray<string>).includes(reason.toLowerCase());

export function eligibility(
  listsOfVariant: ReadonlyMap<string, V3List | null>,
  cutoffs: ReadonlyArray<string> = V3_CUTOFFS,
) {
  const emitted: Array<number> = [];
  const shares: Array<number> = [];
  const otherDiscards = new Set<string>();
  let missingDiscards = 0;
  for (const d of cutoffs) {
    const list = listsOfVariant.get(d) ?? null;
    const moving: ReadonlyArray<V3Topic> = list?.moving.slice(0, V3_CAPTURE.tamano_lista) ?? [];
    emitted.push(moving.length);
    shares.push(
      moving.length === 0
        ? 0
        : moving.filter((t) => (t.include_score ?? -1) >= V3_ELIGIBILITY.include_min).length /
            moving.length,
    );
    if (list && (list.discards === null || list.discards === undefined)) missingDiscards++;
    for (const [reason, n] of Object.entries(list?.discards ?? {}))
      if (n > 0 && !isExclusion(reason)) otherDiscards.add(reason);
  }
  const medEmitted = median(emitted) ?? 0;
  const medShare = median(shares) ?? 0;
  const discardsOk = otherDiscards.size === 0 && missingDiscards === 0;
  return {
    median_emitted: medEmitted,
    median_share_include_040: medShare,
    discards_only_exclusion: discardsOk,
    other_discard_reasons: [...otherDiscards].toSorted(),
    cutoffs_without_discards_field: missingDiscards,
    eligible:
      medEmitted >= V3_ELIGIBILITY.min_emitidos &&
      medShare >= V3_ELIGIBILITY.min_share_include &&
      discardsOk,
  };
}

/** Recall interval by 7-day blocks of takeoff dates (descriptive). */
export function recallBlocks(rows: ReadonlyArray<TakeoffCapture>, arm: string) {
  const byDay = new Map<string, { n: number; got: number }>();
  for (const r of rows) {
    const x = byDay.get(r.T) ?? { n: 0, got: 0 };
    x.n++;
    if (r.anticipation[arm] != null) x.got++;
    byDay.set(r.T, x);
  }
  const values: Array<number> = [];
  for (const w of blockDraws([...byDay.keys()], 7, V3_RESAMPLING.replicas, V3_RESAMPLING.semilla)) {
    let n = 0;
    let got = 0;
    for (const [d, x] of byDay) {
      const weight = w.get(d) ?? 0;
      n += weight * x.n;
      got += weight * x.got;
    }
    if (n > 0) values.push(got / n);
  }
  return intervalOf(values, V3_RESAMPLING.alfa, byDay.size, 1);
}
