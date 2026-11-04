import type { LocaleTable } from "./scopedLocale";

/**
 * Spanish for what upstream's `timestampFormat.ts` writes («42m ago», the sidebar's «42m»).
 * Its callers rely on the English (the sidebar trims « ago»), so the output is translated
 * where shown; `shellLocale.test.ts` runs the real formatter, so a format change fails there.
 */
const UNITS: Readonly<Record<string, string>> = { s: "s", m: "min", h: "h", d: "d" };

export function relativeTimeEs(value: string): string {
  const yesterday = /^yesterday at (.+)$/.exec(value);
  if (yesterday) return `ayer, ${relativeTimeEs(yesterday[1] ?? "")}`;
  const time = /^(\d{1,2}):(\d{2})\s*([AP]M)$/.exec(value);
  if (time)
    return `${String((Number(time[1]) % 12) + (time[3] === "PM" ? 12 : 0)).padStart(2, "0")}:${time[2]}`;
  if (value === "just now") return "ahora mismo";
  if (value === "now") return "ahora";
  const ago = /^(\d+)([mhd]) ago$/.exec(value);
  if (ago !== null) return `hace ${ago[1]} ${UNITS[ago[2] ?? ""]}`;
  const compact = /^(\d+)([smhd])$/.exec(value);
  if (compact !== null) return `${compact[1]} ${UNITS[compact[2] ?? ""]}`;
  return value;
}

export const RELATIVE_TIME_TABLE: LocaleTable = { functions: [relativeTimeEs] };
