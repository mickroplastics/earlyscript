import { useEffect, type RefObject } from "react";

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
const MANUAL_BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Remove (.+) from history$/, "Quitar $1 del historial"],
];

const ATTRIBUTES = ["aria-label", "placeholder", "title"] as const;

/** A portal opened this long after an interaction inside the workspace belongs to it. */
const PORTAL_WINDOW_MS = 2_000;

/**
 * The Spanish for a string, its surrounding whitespace kept (`Profile: ` then the name), or
 * undefined when it has none or it would not change.
 */
export function translateBrowserText(value: string | null): string | undefined {
  if (value === null) return undefined;
  const folded = value.replace(/\s+/g, " ").trim();
  if (folded.length === 0) return undefined;
  let translated: string | undefined = MANUAL_BROWSER_TEXT[folded];
  if (translated === undefined) {
    const pattern = MANUAL_BROWSER_PATTERNS.find(([regex]) => regex.test(folded));
    translated = pattern === undefined ? undefined : folded.replace(pattern[0], pattern[1]);
  }
  if (translated === undefined) return undefined;
  const lead = /^\s*/.exec(value)?.[0] ?? "";
  const trail = /\s*$/.exec(value)?.[0] ?? "";
  const next = `${lead}${translated}${trail}`;
  return next === value ? undefined : next;
}

interface Rewrite {
  readonly original: string;
  readonly written: string;
}

/**
 * Translates the embedded browser while the manual workspace is mounted, inside the workspace
 * and in the portals (menus, tooltips) it opens, and puts every rewritten string back when it
 * unmounts. Writes only when a value changes, with the observer disconnected, so a mutation it
 * makes never reaches it.
 */
export function useManualBrowserLocale(container: RefObject<HTMLElement | null>): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes DOM the upstream preview renders, including portals outside this component's tree, and rewrites its text in place
  useEffect(() => {
    const root = container.current;
    if (root === null) return;
    const texts = new Map<Text, Rewrite>();
    const attributes = new Map<Element, Map<string, Rewrite>>();
    const portals = new Set<Element>();
    let lastInsideAt = Number.NEGATIVE_INFINITY;
    let lastWasInside = false;

    const isInside = (node: Node | null) =>
      node !== null &&
      (root.contains(node) || [...portals].some((portal) => portal.contains(node)));

    const translateTree = (node: Node) => {
      if (node instanceof Text) {
        const next = translateBrowserText(node.nodeValue);
        if (next === undefined) return;
        texts.set(node, {
          original: texts.get(node)?.original ?? node.nodeValue ?? "",
          written: next,
        });
        node.nodeValue = next;
        return;
      }
      if (!(node instanceof Element)) return;
      for (const name of ATTRIBUTES) {
        const value = node.getAttribute(name);
        const next = translateBrowserText(value);
        if (next === undefined || value === null) continue;
        const byName = attributes.get(node) ?? new Map<string, Rewrite>();
        byName.set(name, { original: byName.get(name)?.original ?? value, written: next });
        attributes.set(node, byName);
        node.setAttribute(name, next);
      }
      for (const child of node.childNodes) translateTree(child);
    };

    const options: MutationObserverInit = {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...ATTRIBUTES],
    };
    const observer = new MutationObserver((records) => {
      // Off while writing, and whatever the writes queued is dropped: they are ours.
      observer.disconnect();
      for (const record of records) {
        if (record.target === document.body) {
          for (const added of record.addedNodes) {
            if (
              added instanceof Element &&
              !added.contains(root) &&
              lastWasInside &&
              performance.now() - lastInsideAt < PORTAL_WINDOW_MS
            ) {
              portals.add(added);
              translateTree(added);
            }
          }
          for (const removed of record.removedNodes) {
            if (removed instanceof Element) portals.delete(removed);
          }
        } else if (record.type === "childList") {
          for (const added of record.addedNodes) translateTree(added);
        } else {
          translateTree(record.target);
        }
      }
      observer.takeRecords();
      observe();
    });
    const observe = () => {
      observer.observe(root, options);
      for (const portal of portals) observer.observe(portal, options);
      // New portals only: body's own children, not its subtree.
      observer.observe(document.body, { childList: true });
    };

    /** Whether the latest pointer or focus landed in the workspace or one of its portals. */
    const onInteraction = (event: Event) => {
      lastWasInside = isInside(event.target instanceof Node ? event.target : null);
      if (lastWasInside) lastInsideAt = performance.now();
    };
    const interactions = ["pointerdown", "pointerover", "focusin", "keydown"] as const;
    for (const type of interactions) {
      document.addEventListener(type, onInteraction, { capture: true, passive: true });
    }

    translateTree(root);
    observe();
    return () => {
      observer.disconnect();
      for (const type of interactions) {
        document.removeEventListener(type, onInteraction, { capture: true });
      }
      // Back to upstream's strings where they are still ours; React may have replaced some.
      texts.forEach((rewrite, node) => {
        if (node.nodeValue === rewrite.written) node.nodeValue = rewrite.original;
      });
      attributes.forEach((byName, element) => {
        byName.forEach((rewrite, name) => {
          if (element.getAttribute(name) === rewrite.written) {
            element.setAttribute(name, rewrite.original);
          }
        });
      });
    };
  }, [container]);
}
