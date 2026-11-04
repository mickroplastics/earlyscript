import { useEffect, type RefObject } from "react";

/**
 * Spanish for upstream text that has no translation layer, by exact whole strings: a text node
 * or an attribute is rewritten only when its whole (whitespace-folded) value is a known string.
 * Used by the manual browser and by the shell (sidebar, thread area, settings), each scoped to
 * containers it names; never the whole document.
 */

/** A whole-string pattern; the replacement may translate captured parts with the same table. */
export type LocalePattern = readonly [
  RegExp,
  string | ((match: RegExpExecArray, translate: (value: string) => string) => string),
];

export interface LocaleTable {
  /** Matched before whitespace folding, for a word whose spacing tells its use apart. */
  readonly raw?: Readonly<Record<string, string>>;
  readonly text?: Readonly<Record<string, string>>;
  readonly patterns?: ReadonlyArray<LocalePattern>;
  /** Last resort: returns the Spanish or the same string when it does not know it. */
  readonly functions?: ReadonlyArray<(value: string) => string>;
}

/** A table's strings as own entries only: `constructor` or `__proto__` are never keys. */
interface CompiledTable {
  readonly raw: ReadonlyMap<string, string>;
  readonly text: ReadonlyMap<string, string>;
  readonly patterns: ReadonlyArray<LocalePattern>;
  readonly functions: ReadonlyArray<(value: string) => string>;
}

const ownEntries = (record: Readonly<Record<string, string>> | undefined) =>
  new Map(
    Object.entries(record ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

function compile(table: LocaleTable): CompiledTable {
  return {
    raw: ownEntries(table.raw),
    text: ownEntries(table.text),
    patterns: table.patterns ?? [],
    functions: table.functions ?? [],
  };
}

/** Translates a folded string, or undefined when no table knows it. */
function translateFolded(
  tables: ReadonlyArray<CompiledTable>,
  folded: string,
  depth: number,
): string | undefined {
  for (const table of tables) {
    const exact = table.text.get(folded);
    if (exact !== undefined) return exact;
  }
  if (depth > 1) return undefined;
  const nested = (value: string) => translateFolded(tables, value, depth + 1) ?? value;
  for (const table of tables) {
    for (const [regex, replacement] of table.patterns) {
      const match = regex.exec(folded);
      if (match === null) continue;
      const next =
        typeof replacement === "string"
          ? folded.replace(regex, replacement)
          : replacement(match, nested);
      return typeof next === "string" ? next : undefined;
    }
  }
  for (const table of tables) {
    for (const fn of table.functions) {
      const next: unknown = fn(folded);
      if (typeof next === "string" && next !== folded) return next;
    }
  }
  return undefined;
}

export type Translator = (value: string | null) => string | undefined;

/**
 * The Spanish for a string, its surrounding whitespace kept (`Profile: ` then the name), or
 * undefined when no table knows it or it would not change.
 */
export function makeTranslator(tables: ReadonlyArray<LocaleTable>): Translator {
  const compiled = tables.map(compile);
  return (value) => {
    if (value === null) return undefined;
    for (const table of compiled) {
      const raw = table.raw.get(value);
      if (raw !== undefined) return raw === value ? undefined : raw;
    }
    const folded = value.replace(/\s+/g, " ").trim();
    if (folded.length === 0) return undefined;
    const translated = translateFolded(compiled, folded, 0);
    if (translated === undefined) return undefined;
    const lead = /^\s*/.exec(value)?.[0] ?? "";
    const trail = /\s*$/.exec(value)?.[0] ?? "";
    const next = `${lead}${translated}${trail}`;
    return next === value ? undefined : next;
  };
}

export interface ScopedLocaleOptions {
  readonly translate: Translator;
  /** The containers to translate, resolved from the anchor when the effect starts. */
  readonly roots: (anchor: Element) => ReadonlyArray<Element>;
  /** Containers mounted in `body` (a toast viewport) that may appear after the anchor. */
  readonly lateRoots?: string;
  /** Content never rewritten: user data, messages, editors, code. Matched with `closest`. */
  readonly skip?: string;
  /**
   * Upstream controls inside skipped content that are rewritten anyway: the author heading or
   * the copy buttons of a message row. A node is allowed when its closest `controls` match
   * lies inside its closest `skip` match and that skip match is a `within` container, so a
   * control nested in other skipped content (a message body, a `[dir]` name) stays skipped.
   */
  readonly allow?: { readonly within: string; readonly controls: string };
  readonly attributes?: ReadonlyArray<string>;
}

interface Rewrite {
  readonly original: string;
  readonly written: string;
}

const DEFAULT_ATTRIBUTES = ["aria-label", "placeholder", "title"] as const;

/** A portal opened this long after an interaction inside a container belongs to it. */
const PORTAL_WINDOW_MS = 2_000;

/**
 * Translates `options.roots(anchor)` and the portals opened from them while mounted, and puts
 * every rewritten string back on unmount. Writes only on change, observer disconnected, and
 * drops the records its writes queued, so it never sees its own writes. Stable `options`.
 */
export function useScopedLocale(
  anchor: RefObject<Element | null> | Element | null,
  options: ScopedLocaleOptions,
): void {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes DOM that upstream components render, including portals outside this component's tree, and rewrites its text in place
  useEffect(() => {
    const element = anchor instanceof Element || anchor === null ? anchor : anchor.current;
    if (element === null) return;
    const roots = [...options.roots(element)];
    const { lateRoots } = options;
    const findLateRoots = (node: Element) =>
      lateRoots === undefined
        ? []
        : [...(node.matches(lateRoots) ? [node] : []), ...node.querySelectorAll(lateRoots)];
    if (lateRoots !== undefined) {
      for (const late of document.querySelectorAll(lateRoots)) {
        if (!roots.includes(late)) roots.push(late);
      }
    }
    if (roots.length === 0) return;
    const { translate, skip, allow } = options;
    const attributeNames = options.attributes ?? DEFAULT_ATTRIBUTES;
    const texts = new Map<Text, Rewrite>();
    const attributes = new Map<Element, Map<string, Rewrite>>();
    const portals = new Set<Element>();
    let lastInsideAt = Number.NEGATIVE_INFINITY;
    let lastWasInside = false;

    const isInside = (node: Node | null) =>
      node !== null &&
      (roots.some((root) => root.contains(node)) ||
        [...portals].some((portal) => portal.contains(node)));
    const skipped = (element: Element | null) => {
      if (skip === undefined || element === null) return false;
      const skippedBy = element.closest(skip);
      if (skippedBy === null) return false;
      if (allow === undefined || !skippedBy.matches(allow.within)) return true;
      const allowedBy = element.closest(allow.controls);
      return !(allowedBy !== null && allowedBy !== skippedBy && skippedBy.contains(allowedBy));
    };

    /*
     * Authorship by records, not values: our writes happen unobserved, so every characterData
     * or attributes record is someone else's write, even one equal to ours, and sets what to
     * restore. Without a record (first walk, added or moved nodes) a node is ours while it
     * still holds our last write.
     */
    const translateText = (node: Text, external: boolean) => {
      if (skipped(node.parentElement)) return;
      const current = node.nodeValue ?? "";
      if (!external && texts.get(node)?.written === current) return;
      const next = translate(current);
      if (next === undefined) texts.delete(node);
      else {
        texts.set(node, { original: current, written: next });
        node.nodeValue = next;
      }
    };
    const translateAttribute = (element: Element, name: string, external: boolean) => {
      const value = element.getAttribute(name);
      const byName = attributes.get(element);
      if (!external && value !== null && byName?.get(name)?.written === value) return;
      const next = translate(value);
      if (next === undefined || value === null) {
        byName?.delete(name);
        return;
      }
      const rewrites = byName ?? new Map<string, Rewrite>();
      rewrites.set(name, { original: value, written: next });
      attributes.set(element, rewrites);
      element.setAttribute(name, next);
    };
    const translateTree = (node: Node) => {
      if (node instanceof Text) {
        translateText(node, false);
        return;
      }
      if (!(node instanceof Element)) return;
      if (skipped(node)) {
        // Allowed controls inside skipped content; `skipped` tells each one apart.
        if (allow !== undefined) {
          for (const allowed of node.querySelectorAll(allow.controls)) {
            if (!skipped(allowed)) translateTree(allowed);
          }
        }
        return;
      }
      for (const name of attributeNames) translateAttribute(node, name, false);
      // Skipped descendants are pruned by the check at the top of each call.
      for (const child of node.childNodes) translateTree(child);
    };

    const observeOptions: MutationObserverInit = {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...attributeNames],
    };
    const observer = new MutationObserver((records) => {
      // Off while writing, and whatever the writes queued is dropped: they are ours.
      observer.disconnect();
      // Someone else's writes first, once per node or attribute however many records it got:
      // a second pass would mistake the write just made here for another external one.
      const externalTexts = new Set<Text>();
      const externalAttributes = new Map<Element, Set<string>>();
      for (const record of records) {
        if (record.type === "characterData" && record.target instanceof Text) {
          externalTexts.add(record.target);
        } else if (
          record.type === "attributes" &&
          record.target instanceof Element &&
          record.attributeName !== null
        ) {
          const names = externalAttributes.get(record.target) ?? new Set<string>();
          names.add(record.attributeName);
          externalAttributes.set(record.target, names);
        }
      }
      for (const text of externalTexts) translateText(text, true);
      externalAttributes.forEach((names, element) => {
        if (skipped(element)) return;
        for (const name of names) translateAttribute(element, name, true);
      });
      // Then what was added or moved, by value: a node still holding our write stays ours.
      let left = false;
      for (const record of records) {
        if (record.type === "childList" && record.removedNodes.length > 0) left = true;
        if (record.target === document.body) {
          for (const added of record.addedNodes) {
            if (!(added instanceof Element)) continue;
            const late = findLateRoots(added).filter((root) => !roots.includes(root));
            if (late.length > 0) {
              roots.push(...late);
              for (const root of late) translateTree(root);
              continue;
            }
            if (
              !roots.some((root) => added.contains(root)) &&
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
        }
      }
      // Whatever left for good (a portal now in another scope, a subtree out of the DOM) is no
      // longer this scope's to restore: forget it without reverting. A move inside the scope
      // in the same batch is still observed and keeps its record.
      if (left) forgetUnobserved();
      observer.takeRecords();
      observe();
    });
    /** Drops every record of a node this scope no longer observes, leaving its value as is. */
    const forgetUnobserved = () => {
      texts.forEach((_rewrite, node) => {
        if (!isInside(node)) texts.delete(node);
      });
      attributes.forEach((_byName, element) => {
        if (!isInside(element)) attributes.delete(element);
      });
    };
    const observe = () => {
      for (const root of roots) observer.observe(root, observeOptions);
      for (const portal of portals) observer.observe(portal, observeOptions);
      // New portals only: body's own children, not its subtree.
      observer.observe(document.body, { childList: true });
    };

    /**
     * Whether the latest interaction landed in a container or one of its portals. Only a press
     * or a key outside counts as leaving: opening a menu can move focus (and the pointer) into
     * the new portal before the observer has adopted it, and that must not disown it.
     */
    const onInteraction = (event: Event) => {
      const inside = isInside(event.target instanceof Node ? event.target : null);
      if (inside) {
        lastWasInside = true;
        lastInsideAt = performance.now();
      } else if (event.type === "pointerdown" || event.type === "keydown") {
        lastWasInside = false;
      }
    };
    const interactions = ["pointerdown", "pointerover", "focusin", "keydown"] as const;
    for (const type of interactions) {
      document.addEventListener(type, onInteraction, { capture: true, passive: true });
    }

    for (const root of roots) translateTree(root);
    observe();
    return () => {
      // Writes not yet delivered are someone else's too: they keep their value.
      for (const record of observer.takeRecords()) {
        if (record.type === "characterData" && record.target instanceof Text) {
          texts.delete(record.target);
        } else if (record.target instanceof Element && record.attributeName !== null) {
          attributes.get(record.target)?.delete(record.attributeName);
        }
      }
      observer.disconnect();
      for (const type of interactions) {
        document.removeEventListener(type, onInteraction, { capture: true });
      }
      // Only what this scope still observes: a node elsewhere may be another scope's now.
      forgetUnobserved();
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
  }, [anchor, options]);
}
