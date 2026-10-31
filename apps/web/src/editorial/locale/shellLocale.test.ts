import { describe, expect, it } from "vite-plus/test";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { MANUAL_BROWSER_TABLE } from "../manualBrowserLocale";
import { makeTranslator, type LocaleTable } from "./scopedLocale";
import { relativeTimeEs, RELATIVE_TIME_TABLE } from "./shellRelativeTime";
import { SETTINGS_LOCALE, SIDEBAR_LOCALE, THREAD_LOCALE } from "./ShellLocale";
import {
  SETTINGS_TABLE,
  SHELL_COMMON_TABLE,
  SIDEBAR_TABLE,
  THREAD_TABLE,
  snoozeMenuLabel,
} from "./shellText";

const TABLES: ReadonlyArray<LocaleTable> = [
  SHELL_COMMON_TABLE,
  SIDEBAR_TABLE,
  THREAD_TABLE,
  SETTINGS_TABLE,
  MANUAL_BROWSER_TABLE,
];
const ALL_TEXT = TABLES.flatMap((table) => Object.entries(table.text ?? {}));
const ALL_KEYS = new Set(ALL_TEXT.map(([key]) => key));

/** Strings each pattern is written for, as upstream renders them. */
const PATTERN_SAMPLES = [
  "New thread in server",
  "New thread, server",
  "New thread on es/shell-es",
  "Filter by server",
  "Filter threads by project: server, tesis",
  "Project settings for server",
  'Delete thread "Plan del video"?',
  "Settle (3)",
  "Snooze (2)",
  "Mark unread (2)",
  "Delete (4)",
  "Thread actions for Plan del video",
  "Run context: agents, Current checkout",
  "Effort: Medium · Permissions: Full access · Ctrl+Shift+A",
  "Effort: High · Permissions: Supervised",
  "Permissions: Full access",
  "Use Ocean light mode",
  "Use Ocean dark mode",
  "Use Ocean theme",
  "Duplicate Ocean",
  "Thread details: 9 of 10 on",
  "Project scope: All projects",
  "Environment scope: agents",
  "Select Codex",
  "Enable Claude",
  "Add accent color for Codex",
  "Add GPT-6-Astra to favorites",
  "Move GPT-6-Astra up",
  "Move GPT-6-Astra down",
  "Show GPT-6-Astra in the model picker",
  "Authenticated · ChatGPT Pro 200 Subscription",
  "Fast mode · Reasoning",
  "In 1 hour (6:15 p. m.)",
  "Tomorrow (9:00 a. m.)",
  "Remove github.com/trending from history",
];

const SCOPES = { sidebar: SIDEBAR_LOCALE, thread: THREAD_LOCALE, settings: SETTINGS_LOCALE };

describe("shell locale tables", () => {
  it("never map a string to itself, and no value is a key of any table", () => {
    for (const [key, value] of ALL_TEXT) {
      expect(value, key).not.toBe(key);
      expect(ALL_KEYS.has(value), `${key} → ${value}`).toBe(false);
    }
  });

  it("give one Spanish per key across tables", () => {
    const seen = new Map<string, string>();
    for (const [key, value] of ALL_TEXT) {
      const previous = seen.get(key);
      // The same English may differ by zone only where the zone says so.
      if (previous !== undefined && previous !== value) {
        expect(["Enabled", "Disabled"]).toContain(key);
      }
      seen.set(key, value);
    }
  });

  it("translate each pattern once, and never their own output", () => {
    for (const [name, scope] of Object.entries(SCOPES)) {
      for (const value of [...ALL_KEYS, ...PATTERN_SAMPLES]) {
        const once = scope.translate(value);
        if (once === undefined) continue;
        expect(scope.translate(once), `${name}: ${value} → ${once}`).toBeUndefined();
      }
    }
  });

  it("keep names, models and user text inside patterns", () => {
    const thread = THREAD_LOCALE.translate;
    expect(thread("Thread actions for New thread")).toBe("Acciones del hilo New thread");
    expect(thread("Effort: Medium · Permissions: Full access · Ctrl+Shift+A")).toBe(
      "Esfuerzo: Medio · Permisos: Acceso total · Ctrl+Shift+A",
    );
    expect(SIDEBAR_LOCALE.translate('Delete thread "Settle"?')).toBe("¿Borrar el hilo «Settle»?");
    expect(SETTINGS_LOCALE.translate("Show GPT-6-Astra in the model picker")).toBe(
      "Mostrar GPT-6-Astra en el selector de modelos",
    );
    // Names are never keys.
    for (const name of ["GPT-6-Astra", "Codex", "Claude", "Ocean", "server", "Max", "Ultra"]) {
      expect(THREAD_LOCALE.translate(name), name).toBeUndefined();
      expect(SETTINGS_LOCALE.translate(name), name).toBeUndefined();
    }
  });

  it("keep surrounding whitespace and leave unknown strings alone", () => {
    expect(THREAD_LOCALE.translate(" in")).toBe(" en");
    expect(SIDEBAR_LOCALE.translate("  Settled ")).toBe("  Resueltos ");
    expect(SIDEBAR_LOCALE.translate("Something upstream added")).toBeUndefined();
    expect(makeTranslator([])("Settled")).toBeUndefined();
  });

  it("reuse the fork's snooze labels in the row menu", () => {
    expect(snoozeMenuLabel("In 3 hours (8:15 p. m.)")).toBe("En 3 horas (8:15 p. m.)");
    expect(snoozeMenuLabel("Next week")).toBe("La próxima semana");
    expect(snoozeMenuLabel("Toggle main sidebar (Ctrl+B)")).toBe("Toggle main sidebar (Ctrl+B)");
  });
});

describe("relativeTimeEs", () => {
  /** The sidebar's private compaction (`SidebarThreadRow.tsx`, `compactSidebarTimeLabel`). */
  const compact = (label: string) =>
    label === "just now" ? "now" : label.endsWith(" ago") ? label.slice(0, -4) : label;

  it("translates every form upstream's formatter produces", () => {
    const now = Date.parse("2026-10-31T17:00:00.000Z");
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [10_000, "ahora mismo", "ahora"],
      [42 * 60_000, "hace 42 min", "42 min"],
      [3 * 3_600_000, "hace 3 h", "3 h"],
      [2 * 86_400_000, "hace 2 d", "2 d"],
      [400 * 86_400_000, "hace 400 d", "400 d"],
    ];
    for (const [elapsed, full, short] of cases) {
      const label = formatRelativeTimeLabel(new Date(now - elapsed).toISOString(), now);
      expect(relativeTimeEs(label), label).toBe(full);
      expect(relativeTimeEs(compact(label)), compact(label)).toBe(short);
    }
  });

  it("leaves anything else as it is", () => {
    for (const value of ["42", "m", "42 ago", "hace 42 min", "GPT-6"]) {
      expect(relativeTimeEs(value)).toBe(value);
    }
    expect(makeTranslator([RELATIVE_TIME_TABLE])("hace 42 min")).toBeUndefined();
  });
});
