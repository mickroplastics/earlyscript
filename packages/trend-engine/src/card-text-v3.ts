// @effect-diagnostics globalDate:off - pure text function; Date only parses the card's own timestamps.
// cardTextV3: the text the v3 utility judges read for one topic card (contract v4.2 §3, §5a).
// It is a pure function of a CLOSED list of fields: anything else on the input object is never
// read. In particular the text never carries a human decision, human utility, reason, a prior
// judge opinion, arm, list position, internal scores, an absolute date or anything dated at or
// after the cutoff t. Every date is shown relative to t ("5 days ago"). The saturation mark
// carries only the items in the topic's life and the perennial antecedent, never "already
// decided". The flat variant (terms and headlines only) measures the circularity with
// relevance.v2. The sha256 of this file is the function's hash in the v3 pre-manifest; the
// adapters that build a CardInputV3 live elsewhere (judge-v3-inputs.ts) so they do not move it.

export const CARD_TEXT_V3_VERSION = "card-text-v3/2";

export type Movement = "new" | "weak" | "strong" | "rebound" | "falling" | "stable";
export type SourceStatus = "comparable" | "partial" | "unused";

/** One row of the four-week curve. weeks is W3..W0 (W0 = the 7 days before t); null = "?". */
export interface CurveRowV3 {
  readonly source: string;
  readonly status: SourceStatus;
  readonly weeks: ReadonlyArray<number | null> | null;
  readonly authors_w0?: number | null;
}

export interface HeadlineV3 {
  /** Stable id of the item (never shown: the text uses E1..E5 and the caller maps them back). */
  readonly id: string;
  readonly title: string;
  readonly source: string;
  /** Other sources carrying the same URL. */
  readonly also_in?: ReadonlyArray<string>;
  readonly published_at: string;
}

/** The closed list of fields the judge text may use (§3). */
export interface CardInputV3 {
  /** The cutoff t, ISO day or timestamp. Used only to compute relative ages; never shown. */
  readonly cutoff: string;
  readonly terms: ReadonlyArray<string>;
  readonly movement?: Movement | null;
  /** Day the topic entered its current movement. */
  readonly entered_at?: string | null;
  readonly first_at?: string | null;
  readonly perennial?: boolean | null;
  readonly curve?: ReadonlyArray<CurveRowV3> | null;
  readonly first_source?: { readonly source: string; readonly at: string } | null;
  readonly second_source?: { readonly source: string; readonly at: string } | null;
  readonly matched_terms?: ReadonlyArray<{ readonly term: string; readonly items: number }> | null;
  readonly headlines: ReadonlyArray<HeadlineV3>;
  readonly life_items?: number | null;
}

export interface CardTextOptions {
  /** "canonical" (default) or a seed that permutes terms, curve rows and headlines (stability test). */
  readonly order?: "canonical" | { readonly seed: number };
}

export interface CardTextV3 {
  readonly text: string;
  /** E1..En → headline id, in the order shown. */
  readonly evidence: ReadonlyArray<{ readonly id: string; readonly item_id: string }>;
}

export const MAX_TERMS = 4;
export const MAX_HEADLINES = 5;
export const MAX_TITLE_CHARS = 200;
const DAY_MS = 86_400_000;

const MOVEMENT_TEXT: Record<Movement, string> = {
  new: "new",
  weak: "weak signal",
  strong: "strong signal",
  rebound: "rebound",
  falling: "falling",
  stable: "stable",
};

const toMs = (value: string): number => {
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms)) throw new Error(`cardTextV3: unreadable date ${JSON.stringify(value)}`);
  return ms;
};

/** Whole days between a date and t; null when the date is at or after t (never shown). */
const daysBefore = (cutoffMs: number, value: string): number | null => {
  const ms = toMs(value);
  if (ms >= cutoffMs) return null;
  return Math.floor((cutoffMs - ms) / DAY_MS);
};

const ago = (days: number) =>
  days === 0 ? "less than 1 day ago" : days === 1 ? "1 day ago" : `${days} days ago`;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sept",
  "sep",
  "oct",
  "nov",
  "dec",
];
// Months match in lower, capitalized or upper case; "May" only capitalized or upper ("you may 3x").
const MONTH = `(?:${[
  ...MONTH_NAMES.flatMap((m) => [m, m[0]!.toUpperCase() + m.slice(1), m.toUpperCase()]),
  "May",
  "MAY",
].join("|")})\\.?(?![A-Za-z])`;
const DAY = "(?<![\\w.-])(?:0?[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?(?!\\w)";
const YEAR = "(?:19|20)\\d{2}(?!\\d)";

/** Calendar dates written in free text: ISO, month names (full or short, with or without day or year) and numeric forms. */
export const CALENDAR_DATES: ReadonlyArray<RegExp> = [
  /\b(19|20)\d{2}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g,
  new RegExp(`${DAY}\\s+(?:of\\s+)?${MONTH}(?:,?\\s+${YEAR})?`, "g"),
  new RegExp(`(?<![A-Za-z])${MONTH}\\s+${DAY}(?:,?\\s+${YEAR})?`, "g"),
  new RegExp(`(?<![A-Za-z])${MONTH},?\\s+${YEAR}`, "g"),
  /(?<![\w./-])(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:(?:19|20)\d{2}|\d{2})(?![\d/])/g,
  /(?<![\w./-])(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])\.(?:19|20)\d{2}(?!\d)/g,
  /(?<![\w./-])(?:19|20)\d{2}[/.](?:0?[1-9]|1[0-2])[/.](?:0?[1-9]|[12]\d|3[01])(?![\d/.])/g,
];

/**
 * Data, not instructions: control characters and line breaks go, calendar dates become "[date]"
 * (no absolute date reaches the judge), and the text is clipped.
 */
export const cleanText = (value: string, max = MAX_TITLE_CHARS): string => {
  let flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  for (const pattern of CALENDAR_DATES) flat = flat.replace(pattern, "[date]");
  flat = flat.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Deterministic permutation (mulberry32), used only by the stability variant. */
function permute<T>(items: ReadonlyArray<T>, seed: number): Array<T> {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  // A permutation equal to the input is no reordering: rotate by one.
  if (out.length > 1 && out.every((x, k) => x === items[k])) out.push(out.shift()!);
  return out;
}

/** Headlines before t: last 7 days first, then newest first; ties by id. At most 5. */
function selectHeadlines(card: CardInputV3, cutoffMs: number) {
  return card.headlines
    .map((h) => ({ h, days: daysBefore(cutoffMs, h.published_at) }))
    .filter((x): x is { h: HeadlineV3; days: number } => x.days !== null)
    .toSorted(
      (x, y) =>
        Number(y.days < 7) - Number(x.days < 7) ||
        x.days - y.days ||
        (x.h.id < y.h.id ? -1 : x.h.id > y.h.id ? 1 : 0),
    )
    .slice(0, MAX_HEADLINES);
}

function curveLines(rows: ReadonlyArray<CurveRowV3>): Array<string> {
  return rows.map((row) => {
    const source = cleanText(row.source, 40);
    if (row.status === "unused") return `- ${source}: not used`;
    const weeks = row.weeks ?? [];
    const cells = [0, 1, 2, 3].map((k) => {
      const v = weeks[k];
      return v === null || v === undefined ? "?" : String(v);
    });
    const known = weeks.filter((v): v is number => typeof v === "number");
    const total = known.reduce((s, v) => s + v, 0);
    const authors =
      typeof row.authors_w0 === "number" ? `; distinct authors in W0: ${row.authors_w0}` : "";
    const partial = row.status === "partial" ? " [partial capture]" : "";
    return `- ${source}${partial}: ${cells.join(", ")} (total ${total}${weeks.some((v) => v === null) ? " known" : ""})${authors}`;
  });
}

/** The v3 judge text: the closed field list of §3, dates relative to t. */
export function cardTextV3(card: CardInputV3, options: CardTextOptions = {}): CardTextV3 {
  const cutoffMs = toMs(card.cutoff);
  const seed = options.order && options.order !== "canonical" ? options.order.seed : null;
  const shuffle = <T>(xs: ReadonlyArray<T>): Array<T> =>
    seed === null ? [...xs] : permute(xs, seed);

  const terms = shuffle(card.terms.slice(0, MAX_TERMS).map((t) => cleanText(t, 60)));
  const lines: Array<string> = [`Topic terms: ${terms.join(", ")}`];

  if (card.movement) {
    const parts = [`Movement: ${MOVEMENT_TEXT[card.movement]}`];
    const entered = card.entered_at ? daysBefore(cutoffMs, card.entered_at) : null;
    if (entered !== null) parts.push(`since ${ago(entered)}`);
    lines.push(parts.join("; "));
  }
  const first = card.first_at ? daysBefore(cutoffMs, card.first_at) : null;
  if (first !== null) lines.push(`First item of the topic: ${ago(first)}`);

  if (card.curve && card.curve.length > 0) {
    lines.push(
      "Items per week by source (W3, W2, W1, W0; W0 = the last 7 days; ? = not captured):",
    );
    lines.push(...shuffle(curveLines(card.curve)));
  }

  const sourceAt = (s: { source: string; at: string } | null | undefined, label: string) => {
    if (!s) return null;
    const d = daysBefore(cutoffMs, s.at);
    return d === null ? null : `${label}: ${cleanText(s.source, 40)}, ${ago(d)}`;
  };
  const firstSource = sourceAt(card.first_source, "First source");
  const secondSource = sourceAt(card.second_source, "Second source");
  if (firstSource || secondSource)
    lines.push([firstSource, secondSource].filter(Boolean).join(". "));

  if (card.matched_terms && card.matched_terms.length > 0)
    lines.push(
      `Profile terms found in last-7-day headlines: ${shuffle(
        card.matched_terms.map((m) => `${cleanText(m.term, 40)} (${m.items})`),
      ).join(", ")}`,
    );

  if (typeof card.life_items === "number" || typeof card.perennial === "boolean") {
    const parts: Array<string> = [];
    if (typeof card.life_items === "number") parts.push(`${card.life_items} items in its life`);
    if (typeof card.perennial === "boolean")
      parts.push(`perennial antecedent: ${card.perennial ? "yes" : "no"}`);
    lines.push(`Saturation: ${parts.join("; ")}`);
  }

  const chosen = shuffle(selectHeadlines(card, cutoffMs));
  const evidence = chosen.map((x, k) => ({ id: `E${k + 1}`, item_id: x.h.id }));
  lines.push("Headlines:");
  chosen.forEach((x, k) => {
    const also = (x.h.also_in ?? []).filter((s) => s !== x.h.source);
    const where = also.length
      ? `${cleanText(x.h.source, 40)}, also ${also.map((s) => cleanText(s, 40)).join(", ")}`
      : cleanText(x.h.source, 40);
    lines.push(`[E${k + 1}] (${where}, ${ago(x.days)}) ${cleanText(x.h.title)}`);
  });
  return { text: lines.join("\n"), evidence };
}

/** Flat variant (§5a): terms and headlines, no movement, curve, sources or dates. */
export function cardTextFlat(card: CardInputV3, options: CardTextOptions = {}): CardTextV3 {
  const cutoffMs = toMs(card.cutoff);
  const seed = options.order && options.order !== "canonical" ? options.order.seed : null;
  const shuffle = <T>(xs: ReadonlyArray<T>): Array<T> =>
    seed === null ? [...xs] : permute(xs, seed);
  const terms = shuffle(card.terms.slice(0, MAX_TERMS).map((t) => cleanText(t, 60)));
  const chosen = shuffle(selectHeadlines(card, cutoffMs));
  const evidence = chosen.map((x, k) => ({ id: `E${k + 1}`, item_id: x.h.id }));
  const lines = [
    `Topic terms: ${terms.join(", ")}`,
    "Headlines:",
    ...chosen.map((x, k) => `[E${k + 1}] ${cleanText(x.h.title)}`),
  ];
  return { text: lines.join("\n"), evidence };
}
