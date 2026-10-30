// Additive score with reference zero, ported from Earlywindow's src/engine/rank.ts (step 9):
// each component's contribution is its explanation. A null value adds 0.
import type { RankComponent } from "@earlyscript/editorial-contracts/dossier";

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
