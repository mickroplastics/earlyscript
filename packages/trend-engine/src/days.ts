// @effect-diagnostics globalDate:off - pure date arithmetic on ISO strings.
export const DAY_MS = 86_400_000;

export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function dayStart(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(ms) || dayOf(ms) !== day) {
    throw new Error(`Invalid UTC day: ${day}`);
  }
  return ms;
}

/** UTC days from `from` (inclusive) to `to` (exclusive). */
export function daysBetween(from: string, to: string): Array<string> {
  const days: Array<string> = [];
  for (let ms = dayStart(from), end = dayStart(to); ms < end; ms += DAY_MS) days.push(dayOf(ms));
  return days;
}

/** The `count` UTC days that end the day before `cutoffDay`, oldest first. */
export function daysBefore(cutoffDay: string, count: number): Array<string> {
  const end = dayStart(cutoffDay);
  return Array.from({ length: count }, (_, i) => dayOf(end - (count - i) * DAY_MS));
}
