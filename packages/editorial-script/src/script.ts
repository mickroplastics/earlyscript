export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface ScriptDiagnostic extends Position {
  readonly code: string;
  readonly message: string;
}

export interface Citation extends Position {
  readonly id: string;
  readonly raw: string;
}

export interface Claim extends Position {
  readonly text: string;
  readonly citations: readonly string[];
}

export interface Paragraph extends Position {
  readonly text: string;
  readonly claims: readonly Claim[];
}

export interface ScriptSection extends Position {
  readonly heading: string;
  readonly kind: "hook" | "block" | "close" | "sources" | "unknown";
  readonly blockNumber: number | null;
  readonly paragraphs: Paragraph[];
}

export interface ScriptAst {
  readonly metadata: Readonly<Record<string, string>>;
  readonly sections: readonly ScriptSection[];
  readonly citations: readonly Citation[];
  readonly diagnostics: readonly ScriptDiagnostic[];
}

export interface ScriptCheckReport {
  readonly ok: boolean;
  readonly structure: readonly ScriptDiagnostic[];
  readonly diagnostics: readonly ScriptDiagnostic[];
  readonly counts: { readonly claims: number; readonly cited: number; readonly uncited: number };
  readonly uncitedClaims: readonly Claim[];
  readonly unknownCitations: readonly Citation[];
  readonly claimsMap: readonly Claim[];
}

/**
 * The empty script a video thread starts from: the headings `checkScript` expects, in order.
 * Heading identifiers stay fixed in every channel language.
 */
export const SCRIPT_TEMPLATE = "# Hook\n\n# Block 1\n\n# Close\n\n# Sources\n";

const ABBREVIATION = /(?:^|[^\p{L}.])(?:Inc|Dr|vs|e\.g|i\.e|U\.S)$/u;
// URLs keep their trailing sentence punctuation outside the match.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S*?(?=[.!?"'”’»)*_~`]*(?:\s|$))/gi;
const QUESTION = /\?[!?\s"'”’»)*_~`]*$/;
/**
 * A membership or subscription invitation in Close ("Join SingulariDev as a member", "If this
 * helped, subscribe"): not a claim, so it needs no citation. Anything that could carry a claim
 * keeps the sentence counted: a subordinate clause, a comparison and a figure in digits or words.
 */
const INVITATION_LEAD = /^(?:(?:so|and|now|if\b[^,]{1,80}),\s*)?(?:please\s+)?/iu;
/** Any of the words, whole: `\b` does not see accented letters as part of a word. */
const anyWord = (words: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, "iu");
const SUBSCRIBE = anyWord("subscribe|suscr[ií]bete");
const JOIN_VERB = anyWord("join|become|support|sign\\s+up|[úu]nete|hazte|ap[óo]yanos|apoya");
const JOIN_TARGET = anyWord("singularidev|members?|membership|channel|miembros?|canal");
const SUBORDINATE = anyWord(
  "that|which|who|whom|whose|because|since|where|when|while|although|though|whereas|unless|que|porque|cual|cuales|quien|quienes|donde|cuando|aunque",
);
const COMPARISON = anyWord(
  "more|most|less|least|fewer|better|best|worse|worst|than|leading|m[áa]s|mejor|mejores|mayor|mayores|menor|menos|peor|\\p{L}+[íi]sim[oa]s?",
);
const SUPERLATIVE = /(?<!\p{L})\p{L}{2,}est(?!\p{L})/giu;
const NOT_SUPERLATIVE = new Set([
  "interest",
  "request",
  "honest",
  "contest",
  "protest",
  "suggest",
  "digest",
  "invest",
  "harvest",
  "manifest",
]);
const NUMBER_WORD = anyWord(
  "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\p{L}+teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?|billions?|dozens?|half|percent|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|veinte|treinta|cuarenta|cincuenta|cien|cientos|mil|miles|mill[oó]n|millones|docenas?|mitad",
);

const isInvitation = (sentence: string): boolean => {
  // The lead ("If this helped,") is checked with the rest: it may carry a claim too.
  const whole = sentence.replace(/\[[^\]]*\]/g, "").replace(/^[*_~>\s]+/, "");
  const text = whole.replace(INVITATION_LEAD, "");
  const opens = (verb: RegExp) => verb.exec(text)?.index === 0;
  if (!opens(SUBSCRIBE) && !(opens(JOIN_VERB) && JOIN_TARGET.test(text))) return false;
  const superlative = [...whole.matchAll(SUPERLATIVE)].some(
    ([word]) => !NOT_SUPERLATIVE.has(word.toLowerCase()),
  );
  return (
    !/\d/.test(whole) &&
    !NUMBER_WORD.test(whole) &&
    !SUBORDINATE.test(whole) &&
    !COMPARISON.test(whole) &&
    !superlative
  );
};

const ITEM = /^(?:itm_([a-z][a-z0-9-]*)_([A-Za-z0-9_-]+)|([a-z][a-z0-9-]*):([A-Za-z0-9_-]+))$/;

function citationsIn(text: string): Array<{ offset: number; raw: string; ids: string[] }> {
  const citations = [];
  for (const match of text.matchAll(/\[([^\]\n]+)\]/g)) {
    const tokens = (match[1] ?? "").split(",").map((token) => token.trim());
    const ids: string[] = [];
    for (const token of tokens) {
      const item = ITEM.exec(token);
      if (!item) break;
      ids.push(item[1] ? token : `itm_${item[3]}_${item[4]}`);
    }
    if (ids.length === tokens.length) citations.push({ offset: match.index, raw: match[0], ids });
  }
  return citations;
}

function positionAt(text: string, offset: number, startLine: number): Position {
  const prefix = text.slice(0, offset).split("\n");
  return { line: startLine + prefix.length - 1, column: (prefix.at(-1)?.length ?? 0) + 1 };
}

function parseParagraph(text: string, line: number): Paragraph {
  const citations = citationsIn(text);
  // Mask citations and inline code so their punctuation cannot split sentences.
  const masked = text.split("");
  const spans = [
    ...citations.map(({ offset, raw }) => ({ offset, length: raw.length })),
    ...[...text.matchAll(/`[^`\n]*`/g)].map(({ index, 0: raw }) => ({
      offset: index,
      length: raw.length,
    })),
  ];
  for (const { offset, length } of spans) {
    for (let i = offset; i < offset + length; i++) masked[i] = " ";
  }
  const sentences: Array<{ text: string; offset: number; citations: string[] }> = [];
  let start = 0;
  const addSentence = (end: number) => {
    const raw = text.slice(start, end);
    const offset = start + (raw.match(/^\s*/)?.[0].length ?? 0);
    const ids = citations
      .filter((citation) => citation.offset >= start && citation.offset < end)
      .flatMap((citation) => citation.ids);
    if (raw.trim()) sentences.push({ text: raw.trim(), offset, citations: ids });
    start = end;
  };
  for (let i = 0; i < masked.length; i++) {
    if (!/[.!?]/.test(masked[i] ?? "")) continue;
    if (/\d/.test(masked[i - 1] ?? "") && /\d/.test(masked[i + 1] ?? "")) continue;
    if (masked[i] === "." && ABBREVIATION.test(masked.slice(Math.max(0, i - 4), i).join("")))
      continue;
    let end = i + 1;
    // Closing quotes, brackets and Markdown emphasis or code markers stay with the sentence.
    while (/[.!?"'”’»)*_~`]/.test(text[end] ?? " ")) end++;
    // A citation immediately after sentence punctuation belongs to that sentence.
    for (;;) {
      const next = citations.find(
        (citation) => citation.offset >= end && /^\s*$/.test(text.slice(end, citation.offset)),
      );
      if (!next) break;
      end = next.offset + next.raw.length;
    }
    if (end < text.length && !/\s/.test(text[end] ?? "")) continue;
    addSentence(end);
    i = end - 1;
  }
  addSentence(text.length);
  const inherited = sentences.at(-1)?.citations ?? [];
  const claims = sentences.flatMap((sentence): Claim[] => {
    const prose = sentence.text.replace(/\[[^\]]*\]/g, "");
    const words = prose.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? [];
    if (QUESTION.test(prose.replace(/`[^`]*`/g, "").replace(URL, "")) || words.length < 4)
      return [];
    return [
      {
        text: sentence.text,
        ...positionAt(text, sentence.offset, line),
        citations: [...new Set(sentence.citations.length ? sentence.citations : inherited)],
      },
    ];
  });
  return { text, line, column: 1, claims };
}

export function parseScript(markdown: string): ScriptAst {
  const lines = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .split("\n");
  const metadata: Record<string, string> = {};
  const diagnostics: ScriptDiagnostic[] = [];
  const sections: ScriptSection[] = [];
  const citations: Citation[] = [];
  const issue = (code: string, message: string, line: number) =>
    diagnostics.push({ code, message, line, column: 1 });
  let index = 0;
  if (lines[0] === "---") {
    index = 1;
    while (index < lines.length && lines[index] !== "---") {
      const value = lines[index] ?? "";
      const match = /^(trend|thread|mode|version):\s*(.*?)\s*$/.exec(value);
      if (match?.[1] && match[2] !== undefined) {
        if (match[1] in metadata) issue("frontmatter", "Duplicate metadata key.", index + 1);
        metadata[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
      } else if (value.trim())
        issue(
          "frontmatter",
          "Expected a simple trend, thread, mode, or version key: value.",
          index + 1,
        );
      index++;
    }
    if (index === lines.length) issue("frontmatter", "Unclosed frontmatter.", 1);
    else index++;
  }
  let section: ScriptSection | undefined;
  let paragraph: string[] = [];
  let paragraphLine = 1;
  const flush = () => {
    if (paragraph.length && section)
      section.paragraphs.push(parseParagraph(paragraph.join("\n"), paragraphLine));
    paragraph = [];
  };
  for (; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      flush();
      const block = /^Block ([1-9]\d*)(?:(?:\s*·\s*|:\s*)\S.*)?$/.exec(heading);
      section = {
        heading,
        line: index + 1,
        column: 1,
        kind:
          heading === "Hook"
            ? "hook"
            : block
              ? "block"
              : heading === "Close"
                ? "close"
                : heading === "Sources"
                  ? "sources"
                  : "unknown",
        blockNumber: block ? Number(block[1]) : null,
        paragraphs: [],
      };
      sections.push(section);
      continue;
    }
    if (/^#{2,6}\s/.test(line)) {
      flush();
      continue;
    }
    for (const citation of citationsIn(line)) {
      for (const id of citation.ids)
        citations.push({ id, raw: citation.raw, line: index + 1, column: citation.offset + 1 });
    }
    if (!line.trim()) flush();
    else if (!section) issue("preamble", "Body text must follow # Hook.", index + 1);
    else {
      if (!paragraph.length) paragraphLine = index + 1;
      paragraph.push(line);
    }
  }
  flush();
  return { metadata, sections, citations, diagnostics };
}

function dossierIds(dossier: unknown): Set<string> {
  if (
    typeof dossier !== "object" ||
    dossier === null ||
    !("evidence" in dossier) ||
    !Array.isArray(dossier.evidence)
  ) {
    throw new TypeError("Invalid dossier: expected evidence[].item_id (line 1, column 1).");
  }
  const ids = new Set<string>();
  for (const entry of dossier.evidence) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("item_id" in entry) ||
      typeof entry.item_id !== "string" ||
      !/^itm_[a-z][a-z0-9-]*_[A-Za-z0-9_-]+$/.test(entry.item_id)
    ) {
      throw new TypeError("Invalid dossier: expected evidence[].item_id (line 1, column 1).");
    }
    ids.add(entry.item_id);
  }
  return ids;
}

export function checkScript(
  markdown: string,
  options: { readonly dossier?: unknown } = {},
): ScriptCheckReport {
  const ast = parseScript(markdown);
  const structure = [...ast.diagnostics];
  const issue = (code: string, message: string, position: Position) =>
    structure.push({ code, message, ...position });
  for (const kind of ["hook", "block", "close"]) {
    if (!ast.sections.some((section) => section.kind === kind))
      issue("missing-heading", `Missing ${kind} heading.`, { line: 1, column: 1 });
  }
  let phase = 0;
  let expectedBlock = 1;
  const seen = new Set<string>();
  for (const section of ast.sections) {
    const rank = { hook: 1, block: 2, close: 3, sources: 4, unknown: 0 }[section.kind];
    if (!rank) issue("unknown-heading", `Unexpected heading: ${section.heading}.`, section);
    else {
      if (rank < phase || (section.kind !== "block" && seen.has(section.kind)))
        issue(
          "heading-order",
          "Expected Hook, numbered Blocks, Close, then optional Sources.",
          section,
        );
      phase = Math.max(phase, rank);
      seen.add(section.kind);
    }
    if (section.kind === "block") {
      if (section.blockNumber !== expectedBlock)
        issue("block-number", `Expected Block ${expectedBlock}.`, section);
      expectedBlock++;
    }
    if (section.kind !== "sources" && !section.paragraphs.length)
      issue("empty-section", `Empty section: ${section.heading}.`, section);
  }
  const claimsMap = ast.sections
    .filter((section) => section.kind !== "sources")
    .flatMap((section) =>
      section.paragraphs
        .flatMap((paragraph) => paragraph.claims)
        .filter((claim) => section.kind !== "close" || !isInvitation(claim.text)),
    );
  const uncitedClaims = claimsMap.filter((claim) => !claim.citations.length);
  const allowed = options.dossier === undefined ? undefined : dossierIds(options.dossier);
  const unknownCitations = allowed
    ? ast.citations.filter((citation) => !allowed.has(citation.id))
    : [];
  const diagnostics = [
    ...structure,
    ...uncitedClaims.map((claim) => ({
      code: "uncited-claim",
      message: "Claim has no citation.",
      line: claim.line,
      column: claim.column,
    })),
    ...unknownCitations.map((citation) => ({
      code: "unknown-citation",
      message: `Citation is not in dossier: ${citation.id}.`,
      line: citation.line,
      column: citation.column,
    })),
  ];
  return {
    ok: !diagnostics.length,
    structure,
    diagnostics,
    counts: {
      claims: claimsMap.length,
      cited: claimsMap.length - uncitedClaims.length,
      uncited: uncitedClaims.length,
    },
    uncitedClaims,
    unknownCitations,
    claimsMap,
  };
}
