// Additive score with reference zero, ported from Earlywindow's src/engine/rank.ts (step 9):
// each component's contribution is its explanation. A null value adds 0.
import type { RankComponent } from "@earlyscript/editorial-contracts/dossier";

import { dot } from "./cluster.ts";

export const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export interface Scored {
  readonly method: string;
  readonly score: number;
  readonly components: Array<RankComponent>;
}

export function score(
  method: string,
  weights: Readonly<Record<string, number>>,
  values: Readonly<Record<string, number | null>>,
): Scored {
  const components = Object.entries(weights).map(([name, weight]): RankComponent => {
    const raw = values[name];
    if (raw === undefined) throw new Error(`rank weight ${name} has no value`);
    const value = raw === null ? null : round6(raw);
    return { name, value, weight, contribution: value === null ? 0 : round6(weight * value) };
  });
  return {
    method,
    score: round6(components.reduce((sum, c) => sum + c.contribution, 0)),
    components,
  };
}

/** 1-based positions by score desc, then id asc. */
export function positions<T extends { readonly id: string }>(
  entries: ReadonlyArray<T>,
  scoreOf: (entry: T) => number,
): Map<string, number> {
  const ordered = entries.toSorted(
    (a, b) => scoreOf(b) - scoreOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return new Map(ordered.map((entry, index) => [entry.id, index + 1]));
}

/**
 * Walks `ordered` best first and keeps an entry unless it is the same topic (`same`, the
 * engine's topic identity) as one already kept (`alreadyKept` first, then earlier entries); a
 * folded entry is linked to the matching kept one with the highest cosine.
 */
export function dedupe<T extends { readonly id: string }>(
  ordered: ReadonlyArray<T>,
  alreadyKept: ReadonlyArray<T>,
  vectorOf: (entry: T) => Float32Array,
  same: (entry: T, kept: T) => boolean,
): { kept: Array<T>; related: Array<[string, { signal: T; cosine: number }]> } {
  const pool = [...alreadyKept];
  const kept: Array<T> = [];
  const related: Array<[string, { signal: T; cosine: number }]> = [];
  for (const entry of ordered) {
    let best: { primary: T; cosine: number } | null = null;
    for (const primary of pool) {
      if (!same(entry, primary)) continue;
      const cosine = dot(vectorOf(entry), vectorOf(primary));
      if (best === null || cosine > best.cosine) best = { primary, cosine };
    }
    if (best) related.push([best.primary.id, { signal: entry, cosine: best.cosine }]);
    else {
      kept.push(entry);
      pool.push(entry);
    }
  }
  return { kept, related };
}
