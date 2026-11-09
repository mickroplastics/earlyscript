// engine.v3, contract v4.2 §2.6 and §2.7: popularity percentiles, perennial antecedent and
// movement. Values come from config.trajectory and are frozen; the 0.5 of "en caída" and the
// 1.5 of "señal débil" are part of the rules, not parameters.
import type { Movement } from "@earlyscript/editorial-contracts/dossier";
import type { EngineConfig } from "@earlyscript/editorial-contracts/run";

import { DAY_MS } from "./days.ts";

export type TrajectoryConfig = NonNullable<EngineConfig["trajectory"]>;

export const FALLING_RATIO = 0.5;
export const FALLING_MIN_W1 = 3;
export const WEAK_GROWTH_RATIO = 1.5;
export const NEW_DAYS = 7;
export const GENERIC_SHARE = 0.02;

/** Linear interpolation between order statistics (type 7 of R); null without values. */
export function percentile(values: ReadonlyArray<number>, pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const h = (sorted.length - 1) * (pct / 100);
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}

export const heavyWeeks = (weeks: ReadonlyArray<number>, cfg: TrajectoryConfig): number =>
  weeks.slice(0, 5).filter((n) => n >= cfg.perennial_week_min).length;

/**
 * ≥ perennial_weeks weeks with n ≥ perennial_week_min in W0..W4, or n(vida) ≥ perennial_life
 * with some week before W1 (W2..W4) with n ≥ perennial_week_min. A mark, not a movement.
 */
export function perennialRule(
  weeks: ReadonlyArray<number>,
  life: number,
  cfg: TrajectoryConfig,
): "heavy_weeks" | "life" | null {
  if (heavyWeeks(weeks, cfg) >= cfg.perennial_weeks) return "heavy_weeks";
  if (life >= cfg.perennial_life && weeks.slice(2, 5).some((n) => n >= cfg.perennial_week_min))
    return "life";
  return null;
}

export interface MovementInput {
  readonly weeks: ReadonlyArray<number>;
  readonly firstMs: number | null;
  readonly cutoffMs: number;
  readonly pop: number;
  readonly p50: number | null;
  readonly p90: number | null;
}

/** §2.7, the first rule that holds wins. A missing percentile admits nothing. */
export function movementOf(input: MovementInput, cfg: TrajectoryConfig): Movement {
  const [n0 = 0, n1 = 0, n2 = 0, n3 = 0, n4 = 0] = input.weeks;
  if (n0 < FALLING_RATIO * n1 && n1 >= FALLING_MIN_W1) return "en_caida";
  if (n1 < n2 && n0 >= n1 && n0 >= cfg.min_items_w0 && [n1, n2, n3, n4].some((n) => n >= 5))
    return "rebote";
  if (
    input.firstMs !== null &&
    input.firstMs >= input.cutoffMs - NEW_DAYS * DAY_MS &&
    n0 >= cfg.min_items_w0
  )
    return "nueva";
  if (input.p90 !== null && input.pop >= input.p90 && n0 >= cfg.strong_min_items && n0 >= n1)
    return "senal_fuerte";
  if (
    input.p50 !== null &&
    input.pop >= input.p50 &&
    n0 >= cfg.min_items_w0 &&
    n0 < cfg.strong_min_items &&
    (n0 >= WEAK_GROWTH_RATIO * n1 || n1 === 0)
  )
    return "senal_debil";
  return "estable";
}

/** "En movimiento" admits these without perennial antecedent; with it they go to "De fondo". */
export const MOVING: ReadonlySet<Movement> = new Set([
  "nueva",
  "senal_debil",
  "senal_fuerte",
  "rebote",
]);
