import { useEffect } from "react";

/**
 * Spanish for the visible text of upstream's embedded browser, which has no translation layer.
 * Exact strings only, so nothing else on the page changes. The floating-preview control talks
 * about a chat a manual thread does not have; it is named for what it does here.
 */
const MANUAL_BROWSER_TEXT: Readonly<Record<string, string>> = {
  "Search or enter URL": "Busca o escribe una dirección",
  Back: "Atrás",
  Forward: "Adelante",
  Refresh: "Recargar",
  Navigation: "Navegación",
  "Open in system browser": "Abrir en el navegador del sistema",
  "Float preview over chat": "Ventana flotante del navegador",
  "Close floating preview": "Cerrar la ventana flotante",
  "Preview menu": "Menú del navegador",
  "Open separate preview window": "Abrir en una ventana aparte",
  "Close separate preview window": "Cerrar la ventana aparte",
  "Show device toolbar": "Mostrar la barra de dispositivo",
  "Hide device toolbar": "Ocultar la barra de dispositivo",
  "Zoom in": "Acercar",
  "Zoom out": "Alejar",
  "Reset zoom": "Restablecer el zoom",
  Zoom: "Zoom",
  Appearance: "Apariencia",
  Light: "Claro",
  Dark: "Oscuro",
  System: "Sistema",
  "Clear cache": "Borrar la caché",
  "Clear cookies": "Borrar las cookies",
  More: "Más",
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
const MANUAL_BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Remove (.+) from history$/, "Quitar $1 del historial"],
];

const ATTRIBUTES = ["aria-label", "placeholder", "title"] as const;

/** Text as React rendered it, whitespace folded, so a wrapped JSX string still matches. */
const fold = (value: string) => value.replace(/\s+/g, " ").trim();

function translate(value: string | null, text: Readonly<Record<string, string>>) {
  if (value === null) return undefined;
  const folded = fold(value);
  const exact = text[folded];
  if (exact !== undefined) return exact;
  for (const [pattern, replacement] of MANUAL_BROWSER_PATTERNS) {
    if (pattern.test(folded)) return folded.replace(pattern, replacement);
  }
  return undefined;
}

function translateNode(node: Node, text: Readonly<Record<string, string>>): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const translated = translate(node.nodeValue, text);
    if (translated !== undefined) node.nodeValue = translated;
    return;
  }
  if (!(node instanceof Element)) return;
  for (const attribute of ATTRIBUTES) {
    const translated = translate(node.getAttribute(attribute), text);
    if (translated !== undefined) node.setAttribute(attribute, translated);
  }
  for (const child of node.childNodes) translateNode(child, text);
}

/**
 * While mounted, rewrites the browser's English strings in the document, tooltips and menus
 * included, since they render in portals. React may set a string back on its next render; the
 * observer translates it again. A Spanish value is never a key, so this does not loop.
 */
export function useManualBrowserLocale(
  text: Readonly<Record<string, string>> = MANUAL_BROWSER_TEXT,
) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes DOM the upstream preview renders, outside React's tree for portals, and rewrites its text in place
  useEffect(() => {
    const root = document.body;
    translateNode(root, text);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          for (const added of record.addedNodes) translateNode(added, text);
        } else {
          translateNode(record.target, text);
        }
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTES],
    });
    return () => observer.disconnect();
  }, [text]);
}
