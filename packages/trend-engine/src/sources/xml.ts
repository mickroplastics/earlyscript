// Minimal XML reader for RSS 2.0 and Atom: elements, attributes, text and CDATA. Custom
// entities are never expanded. Nothing recurses; depth and node count are bounded and every
// overrun is an XmlError, so a hostile feed fails alone instead of exhausting the stack.

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: Array<XmlElement | string>;
}

export class XmlError extends Error {}

/** Deepest element nesting accepted; real feeds stay under 15 (Atom xhtml content included). */
export const MAX_XML_DEPTH = 64;
/** Most elements accepted in one document; a 4 MiB feed of 20,000 entries holds about 100,000. */
export const MAX_XML_NODES = 250_000;

// XML's five entities plus the HTML ones feeds use most, often double-escaped inside
// HTML descriptions; anything else stays literal.
// Code points, not literals, so the table stays readable and lint-clean.
const ENTITIES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries({
    amp: 0x26,
    lt: 0x3c,
    gt: 0x3e,
    quot: 0x22,
    apos: 0x27,
    nbsp: 0xa0,
    mdash: 0x2014,
    ndash: 0x2013,
    hellip: 0x2026,
    lsquo: 0x2018,
    rsquo: 0x2019,
    sbquo: 0x201a,
    ldquo: 0x201c,
    rdquo: 0x201d,
    bdquo: 0x201e,
    laquo: 0xab,
    raquo: 0xbb,
    copy: 0xa9,
    reg: 0xae,
    trade: 0x2122,
    bull: 0x2022,
    middot: 0xb7,
    deg: 0xb0,
    times: 0xd7,
    minus: 0x2212,
    euro: 0x20ac,
    pound: 0xa3,
    shy: 0xad,
    zwj: 0x200d,
    zwnj: 0x200c,
  }).map(([name, code]) => [name, String.fromCodePoint(code)]),
);

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] !== "#") return ENTITIES[code] ?? match;
    const n =
      code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  });
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parses a document and returns its single root element. Throws XmlError on malformed
 * input: mismatched or unclosed tags, a second root, text or CDATA outside the root, or a
 * document over MAX_XML_DEPTH or MAX_XML_NODES.
 */
export function parseXml(input: string): XmlElement {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let root: XmlElement | undefined;
  const stack: Array<XmlElement> = [];
  let nodes = 0;
  let i = 0;
  const skipTo = (marker: string) => {
    const end = text.indexOf(marker, i);
    if (end < 0) throw new XmlError(`Unterminated construct before ${marker}`);
    const start = i;
    i = end + marker.length;
    return text.slice(start, end);
  };
  const append = (child: XmlElement | string) => {
    const top = stack[stack.length - 1];
    if (top) top.children.push(child);
    else if (typeof child === "string") throw new XmlError("Text outside the root element");
    else if (root) throw new XmlError(`Second root element <${child.name}>`);
    else root = child;
  };
  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0 || open > i) {
      const chunk = text.slice(i, open < 0 ? text.length : open);
      if (chunk.trim()) append(decodeEntities(chunk));
      if (open < 0) break;
      i = open;
    }
    if (text.startsWith("<!--", i)) {
      i += 4;
      skipTo("-->");
    } else if (text.startsWith("<![CDATA[", i)) {
      i += 9;
      append(skipTo("]]>"));
    } else if (text.startsWith("<?", i)) {
      i += 2;
      skipTo("?>");
    } else if (text.startsWith("<!", i)) {
      if (root || stack.length) throw new XmlError("Declaration after the root element");
      // DOCTYPE, with an optional internal subset in brackets.
      const bracket = text.indexOf("[", i);
      const close = text.indexOf(">", i);
      if (bracket >= 0 && close >= 0 && bracket < close) {
        i = bracket;
        skipTo("]");
      }
      skipTo(">");
    } else if (text.startsWith("</", i)) {
      i += 2;
      const name = skipTo(">").trim();
      const element = stack.pop();
      if (!element || element.name !== name)
        throw new XmlError(`Unexpected closing tag </${name}>`);
    } else {
      i += 1;
      // Attribute values may contain ">", so find the end outside quotes.
      let end = i;
      let quote = "";
      for (; end < text.length; end++) {
        const c = text[end];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
      }
      if (end >= text.length) throw new XmlError("Unterminated tag");
      const raw = text.slice(i, end);
      i = end + 1;
      const selfClosing = raw.endsWith("/");
      const inner = selfClosing ? raw.slice(0, -1) : raw;
      const name = /^[^\s/>]+/.exec(inner)?.[0];
      if (!name) throw new XmlError("Empty tag name");
      if (++nodes > MAX_XML_NODES) throw new XmlError(`More than ${MAX_XML_NODES} elements`);
      const attrs: Record<string, string> = {};
      for (const match of inner.slice(name.length).matchAll(ATTRIBUTE))
        attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
      // The new element's own depth, self-closing leaves included.
      if (stack.length + 1 > MAX_XML_DEPTH)
        throw new XmlError(`Elements nested deeper than ${MAX_XML_DEPTH}`);
      const element: XmlElement = { name, attrs, children: [] };
      append(element);
      if (!selfClosing) stack.push(element);
    }
  }
  if (stack.length) throw new XmlError(`Unclosed element <${stack[stack.length - 1]!.name}>`);
  if (!root) throw new XmlError("No root element");
  return root;
}

export const elements = (parent: XmlElement, ...names: ReadonlyArray<string>) =>
  parent.children.filter(
    (child): child is XmlElement => typeof child !== "string" && names.includes(child.name),
  );

export const element = (parent: XmlElement, ...names: ReadonlyArray<string>) => {
  for (const name of names) {
    const found = elements(parent, name)[0];
    if (found) return found;
  }
  return undefined;
};

/** Concatenated text of an element and its descendants (Atom xhtml content included). */
export function textOf(node: XmlElement | undefined): string {
  if (!node) return "";
  const parts: Array<string> = [];
  // Explicit stack, children pushed in reverse so text keeps document order.
  const pending: Array<XmlElement | string> = [node];
  while (pending.length) {
    const next = pending.pop()!;
    if (typeof next === "string") parts.push(next);
    else for (let k = next.children.length - 1; k >= 0; k--) pending.push(next.children[k]!);
  }
  return parts.join("");
}
