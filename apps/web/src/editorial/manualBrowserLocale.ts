import type { RefObject } from "react";

import {
  makeTranslator,
  useScopedLocale,
  type LocalePattern,
  type LocaleTable,
  type ScopedLocaleOptions,
} from "./locale/scopedLocale";

/**
 * Spanish for the visible text of upstream's embedded browser, which has no translation layer.
 * Exact strings only, so nothing else changes. No value is also a key and none maps to itself
 * (Zoom stays as it is): a rewrite can never trigger another. The floating-preview control talks
 * about a chat a manual thread does not have; it is named for what it does here.
 */
export const MANUAL_BROWSER_TEXT: Readonly<Record<string, string>> = {
  "Search or enter URL": "Busca o escribe una dirección",
  Back: "Atrás",
  Forward: "Adelante",
  Refresh: "Recargar",
  Stop: "Detener",
  "Loading…": "Cargando…",
  Navigation: "Navegación",
  "Open in system browser": "Abrir en el navegador del sistema",
  "Float preview over chat": "Ventana flotante del navegador",
  "Close floating preview": "Cerrar la ventana flotante",
  "Preview menu": "Menú del navegador",
  More: "Más",
  "Hard reload": "Recargar sin caché",
  "Open DevTools": "Abrir las herramientas de desarrollo",
  "Open separate preview window": "Abrir en una ventana aparte",
  "Close separate preview window": "Cerrar la ventana aparte",
  "Show device toolbar": "Mostrar la barra de dispositivo",
  "Hide device toolbar": "Ocultar la barra de dispositivo",
  Appearance: "Apariencia",
  Light: "Claro",
  Dark: "Oscuro",
  System: "Sistema",
  "Zoom in": "Acercar",
  "Zoom out": "Alejar",
  "Reset zoom": "Restablecer el zoom",
  "Profile:": "Perfil:",
  "Clear cookies": "Borrar las cookies",
  "Clear cache": "Borrar la caché",
  "You have control": "Tienes el control",
  "Agent has control": "Un agente tiene el control",
  "Another viewer has control": "Otra vista tiene el control",
  Watching: "Observando",
  "Read-only": "Solo lectura",
  "Connecting...": "Conectando…",
  "Release control": "Soltar el control",
  "Take control": "Tomar el control",
  "Take control to respond.": "Toma el control para responder.",
  "Browser page": "Página del navegador",
  "Local servers": "Servidores locales",
  "Recently used": "Usadas hace poco",
  "No preview yet": "Ninguna página abierta",
  "Select a live local server to open it in this browser tab.":
    "Elige un servidor local activo para abrirlo en esta pestaña.",
  "Type a URL above, or run a dev script. Browser-ready localhost servers will show up here automatically.":
    "Escribe una dirección arriba. Los servidores locales activos aparecen aquí solos.",
};

/** Strings with a value inside: the recent-pages list of the empty browser. */
const MANUAL_BROWSER_PATTERNS: ReadonlyArray<LocalePattern> = [
  [/^Remove (.+) from history$/, "Quitar $1 del historial"],
];

export const MANUAL_BROWSER_TABLE: LocaleTable = {
  text: MANUAL_BROWSER_TEXT,
  patterns: MANUAL_BROWSER_PATTERNS,
};

/**
 * The Spanish for a string, its surrounding whitespace kept (`Profile: ` then the name), or
 * undefined when it has none or it would not change.
 */
export const translateBrowserText = makeTranslator([MANUAL_BROWSER_TABLE]);

const MANUAL_BROWSER_LOCALE: ScopedLocaleOptions = {
  translate: translateBrowserText,
  roots: (container) => [container],
};

/**
 * Translates the embedded browser while the manual workspace is mounted, inside the workspace
 * and in the portals (menus, tooltips) it opens, and puts every rewritten string back when it
 * unmounts (`useScopedLocale`).
 */
export function useManualBrowserLocale(container: RefObject<HTMLElement | null>): void {
  useScopedLocale(container, MANUAL_BROWSER_LOCALE);
}
