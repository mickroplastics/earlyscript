import {
  trendPresentationEvidenceNote,
  type TrendPresentationEvidence,
  type TrendPresentationGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

// The assistant's summary talks about the news, never about how it was collected or about its
// own writing. A text that says "el motor registró 11 elementos de 11 autores distintos" is
// rejected, not stored with a warning nobody reads. Rules match collection phrases, not news
// nouns: "el sistema operativo Alpine" is news, "el sistema agrupó" is not.

type VoicePresentation = Pick<TrendPresentationGenerationResult, "title" | "summary">;
type VoiceEvidence = Pick<TrendPresentationEvidence, "title" | "excerpt">;

export interface VoiceProblem {
  /** The part as the dossier page names it: «Qué pasó», «Ángulo de video»… */
  readonly part: string;
  /** The matched words, for the log and the retry; never shown to the operator. */
  readonly words: string;
  readonly kind: "collection" | "self" | "note";
}

/** Same marker the prompt asks for: `[itemId]`, without spaces or nested brackets. */
const CITATION_MARKER = /\[[^[\]\s]+\]/g;

/** Lowercase, without citation markers or diacritics, so "Clúster [itm_1]" reads "cluster". */
const voiceText = (text: string) =>
  accentedText(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

/** Lowercase, without citation markers; same positions as `voiceText` for one NFC text. */
const accentedText = (text: string) =>
  text.replace(CITATION_MARKER, " ").normalize("NFC").toLowerCase();

const wordsOf = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

// Digits or a written count from two up ("trece", "veintiuno", "treinta y dos"); "un" and
// "una" stay out, since "una publicación de Hacker News pregunta…" is news.
const NUMBER =
  "(?:\\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\\w+|veinte|veinti\\w+|(?:treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)(?: y \\w+)?|cien|ciento \\w+)";
const SOURCES = "(?:hacker news|github|hugging face|npm|rss|reddit|lobsters|wikipedia)";
const PIECES = "(?:articulos|publicaciones|titulares|posts|entradas|elementos|items|menciones)";
const GATHERED = "(?:recogid|recopilad|registrad|capturad|agrupad|reunid)";

const PHRASE_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly kind: VoiceProblem["kind"];
  /** Matched with the accents kept: "creo" is the writer, "creó" someone in the news. */
  readonly accented?: true;
}> = [
  // Something that gathered the items, doing the gathering.
  {
    pattern:
      /\b(?:el|un|este|nuestro) (?:sistema|algoritmo|motor|engine|pipeline|cluster|corpus) (?:registr|agrup|detect|recog|recopil|reun|captur|identific|clasific|junt|seleccion)\w*/,
    kind: "collection",
  },
  {
    pattern: /\bse (?:recogieron|recopilaron|registraron|capturaron|agruparon|reunieron)\b/,
    kind: "collection",
  },
  // Compound tenses and the passive: "se han recopilado", "han sido recogidas".
  {
    pattern: new RegExp(`\\bse (?:ha|han|habia|habian) ${GATHERED}o\\b`),
    kind: "collection",
  },
  {
    pattern: new RegExp(`\\b(?:ha|han|habia|habian|fue|fueron) sido ${GATHERED}[oa]s?\\b`),
    kind: "collection",
  },
  // The simple passive with the pieces as subject: "los titulares fueron recogidos". Other
  // subjects stay news: "los datos fueron recogidos por la NASA".
  {
    pattern: new RegExp(
      `\\b(?:${PIECES}|noticias) (?:\\w+ )?(?:fue|fueron|son|eran) ${GATHERED}[oa]s?\\b`,
    ),
    kind: "collection",
  },
  {
    pattern: new RegExp(`\\b(?:recogid|recopilad|capturad)[oa]s? (?:de|en|desde) ${SOURCES}`),
    kind: "collection",
  },
  {
    pattern:
      /\b(?:la|esta) (?:recopilacion|recogida|captura|seleccion|muestra) (?:registr|reun|incluy|agrup|contien|sum|junt)\w*/,
    kind: "collection",
  },
  // A source or anything else counting pieces: "Hacker News registró 11 publicaciones".
  { pattern: new RegExp(`\\bregistr\\w* ${NUMBER} ${PIECES}\\b`), kind: "collection" },
  {
    pattern: new RegExp(
      `\\b${NUMBER} ${PIECES} en (?:(?:una|la|esta|las|los|${NUMBER}) )?(?:ultim\\w+ )?(?:semanas?|dias?|meses?)\\b`,
    ),
    kind: "collection",
  },
  { pattern: new RegExp(`\\b${NUMBER} (?:elementos|items|autores)\\b`), kind: "collection" },
  { pattern: /\b(?:los|estos|varios|algunos|otros) (?:elementos|items)\b/, kind: "collection" },
  {
    pattern: new RegExp(
      `\\b${NUMBER} (?:articulos|publicaciones|titulares|posts|entradas) (?:de|en) ${SOURCES}\\b`,
    ),
    kind: "collection",
  },
  { pattern: /\b(?:autores? distintos?|distintos autores)\b/, kind: "collection" },
  // "La tendencia" as the subject naming the group; "la tendencia del mercado…" is news.
  {
    pattern: /(^|[.!?]\s+)(?:la|esta) tendencia\b(?! (?:de|del|a|hacia)\b)/,
    kind: "collection",
  },
  {
    pattern: /\b(?:la|esta) tendencia (?:reune|agrupa|recoge|incluye|junta|suma)\b/,
    kind: "collection",
  },
  // The writer talking about itself or about its instructions.
  {
    pattern:
      /\b(?:lo senalo|sin recomendar|me limito|no he (?:leido|podido)|no puedo (?:leer|acceder|abrir))\b/,
    kind: "self",
  },
  // First person; not "veo", which is also a video model's name.
  {
    pattern: /\b(?:creemos|pienso|pensamos|hemos|nosotros|nosotras|vemos|consideramos)\b/,
    kind: "self",
  },
  { pattern: /(?<!\p{L})creo(?!\p{L})/u, kind: "self", accented: true },
  // A note about the evidence: the application appends the one that fits.
  {
    pattern: /\bsolo (?:hay |se dispone de |existen )?(?:titulares|extractos)\b/,
    kind: "note",
  },
  { pattern: /\b(?:titulares y extractos|extractos breves)\b/, kind: "note" },
  { pattern: /\bno se (?:ha|han) leido\b/, kind: "note" },
  { pattern: /\bsin leer (?:los |el )?(?:articulos?|textos?)\b/, kind: "note" },
];

/** Words that name the collection; allowed only inside the evidence's own expression. */
const JARGON = /^(?:motor(?:es)?|engines?|clusters?|corpus)$/;
const STOP_WORDS = new Set(
  "el la los las lo un una unos unas este esta estos estas ese esa su sus al a y o que en con por para se nuestro the a an of and".split(
    " ",
  ),
);

/** Spanish expressions for an English evidence: "motor de búsqueda" for "search engine". */
const TRANSLATIONS: Readonly<Record<string, string>> = {
  "motor de busqueda": "search engine",
  "motores de busqueda": "search engines",
  "motor de juego": "game engine",
  "motor de juegos": "game engine",
  "motor de inferencia": "inference engine",
  "motor de renderizado": "rendering engine",
  "motor electrico": "electric motor",
};

/**
 * The expressions around a jargon word: "unreal engine", "motor electrico", "motor de
 * busqueda". The word passes only when one of them is in the evidence, so an evidence about a
 * search engine does not excuse "el motor agrupó estos titulares".
 */
function jargonOutsideEvidence(text: string, evidence: string): string | null {
  const words = wordsOf(text);
  for (const [index, word] of words.entries()) {
    if (!JARGON.test(word)) continue;
    const before = words[index - 1];
    const after = words[index + 1];
    const expressions = [
      before !== undefined && !STOP_WORDS.has(before) ? `${before} ${word}` : null,
      after !== undefined && !STOP_WORDS.has(after) && after !== "de" && after !== "del"
        ? `${word} ${after}`
        : null,
      (after === "de" || after === "del") && words[index + 2] !== undefined
        ? `${word} ${after} ${words[index + 2]}`
        : null,
    ].filter((expression) => expression !== null);
    const inEvidence = (expression: string) =>
      evidence.includes(` ${expression} `) ||
      (Object.hasOwn(TRANSLATIONS, expression) &&
        evidence.includes(` ${TRANSLATIONS[expression]} `));
    if (!expressions.some(inEvidence)) return word;
  }
  return null;
}

// Labels as the dossier page names each part; the operator reads them in the error.
export const VOICE_TITLE_PART = "título";

const VOICE_PARTS: ReadonlyArray<
  readonly [string, (presentation: VoicePresentation, note: string | null) => string]
> = [
  [VOICE_TITLE_PART, (presentation) => presentation.title],
  [
    "Qué pasó",
    ({ summary }, note) =>
      note !== null && summary.whatHappened.endsWith(note)
        ? summary.whatHappened.slice(0, -note.length)
        : summary.whatHappened,
  ],
  ["Encaje con el canal", (presentation) => presentation.summary.whyItMatters],
  ["Ángulo de video", (presentation) => presentation.summary.videoAngle],
];

/**
 * Phrases about the collection process, the writer or the evidence instead of the news, one
 * per match; empty when the text is about the news. The evidence note the application appends
 * to «Qué pasó» is not the model's and is not checked.
 */
export function trendPresentationVoiceProblems(
  presentation: VoicePresentation,
  evidence: ReadonlyArray<VoiceEvidence>,
): ReadonlyArray<VoiceProblem> {
  const evidenceWords = ` ${wordsOf(
    voiceText(evidence.map((item) => `${item.title} ${item.excerpt}`).join(" ")),
  ).join(" ")} `;
  const note = trendPresentationEvidenceNote(evidence);
  const problems: VoiceProblem[] = [];
  for (const [part, read] of VOICE_PARTS) {
    const raw = read(presentation, note);
    const text = voiceText(raw);
    const accented = accentedText(raw);
    const found: VoiceProblem[] = [];
    const spans: Array<readonly [number, number]> = [];
    // One problem per phrase: "el motor registro 11" is not also "registro 11 elementos".
    for (const rule of PHRASE_RULES) {
      const match = rule.pattern.exec(rule.accented ? accented : text);
      if (match === null) continue;
      const words = match[0].replace(/^[.!?\s]+/, "");
      const end = match.index + match[0].length;
      const start = end - words.length;
      if (spans.some(([from, to]) => start < to && from < end)) continue;
      spans.push([start, end]);
      found.push({ part, words, kind: rule.kind });
    }
    const jargon = jargonOutsideEvidence(text, evidenceWords);
    if (jargon !== null && !found.some((other) => other.words.includes(jargon))) {
      found.push({ part, words: jargon, kind: "collection" });
    }
    problems.push(...found);
  }
  return problems;
}

/** "Qué pasó: «motor»; Ángulo de video: «lo senalo»", for the log and the retry. */
export const voiceProblemsText = (problems: ReadonlyArray<VoiceProblem>) =>
  problems.map((problem) => `${problem.part}: «${problem.words}»`).join("; ");

/** The line the one retry adds to the prompt, in the prompt's language. */
export function voiceRetryReason(problems: ReadonlyArray<VoiceProblem>): string {
  const reasons = [
    problems.some((problem) => problem.kind === "collection")
      ? "it described how the data was collected instead of the news"
      : null,
    problems.some((problem) => problem.kind === "self")
      ? "it commented on its own writing or instructions instead of the news"
      : null,
    problems.some((problem) => problem.kind === "note")
      ? "it wrote a note about the evidence (headlines, excerpts, articles not read), which the application adds"
      : null,
  ].filter((reason) => reason !== null);
  return `${reasons.join(", and ")} (${voiceProblemsText(problems)})`;
}

const partList = new Intl.ListFormat("es", { type: "conjunction" });

/**
 * What the operator reads when the retry failed too: the parts, never the rejected words,
 * which would put the collection vocabulary back on the dossier.
 */
export function voiceFailureMessage(problems: ReadonlyArray<VoiceProblem>): string {
  const sentence = (kind: VoiceProblem["kind"], singular: string, plural: string) => {
    const parts = [
      ...new Set(
        problems.filter((problem) => problem.kind === kind).map((problem) => problem.part),
      ),
    ];
    if (parts.length === 0) return null;
    return `${partList.format(parts.map((part) => `«${part}»`))} ${parts.length === 1 ? singular : plural}.`;
  };
  return [
    sentence(
      "collection",
      "describía cómo se reunieron los datos y no las noticias",
      "describían cómo se reunieron los datos y no las noticias",
    ),
    sentence("self", "comentaba su propia redacción", "comentaban su propia redacción"),
    sentence(
      "note",
      "añadía su propia nota sobre la evidencia",
      "añadían su propia nota sobre la evidencia",
    ),
    "Regenera o elige otro modelo en Ajustes › Editorial › Redacción.",
  ]
    .filter((part) => part !== null)
    .join(" ");
}
