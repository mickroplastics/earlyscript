import type {
  TrendPresentationEvidence,
  TrendPresentationGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

// The assistant's summary talks about the news, never about how it was collected. A text that
// says "el motor registró 11 elementos de 11 autores distintos" is rejected, not stored with a
// warning nobody reads.

type VoicePresentation = Pick<TrendPresentationGenerationResult, "title" | "summary">;

/** Same marker the prompt asks for: `[itemId]`, without spaces or nested brackets. */
const CITATION_MARKER = /\[[^[\]\s]+\]/g;

/** Lowercase, without citation markers or diacritics, so "Clúster [itm_1]" reads "cluster". */
const voiceText = (text: string) =>
  text
    .replace(CITATION_MARKER, " ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const VOICE_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  /** Allowed when the evidence itself uses the word: "Unreal Engine", "motor de búsqueda". */
  readonly unlessEvidence?: RegExp;
}> = [
  { pattern: /\bmotor(es)?\b/, unlessEvidence: /\bmotor(es)?\b/ },
  { pattern: /\bengines?\b/, unlessEvidence: /\bengines?\b/ },
  { pattern: /\bautores? distintos?\b/ },
  { pattern: /\b\d+\s+(elementos|items|publicaciones|autores)\b/ },
  { pattern: /\bel (sistema|algoritmo|corpus|cluster)\b/ },
  { pattern: /(^|[.!?]\s+)(la|esta) tendencia\b/ },
];

// Labels as the dossier page names each part; the message reaches the operator.
const VOICE_PARTS: ReadonlyArray<readonly [string, (presentation: VoicePresentation) => string]> = [
  ["título", (presentation) => presentation.title],
  ["Qué pasó", (presentation) => presentation.summary.whatHappened],
  ["Encaje con el canal", (presentation) => presentation.summary.whyItMatters],
  ["Ángulo de video", (presentation) => presentation.summary.videoAngle],
];

/**
 * Phrases that describe the collection process instead of the news. One message per match,
 * naming the part and the words («Qué pasó: «el motor»»); empty when the text is about the news.
 */
export function trendPresentationVoiceProblems(
  presentation: VoicePresentation,
  evidence: ReadonlyArray<Pick<TrendPresentationEvidence, "title" | "excerpt">>,
): ReadonlyArray<string> {
  const evidenceText = voiceText(evidence.map((item) => `${item.title} ${item.excerpt}`).join(" "));
  const problems: string[] = [];
  for (const [part, read] of VOICE_PARTS) {
    const text = voiceText(read(presentation));
    for (const rule of VOICE_RULES) {
      if (rule.unlessEvidence?.test(evidenceText)) continue;
      const match = rule.pattern.exec(text);
      if (match) problems.push(`${part}: «${match[0].replace(/^[.!?\s]+/, "")}»`);
    }
  }
  return problems;
}

/** The line the one retry adds to the prompt, in the prompt's language. */
export const voiceRetryReason = (problems: ReadonlyArray<string>) =>
  `it described how the data was collected instead of the news (${problems.join("; ")})`;

/** What the operator reads when the retry still described the collection. */
export const voiceFailureMessage = (problems: ReadonlyArray<string>) =>
  `el texto describía la recogida de datos y no las noticias (${problems[0] ?? ""}). Regenera o elige otro modelo en Ajustes › Editorial › Redacción.`;
