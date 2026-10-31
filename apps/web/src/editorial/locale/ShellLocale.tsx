import { useRef, type RefObject } from "react";

import { MANUAL_BROWSER_TABLE } from "../manualBrowserLocale";
import { makeTranslator, useScopedLocale, type ScopedLocaleOptions } from "./scopedLocale";
import { RELATIVE_TIME_TABLE } from "./shellRelativeTime";
import { SETTINGS_TABLE, SHELL_COMMON_TABLE, SIDEBAR_TABLE, THREAD_TABLE } from "./shellText";

/**
 * The shell's three scopes. Each translates only its containers and the portals opened from
 * them, and never what the operator or an agent wrote: titles and names (`dir`, set by upstream
 * on user text), messages, the composer's editor, code and Earlyscript's own spaces. Inputs
 * have no text nodes; only their placeholder and label are rewritten, never their value.
 */
const USER_TEXT = ["[dir]:not(html):not(body)", "[contenteditable]", "pre", "code", "kbd"].join(
  ", ",
);

export const SIDEBAR_LOCALE: ScopedLocaleOptions = {
  translate: makeTranslator([SHELL_COMMON_TABLE, SIDEBAR_TABLE, RELATIVE_TIME_TABLE]),
  // The whole upstream sidebar, resize rail included, the floating toggle beside it, and the
  // app's toast viewport for the titles of what thread actions report.
  roots: (anchor) =>
    [
      anchor.closest("[data-app-sidebar]") ?? anchor,
      document.querySelector("[data-sidebar-control]"),
    ].filter((root): root is Element => root !== null),
  lateRoots: '[data-slot="toast-viewport"]',
  skip: [
    USER_TEXT,
    // Descriptions can carry the server's messages, which stay as sent.
    '[data-slot="toast-description"]',
    '[data-editorial-space="trends"]',
    '[data-editorial-space="results"]',
    "[data-thread-item] .sr-only",
  ].join(", "),
};

export const THREAD_LOCALE: ScopedLocaleOptions = {
  translate: makeTranslator([
    SHELL_COMMON_TABLE,
    THREAD_TABLE,
    RELATIVE_TIME_TABLE,
    MANUAL_BROWSER_TABLE,
  ]),
  roots: (anchor) => [anchor],
  skip: [
    USER_TEXT,
    "[data-timeline-row-id]",
    '[data-slot="workspace-breadcrumb-text"]',
    ".xterm",
  ].join(", "),
};

export const SETTINGS_LOCALE: ScopedLocaleOptions = {
  translate: makeTranslator([SHELL_COMMON_TABLE, SETTINGS_TABLE, RELATIVE_TIME_TABLE]),
  // Settings render in a route modal portal; the anchor sits in its navigation.
  roots: (anchor) => [anchor.closest('[role="dialog"]') ?? anchor.parentElement ?? anchor],
  skip: USER_TEXT,
};

/** The sidebar scope, anchored on an element inside `[data-app-sidebar]`. */
export function useSidebarLocale(anchor: RefObject<Element | null>): void {
  useScopedLocale(anchor, SIDEBAR_LOCALE);
}

/** The thread area scope: header, empty states, composer, panels of an upstream thread. */
export function useThreadAreaLocale(anchor: Element | null): void {
  useScopedLocale(anchor, THREAD_LOCALE);
}

/**
 * Mounted once in the settings navigation: translates the settings modal while it is open.
 * Renders a hidden anchor only.
 */
export function SettingsLocale() {
  const anchor = useRef<HTMLSpanElement>(null);
  useScopedLocale(anchor, SETTINGS_LOCALE);
  return <span ref={anchor} hidden data-earlyscript-locale="settings" />;
}
