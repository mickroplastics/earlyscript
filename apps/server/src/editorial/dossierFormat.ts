import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialCurveDay,
  type EditorialEvidenceItem,
  type EditorialInboxSort,
  type EditorialRunSummary,
  type EditorialSourceCoverage,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { trendKeyOf, type TrendKey } from "./trendKey.ts";

// Reader for Earlywindow's `run.json` and `dossier/1` files. The engine keeps writing this
// format, so these schemas only name the fields the editorial space shows; the rest is ignored.

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

export const RunFile = Schema.Struct({
  run_id: Schema.String,
  cutoff_at: Schema.String,
  finished_at: OptionalText,
  status: Schema.optionalKey(Schema.String),
  config_version: OptionalText,
  sources: Schema.optionalKey(Schema.Array(Schema.String)),
  // Provenance the importer indexes. Earlywindow writes `corpus_hash` at the top; the
  // Earlyscript engine writes `schema_version` and `corpus.corpus_used_hash`.
  schema_version: OptionalText,
  engine_version: OptionalText,
  config_hash: OptionalText,
  corpus_hash: OptionalText,
  logical_hash: OptionalText,
  corpus: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        corpus_used_hash: OptionalText,
        corpus_manifest_hash: OptionalText,
      }),
    ),
  ),
  coverage: Schema.optionalKey(Schema.Unknown),
});
export type RunFile = typeof RunFile.Type;

export const DossierFile = Schema.Struct({
  schema_version: Schema.Literal("dossier/1"),
  dossier_id: Schema.String,
  cutoff_at: Schema.String,
  profile: Schema.optionalKey(
    Schema.Struct({ include_score: Schema.optionalKey(Schema.NullOr(Schema.Finite)) }),
  ),
  signal: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    label: Schema.String,
    stage: Schema.optionalKey(Schema.String),
    corroboration: Schema.optionalKey(Schema.String),
    top_terms: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  curve: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      items: Count,
      sources: Count,
      authors: Count,
      known: Schema.Boolean,
    }),
  ),
  rank: Schema.Struct({
    method: Schema.optionalKey(Schema.String),
    score: Schema.Finite,
    components: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          name: Schema.String,
          value: Schema.Finite,
          weight: Schema.Finite,
          contribution: Schema.Finite,
        }),
      ),
    ),
  }),
  coverage: Schema.optionalKey(
    Schema.Struct({
      window_days: Count,
      by_source: Schema.Array(
        Schema.Struct({
          source: Schema.String,
          days_complete: Count,
          days_partial: Count,
          days_unavailable: Count,
        }),
      ),
    }),
  ),
  evidence: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        item_id: Schema.String,
        source: Schema.String,
        permalink: Schema.optionalKey(Schema.NullOr(Schema.String)),
        external_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
        published_at: Schema.String,
        author: Schema.optionalKey(Schema.NullOr(Schema.String)),
        title: Schema.String,
        excerpt: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type DossierFile = typeof DossierFile.Type;

/** engine.v0.02 `profile.include_min`; the run config lives outside the runs directory. */
export const AFFINITY_THRESHOLD = 0.6;
const CURVE_WINDOW_DAYS = 28;
const SPARKLINE_DAYS = 14;
const DAY_MS = 86_400_000;

export interface LoadedDossier {
  readonly file: DossierFile;
  readonly trendKey: TrendKey;
  /** Last curve day with items, or null; the inbox compares it with the revision seen. */
  readonly lastActivityDay: string | null;
  readonly summary: EditorialTrendSummary;
  readonly curve: ReadonlyArray<EditorialCurveDay>;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
  readonly evidence: ReadonlyArray<EditorialEvidenceItem>;
}

export function runSummary(run: RunFile, dossierCount: number): EditorialRunSummary {
  return {
    runId: EditorialRunId.make(run.run_id),
    cutoffAt: run.cutoff_at,
    finishedAt: run.finished_at ?? null,
    status: run.status ?? "unknown",
    configVersion: run.config_version ?? null,
    sources: run.sources ?? [],
    dossierCount,
  };
}

const dayKey = (ms: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(ms));

/**
 * The 28 days before the cutoff. The engine starts a curve on the trend's first item, so
 * earlier days are zero; a day missing inside the curve was not captured.
 */
export function windowCurve(
  file: Pick<DossierFile, "curve" | "cutoff_at">,
  windowDays = CURVE_WINDOW_DAYS,
): ReadonlyArray<EditorialCurveDay> {
  const byDay = new Map(file.curve.map((day) => [day.day, day]));
  const firstDay = file.curve.reduce<string | null>(
    (first, day) => (first === null || day.day < first ? day.day : first),
    null,
  );
  const cutoffDay = Date.parse(`${file.cutoff_at.slice(0, 10)}T00:00:00.000Z`);
  const days: Array<EditorialCurveDay> = [];
  for (let offset = windowDays; offset >= 1; offset--) {
    const day = dayKey(cutoffDay - offset * DAY_MS);
    const known = byDay.get(day);
    if (known) {
      days.push({ ...known });
    } else {
      const beforeTrend = firstDay === null || day < firstDay;
      days.push({ day, items: 0, authors: 0, sources: 0, known: beforeTrend });
    }
  }
  return days;
}

const component = (file: DossierFile, name: string) =>
  file.rank.components?.find((entry) => entry.name === name)?.value ?? null;

const sum = (days: ReadonlyArray<EditorialCurveDay>, key: "items" | "authors") =>
  days.reduce((total, day) => total + day[key], 0);

/** Evidence links open outside the app: only http(s) survives, anything else becomes `null`. */
export function webUrlOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function evidenceItems(file: DossierFile): ReadonlyArray<EditorialEvidenceItem> {
  return (file.evidence ?? []).map((item) => ({
    itemId: item.item_id,
    source: item.source,
    title: item.title,
    author: item.author ?? null,
    publishedAt: item.published_at,
    permalink: webUrlOrNull(item.permalink),
    externalUrl: webUrlOrNull(item.external_url),
  }));
}

/** ISO instants of the same format sort as strings. */
export function evidenceRange(
  evidence: ReadonlyArray<EditorialEvidenceItem>,
): { readonly from: string; readonly to: string } | null {
  if (evidence.length === 0) return null;
  const dates = evidence.map((item) => item.publishedAt).toSorted();
  return { from: dates[0]!, to: dates.at(-1)! };
}

interface TrendBase {
  readonly file: DossierFile;
  readonly curve: ReadonlyArray<EditorialCurveDay>;
  readonly evidence: ReadonlyArray<EditorialEvidenceItem>;
  readonly items7d: number;
  readonly authors7d: number;
}

/** Competition ranking ("1224"): equal values share the better rank. */
export function competitionRanks(values: ReadonlyArray<number>): ReadonlyArray<number> {
  return values.map((value) => 1 + values.filter((other) => other > value).length);
}

/**
 * Builds the inbox rows of one run. `isNew` starts false; the read service sets it from the
 * inbox state in editorial.sqlite.
 */
export function loadRunDossiers(
  runId: string,
  files: ReadonlyArray<DossierFile>,
): ReadonlyArray<LoadedDossier> {
  const bases: ReadonlyArray<TrendBase> = files.map((file) => {
    const curve = windowCurve(file, file.coverage?.window_days || CURVE_WINDOW_DAYS);
    const lastWeek = curve.slice(-7);
    const logAuthors = component(file, "log_authors_7d");
    return {
      file,
      curve,
      evidence: evidenceItems(file),
      items7d: sum(lastWeek, "items"),
      // The engine counts distinct authors for the week; summing days would double count.
      authors7d:
        logAuthors === null ? sum(lastWeek, "authors") : Math.round(Math.expm1(logAuthors)),
    };
  });
  const volumeRanks = competitionRanks(bases.map((base) => base.items7d));
  const scoreRanks = competitionRanks(bases.map((base) => base.file.rank.score));
  return bases.map((base, index) => {
    const { file, curve, evidence } = base;
    const latestEvidence = evidence.reduce<EditorialEvidenceItem | null>(
      (latest, item) => (latest === null || item.publishedAt > latest.publishedAt ? item : latest),
      null,
    );
    const sources = new Set(evidence.map((item) => item.source));
    const trendKey = trendKeyOf(file);
    const lastActivityDay = file.curve.reduce<string | null>(
      (last, day) => (day.items > 0 && (last === null || day.day > last) ? day.day : last),
      null,
    );
    const summary: EditorialTrendSummary = {
      dossierId: EditorialDossierId.make(file.dossier_id),
      runId: EditorialRunId.make(runId),
      label: file.signal.label,
      terms: file.signal.top_terms ?? [],
      subtitle: latestEvidence?.title ?? null,
      stage: file.signal.stage ?? "unclassified",
      corroboration: file.signal.corroboration ?? "unknown",
      items7d: base.items7d,
      items28d: sum(curve, "items"),
      authors7d: base.authors7d,
      volumeRank: volumeRanks[index] ?? 1,
      scoreRank: scoreRanks[index] ?? 1,
      score: file.rank.score,
      growth: component(file, "growth"),
      affinity: file.profile?.include_score ?? null,
      sourceCount: Math.max(sources.size, ...curve.map((day) => day.sources)),
      sources: [...sources].toSorted(),
      sparkline: curve.slice(-SPARKLINE_DAYS).map((day) => (day.known ? day.items : null)),
      isNew: false,
      trendKey: trendKey.key,
    };
    return {
      file,
      trendKey,
      lastActivityDay,
      summary,
      curve,
      coverage: (file.coverage?.by_source ?? []).map((entry) => ({
        source: entry.source,
        windowDays: file.coverage?.window_days ?? CURVE_WINDOW_DAYS,
        daysComplete: entry.days_complete,
        daysPartial: entry.days_partial,
        daysUnavailable: entry.days_unavailable,
      })),
      evidence,
    };
  });
}

const descending = (a: number | null, b: number | null) => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};

/** `new-first-growth` is the default: unread first, then weekly growth (decision 3 of doc 04). */
export function compareTrends(
  sort: EditorialInboxSort,
): (a: EditorialTrendSummary, b: EditorialTrendSummary) => number {
  const tieBreak = (a: EditorialTrendSummary, b: EditorialTrendSummary) =>
    descending(a.score, b.score) || a.dossierId.localeCompare(b.dossierId);
  switch (sort) {
    case "new-first-growth":
      return (a, b) =>
        Number(b.isNew) - Number(a.isNew) || descending(a.growth, b.growth) || tieBreak(a, b);
    case "volume":
      return (a, b) =>
        descending(a.items7d, b.items7d) || descending(a.authors7d, b.authors7d) || tieBreak(a, b);
    case "affinity":
      return (a, b) => descending(a.affinity, b.affinity) || tieBreak(a, b);
  }
}
