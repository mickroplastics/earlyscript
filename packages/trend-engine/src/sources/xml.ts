// Minimal XML reader for RSS 2.0 and Atom feeds. No dependency: the engine only needs
// elements, attributes, text and CDATA. DOCTYPE internal subsets are skipped and custom
// entities are never expanded, so entity-expansion attacks do not apply.

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: Array<XmlElement | string>;
}

export class XmlError extends Error {}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] !== "#") return ENTITIES[code] ?? match;
    const n =
      code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
  });
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parses a document and returns its root element; throws XmlError on malformed input. */
export function parseXml(input: string): XmlElement {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const root: XmlElement = { name: "#document", attrs: {}, children: [] };
  const stack: Array<XmlElement> = [root];
  let i = 0;
  const skipTo = (marker: string) => {
    const end = text.indexOf(marker, i);
    if (end < 0) throw new XmlError(`Unterminated construct before ${marker}`);
    const start = i;
    i = end + marker.length;
    return text.slice(start, end);
  };
  while (i < text.length) {
    const open = text.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (open < 0 || open > i) {
      const chunk = text.slice(i, open < 0 ? text.length : open);
      if (chunk.trim()) top.children.push(decodeEntities(chunk));
      if (open < 0) break;
      i = open;
    }
    if (text.startsWith("<!--", i)) {
      i += 4;
      skipTo("-->");
    } else if (text.startsWith("<![CDATA[", i)) {
      i += 9;
      top.children.push(skipTo("]]>"));
    } else if (text.startsWith("<?", i)) {
      i += 2;
      skipTo("?>");
    } else if (text.startsWith("<!", i)) {
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
      if (!element || element === root || element.name !== name)
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
      const attrs: Record<string, string> = {};
      for (const match of inner.slice(name.length).matchAll(ATTRIBUTE))
        attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
      const element: XmlElement = { name, attrs, children: [] };
      top.children.push(element);
      if (!selfClosing) stack.push(element);
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed element <${stack[stack.length - 1]!.name}>`);
  const element = root.children.find((child): child is XmlElement => typeof child !== "string");
  if (!element) throw new XmlError("No root element");
  return element;
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
  return node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
}
