import {
  EDITORIAL_CARD_EVIDENCE_MAX,
  EDITORIAL_CARD_HEADLINES_MAX,
  type EditorialCardCurveRow,
  type EditorialCardItem,
  type EditorialCardSourceDay,
  type EditorialCurveDay,
  type EditorialJudgeOpinion,
  type EditorialJudgeView,
  type EditorialTrendCard,
  type EditorialTrendMovement,
} from "@t3tools/contracts";
import type { Dossier } from "@earlyscript/editorial-contracts/dossier";

// The brief card of a dossier (engine v3, contract §1), read field by field from the `card` and
// `judges` blocks of the file text, so a card shows what it has and a dossier/1 still gets one.
// Provisional block shape: the v3 mock-up's fields (`maqueta-cortes.json`); when the engine's
// v3 contract lands only `readCardBlock` and `readJudgesBlock` change.

/** The `card` block of a v3 dossier, as read; every field may be missing. */
export interface CardBlock {
  readonly section: "moving" | "background" | null;
  readonly position: number | null;
  /** The engine's movement code, or the mock-up's Spanish name; `perenne` is not a movement. */
  readonly movement: string | null;
  readonly since: string | null;
  readonly perennial: boolean | null;
  readonly weeksBySource: ReadonlyArray<{
    readonly source: string;
    readonly status: string;
    readonly weeks: ReadonlyArray<number | null> | null;
  }> | null;
  readonly firstSource: EditorialCardSourceDay | null;
  readonly secondSource: EditorialCardSourceDay | null;
  readonly nearestInclude: string | null;
  readonly keywordTerms: ReadonlyArray<string> | null;
  readonly saturated: boolean | null;
  readonly headlines: ReadonlyArray<{
    readonly itemId: string | null;
    readonly title: string;
    readonly source: string;
    readonly url: string | null;
    readonly day: string | null;
  }> | null;
  readonly incompleteSources: ReadonlyArray<string> | null;
}

/** What the dossier file carries beyond `Dossier`, read from the same text. */
export interface DossierExtras {
  readonly card: CardBlock | null;
  readonly judges: EditorialJudgeView | null;
}

export const NO_EXTRAS: DossierExtras = { card: null, judges: null };

type Json = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: unknown): string | null => {
  const raw = text(value);
  if (raw === null) return null;
  const head = raw.slice(0, 10);
  return DAY.test(head) ? head : null;
};
const list = <A>(value: unknown, item: (entry: unknown) => A | null): ReadonlyArray<A> | null =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const read = item(entry);
        return read === null ? [] : [read];
      })
    : null;

const sourceDay = (source: unknown, at: unknown): EditorialCardSourceDay | null => {
  const name = text(source);
  const when = day(at);
  return name === null || when === null ? null : { source: name, day: when };
};

function readCardBlock(raw: unknown): CardBlock | null {
  if (!isObject(raw)) return null;
  const section = raw.section === "moving" || raw.section === "background" ? raw.section : null;
  const position = count(raw.position);
  return {
    section,
    position: position !== null && position >= 1 ? position : null,
    movement: text(raw.movement) ?? text(raw.state),
    since: day(raw.since),
    perennial: flag(raw.perennial) ?? flag(raw.perennial_antecedent),
    weeksBySource: list(raw.weeks_by_source, (row) => {
      if (!isObject(row)) return null;
      const source = text(row.source);
      if (source === null) return null;
      const weeks = Array.isArray(row.weeks)
        ? row.weeks.map((week) => (week === "?" ? null : count(week)))
        : null;
      return { source, status: text(row.status) ?? "comparable", weeks };
    }),
    firstSource: isObject(raw.first_source)
      ? sourceDay(raw.first_source.source, raw.first_source.day)
      : sourceDay(raw.first_source, raw.first_day),
    secondSource: isObject(raw.second_source)
      ? sourceDay(raw.second_source.source, raw.second_source.day)
      : sourceDay(raw.second_source, raw.second_day),
    nearestInclude: text(raw.nearest_include),
    keywordTerms: list(raw.keyword_hits, (hit) =>
      typeof hit === "string" ? text(hit) : isObject(hit) ? text(hit.term) : null,
    ),
    saturated: flag(raw.saturated),
    headlines: list(raw.headlines, (headline) => {
      if (!isObject(headline)) return null;
      const title = text(headline.title);
      const source = text(headline.source);
      if (title === null || source === null) return null;
      return {
        itemId: text(headline.item_id),
        title,
        source,
        url: text(headline.url),
        day: day(headline.day ?? headline.published_at),
      };
    }),
    incompleteSources: list(raw.incomplete_sources, text),
  };
}

function readJudgesBlock(raw: unknown): EditorialJudgeView | null {
  if (!isObject(raw)) return null;
  const opinions =
    list(raw.opinions, (entry): EditorialJudgeOpinion | null => {
      if (!isObject(entry)) return null;
      const judge = text(entry.judge);
      const reason = text(entry.reason);
      if (judge === null || reason === null) return null;
      const utility = finite(entry.utility);
      return {
        judge,
        model: text(entry.model),
        utility: utility !== null && utility >= 1 && utility <= 5 ? utility : null,
        fit: text(entry.fit),
        reason,
        angle: text(entry.angle),
      };
    }) ?? [];
  if (opinions.length === 0) return null;
  const utilities = opinions.flatMap((opinion) =>
    opinion.utility === null ? [] : [opinion.utility],
  );
  return {
    utility:
      utilities.length === 0
        ? null
        : utilities.reduce((total, value) => total + value, 0) / utilities.length,
    opinions,
  };
}

/**
 * The `card` and `judges` blocks of one dossier file's text. A file whose JSON does not parse
 * has none; the dossier decoder reports that file on its own.
 */
export function readDossierExtras(fileText: string): DossierExtras {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return NO_EXTRAS;
  }
  if (!isObject(parsed)) return NO_EXTRAS;
  return { card: readCardBlock(parsed.card), judges: readJudgesBlock(parsed.judges) };
}

const MOVEMENTS: Readonly<Record<string, EditorialTrendMovement>> = {
  new: "new",
  nueva: "new",
  weak: "weak",
  "señal débil": "weak",
  senal_debil: "weak",
  strong: "strong",
  "señal fuerte": "strong",
  senal_fuerte: "strong",
  rebound: "rebound",
  rebote: "rebound",
  falling: "falling",
  "en caída": "falling",
  en_caida: "falling",
  stable: "stable",
  estable: "stable",
};

const movementOf = (code: string | null): EditorialTrendMovement | null =>
  code !== null && Object.hasOwn(MOVEMENTS, code) ? MOVEMENTS[code]! : null;

const STATUSES: Readonly<Record<string, EditorialCardCurveRow["status"]>> = {
  comparable: "comparable",
  partial: "partial",
  parcial: "partial",
  unused: "unused",
  "no usada": "unused",
  total: "total",
};

/** Evidence links open outside the app: only http(s) survives. */
const webUrl = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
};

/**
 * Up to ten evidence items, newest first so W0 leads; one row per URL, with the other sources
 * that carried it.
 */
function cardEvidence(file: Dossier): ReadonlyArray<EditorialCardItem> {
  const sorted = file.evidence.toSorted(
    (a, b) => b.published_at.localeCompare(a.published_at) || a.item_id.localeCompare(b.item_id),
  );
  const byUrl = new Map<string, { item: EditorialCardItem; also: Set<string> }>();
  const rows: Array<{ item: EditorialCardItem; also: Set<string> }> = [];
  for (const entry of sorted) {
    const url = webUrl(entry.external_url) ?? webUrl(entry.permalink);
    const seen = url === null ? undefined : byUrl.get(url);
    if (seen !== undefined) {
      if (entry.source !== seen.item.source) seen.also.add(entry.source);
      continue;
    }
    const row = {
      item: {
        itemId: entry.item_id,
        source: entry.source,
        title: entry.title,
        day: day(entry.published_at),
        url,
      },
      also: new Set<string>(),
    };
    if (url !== null) byUrl.set(url, row);
    rows.push(row);
  }
  return rows
    .slice(0, EDITORIAL_CARD_EVIDENCE_MAX)
    .map(({ item, also }) => (also.size === 0 ? item : { ...item, alsoIn: [...also].toSorted() }));
}

const DAYS_PER_WEEK = 7;
/** A week with more than one day the engine did not capture is shown as "?". */
const UNKNOWN_DAYS_TOLERATED = 1;

/** W3..W0 over every source from the 28-day curve of an older dossier. */
function totalWeeks(curve: ReadonlyArray<EditorialCurveDay>): ReadonlyArray<number | null> {
  const days = curve.slice(-4 * DAYS_PER_WEEK);
  if (days.length < 4 * DAYS_PER_WEEK) return [];
  return [0, 1, 2, 3].map((week) => {
    const span = days.slice(week * DAYS_PER_WEEK, (week + 1) * DAYS_PER_WEEK);
    const unknown = span.filter((entry) => !entry.known).length;
    return unknown > UNKNOWN_DAYS_TOLERATED
      ? null
      : span.reduce((total, entry) => total + entry.items, 0);
  });
}

/**
 * The card of one dossier. With a `card` block (v3) each field comes from it and the evidence
 * from the dossier; without one, the card keeps what a `dossier/1` has and leaves the rest null.
 */
export function cardOf(
  file: Dossier,
  curve: ReadonlyArray<EditorialCurveDay>,
  block: CardBlock | null,
): EditorialTrendCard {
  const evidence = cardEvidence(file);
  const recentHeadlines = evidence.slice(0, EDITORIAL_CARD_HEADLINES_MAX);
  if (block === null) {
    const weeks = totalWeeks(curve);
    return {
      origin: "derived",
      section: null,
      position: null,
      movement: null,
      since: null,
      perennial: false,
      curve: weeks.length === 0 ? [] : [{ source: "total", status: "total", weeks }],
      sourceCount: file.trend.sources.length,
      firstSource: null,
      secondSource: null,
      fit: { topic: file.profile_fit.nearest_include, terms: [] },
      saturated: null,
      headlines: recentHeadlines,
      evidence,
      incompleteSources: file.coverage.by_source
        .filter((entry) => entry.days_unavailable > 0)
        .map((entry) => entry.source),
    };
  }
  const rows = (block.weeksBySource ?? []).map((row): EditorialCardCurveRow => {
    const status = Object.hasOwn(STATUSES, row.status) ? STATUSES[row.status]! : "comparable";
    return { source: row.source, status, weeks: status === "unused" ? [] : (row.weeks ?? []) };
  });
  const itemIdByUrl = new Map<string, string>();
  for (const entry of file.evidence) {
    for (const url of [webUrl(entry.external_url), webUrl(entry.permalink)]) {
      if (url !== null && !itemIdByUrl.has(url)) itemIdByUrl.set(url, entry.item_id);
    }
  }
  const headlines =
    block.headlines === null
      ? recentHeadlines
      : block.headlines.slice(0, EDITORIAL_CARD_HEADLINES_MAX).map((headline) => {
          const url = webUrl(headline.url);
          return {
            itemId: headline.itemId ?? (url === null ? null : (itemIdByUrl.get(url) ?? null)),
            source: headline.source,
            title: headline.title,
            day: headline.day,
            url,
          };
        });
  const movement = movementOf(block.movement);
  return {
    origin: "v3",
    section: block.section,
    position: block.position,
    movement,
    since: block.since,
    perennial: block.perennial ?? block.movement === "perenne",
    curve: rows,
    sourceCount: rows.filter(
      (row) => row.status === "comparable" && row.weeks.some((week) => week !== null && week > 0),
    ).length,
    firstSource: block.firstSource,
    secondSource: block.secondSource,
    fit: {
      topic: block.nearestInclude ?? file.profile_fit.nearest_include,
      terms: block.keywordTerms ?? [],
    },
    saturated: block.saturated,
    headlines,
    evidence,
    incompleteSources: block.incompleteSources ?? [],
  };
}
