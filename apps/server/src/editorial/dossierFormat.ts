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
import {
  DOSSIER_SCHEMA_VERSION,
  DOSSIER_V2_SCHEMA_VERSION,
  Dossier,
  DossierV2,
  type CurvePoint,
} from "@earlyscript/editorial-contracts/dossier";
import {
  EarlywindowDossier,
  fromEarlywindowRun,
} from "@earlyscript/editorial-contracts/earlywindow";
import { RUN_SCHEMA_VERSION, RunRecord } from "@earlyscript/editorial-contracts/run";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { cardOf, NO_EXTRAS, type DossierExtras } from "./dossierCard.ts";
import { trendKeyOf, type TrendKey } from "./trendKey.ts";

// Reader for the runs directory: native dossier/1 and /2 (engine.v3) and Earlywindow's
// dossier/1 all become the native `Dossier`. A dossier/2's `movement` block reaches the card
// through `readDossierExtras`, which reads the file's text.

const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String));

/** Earlywindow's run.json: no `schema_version`, so a broken native run.json cannot pass as one. */
const EarlywindowRunFile = Schema.Struct({
  schema_version: Schema.optionalKey(Schema.Never),
  run_id: Schema.String,
  cutoff_at: Schema.String,
  finished_at: OptionalText,
  status: Schema.optionalKey(Schema.String),
  config_version: OptionalText,
  sources: Schema.optionalKey(Schema.Array(Schema.String)),
  engine_version: OptionalText,
  config_hash: OptionalText,
  corpus_hash: OptionalText,
  logical_hash: OptionalText,
});

const RunFile = Schema.Union([RunRecord, EarlywindowRunFile]);
type RunFile = typeof RunFile.Type;

/** One dossier file in any format; `toDossiers` converts a run's files to `Dossier`. */
const DossierFile = Schema.Union([Dossier, DossierV2, EarlywindowDossier]);
export type DossierFile = typeof DossierFile.Type;

/** What the editorial space keeps of a run.json, named after its keys. */
export interface RunInfo {
  readonly run_id: string;
  readonly cutoff_at: string;
  readonly finished_at: string | null;
  readonly status: string;
  /** null for Earlywindow, whose run.json has none. */
  readonly schema_version: string | null;
  readonly engine_version: string | null;
  readonly config_version: string | null;
  readonly config_hash: string | null;
  /** Earlywindow: its whole corpus_hash. Native: the frozen corpus's manifest hash. */
  readonly corpus_hash: string | null;
  /** Native only: the hash of what the run read before the cutoff. */
  readonly corpus_used_hash: string | null;
  readonly logical_hash: string | null;
  /** Native only: the hash of the channel profile file the run scored with. */
  readonly profile_hash: string | null;
  readonly sources: ReadonlyArray<string>;
  /** Native only; Earlywindow keeps coverage in each dossier. */
  readonly coverage: unknown;
  /** `profile.include_min` the run applied. */
  readonly include_min: number;
}

/** engine.v0.02 `profile.include_min`: an Earlywindow run.json does not carry its config. */
const EARLYWINDOW_INCLUDE_MIN = 0.6;
const CURVE_WINDOW_DAYS = 28;
const SPARKLINE_DAYS = 14;
const DAY_MS = 86_400_000;

export interface LoadedDossier {
  readonly file: Dossier;
  readonly trendKey: TrendKey;
  /** Last curve day with items, or null; the inbox compares it with the revision seen. */
  readonly lastActivityDay: string | null;
  readonly summary: EditorialTrendSummary;
  readonly curve: ReadonlyArray<EditorialCurveDay>;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
  readonly evidence: ReadonlyArray<EditorialEvidenceItem>;
  /** The judges' opinion the dossier carries; never part of `summary`. */
  readonly judges: DossierExtras["judges"];
}

function toRunInfo(run: RunFile): RunInfo {
  if (run.schema_version === RUN_SCHEMA_VERSION) {
    return {
      run_id: run.run_id,
      cutoff_at: run.cutoff_at,
      finished_at: run.finished_at,
      status: run.status,
      schema_version: run.schema_version,
      engine_version: run.engine_version,
      config_version: run.config?.config_version ?? null,
      config_hash: run.config_hash,
      corpus_hash: run.corpus?.corpus_manifest_hash ?? null,
      corpus_used_hash: run.corpus?.corpus_used_hash ?? null,
      logical_hash: run.logical_hash,
      profile_hash: run.profile?.hash ?? null,
      sources: run.config?.sources ?? [],
      coverage: run.coverage,
      include_min: run.config?.profile.include_min ?? EARLYWINDOW_INCLUDE_MIN,
    };
  }
  return {
    run_id: run.run_id,
    cutoff_at: run.cutoff_at,
    finished_at: run.finished_at ?? null,
    status: run.status ?? "unknown",
    schema_version: null,
    engine_version: run.engine_version ?? null,
    config_version: run.config_version ?? null,
    config_hash: run.config_hash ?? null,
    corpus_hash: run.corpus_hash ?? null,
    corpus_used_hash: null,
    logical_hash: run.logical_hash ?? null,
    profile_hash: null,
    sources: run.sources ?? [],
    coverage: null,
    include_min: EARLYWINDOW_INCLUDE_MIN,
  };
}

const decodeRunFile = Schema.decodeUnknownEffect(Schema.fromJsonString(RunFile));

/** Decodes the text of a run.json in either format. */
export const decodeRunJson = (text: string) => decodeRunFile(text).pipe(Effect.map(toRunInfo));

/** Decodes the text of one dossier file in either format; `toDossiers` finishes the run. */
export const decodeDossierJson = Schema.decodeUnknownEffect(Schema.fromJsonString(DossierFile));

export function runSummary(run: RunInfo, dossierCount: number): EditorialRunSummary {
  return {
    runId: EditorialRunId.make(run.run_id),
    cutoffAt: run.cutoff_at,
    finishedAt: run.finished_at,
    status: run.status,
    configVersion: run.config_version,
    sources: run.sources,
    dossierCount,
  };
}

/**
 * A `dossier/2` as `Dossier`: the fields both share, with the evidence items' week and
 * `also_in` left out. `movement` stays in the file for the card.
 */
function fromDossierV2(file: DossierV2): Dossier {
  return {
    schema_version: DOSSIER_SCHEMA_VERSION,
    origin: file.origin,
    dossier_id: file.dossier_id,
    run_id: file.run_id,
    created_at: file.created_at,
    cutoff_at: file.cutoff_at,
    engine: file.engine,
    profile: file.profile,
    trend: file.trend,
    profile_fit: file.profile_fit,
    rankings: file.rankings,
    related: file.related,
    curve: file.curve,
    coverage: file.coverage,
    data_gaps: file.data_gaps,
    evidence: file.evidence.map(({ week: _week, also_in: _alsoIn, ...item }) => item),
    evidence_status: file.evidence_status,
  };
}

/**
 * The run's dossiers as `Dossier`, in the order given. Earlywindow dossiers take their ranking
 * positions from the whole run, so they convert together.
 */
export function toDossiers(files: ReadonlyArray<DossierFile>): ReadonlyArray<Dossier> {
  const converted = new Map(
    fromEarlywindowRun(
      files.filter((file): file is EarlywindowDossier => file.schema_version === "dossier/1"),
    ).map((dossier) => [dossier.dossier_id, dossier]),
  );
  return files.map((file) => {
    if (file.schema_version === DOSSIER_SCHEMA_VERSION) return file;
    if (file.schema_version === DOSSIER_V2_SCHEMA_VERSION) return fromDossierV2(file);
    return converted.get(file.dossier_id)!;
  });
}

const dayKey = (ms: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(ms));

/**
 * The 28 days before the cutoff. The engine starts a curve on the trend's first item, so
 * earlier days are zero; a day missing inside the curve was not captured.
 */
export function windowCurve(
  file: Pick<Dossier, "cutoff_at"> & { readonly curve: ReadonlyArray<CurvePoint> },
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

function evidenceItems(file: Dossier): ReadonlyArray<EditorialEvidenceItem> {
  return file.evidence.map((item) => ({
    itemId: item.item_id,
    source: item.source,
    title: item.title,
    excerpt: item.excerpt,
    author: item.author,
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

/**
 * Builds the inbox rows of one run, in the order given. Counts and both ranking positions are
 * the engine's (for Earlywindow, what `fromEarlywindowRun` rebuilt). `isNew` starts false; the
 * read service sets it from the inbox state in editorial.sqlite.
 */
export function loadRunDossiers(
  runId: string,
  files: ReadonlyArray<Dossier>,
  extras: ReadonlyArray<DossierExtras> = [],
): ReadonlyArray<LoadedDossier> {
  return files.map((file, index) => {
    const extra = extras[index] ?? NO_EXTRAS;
    const { trend, rankings } = file;
    const curve = windowCurve(file, file.coverage.window_days || CURVE_WINDOW_DAYS);
    const evidence = evidenceItems(file);
    const latestEvidence = evidence.reduce<EditorialEvidenceItem | null>(
      (latest, item) => (latest === null || item.publishedAt > latest.publishedAt ? item : latest),
      null,
    );
    const trendKey = trendKeyOf({
      dossier_id: file.dossier_id,
      signal: { id: trend.id, top_terms: trend.top_terms },
    });
    const lastActivityDay = file.curve.reduce<string | null>(
      (last, day) => (day.items > 0 && (last === null || day.day > last) ? day.day : last),
      null,
    );
    const summary: EditorialTrendSummary = {
      dossierId: EditorialDossierId.make(file.dossier_id),
      runId: EditorialRunId.make(runId),
      label: trend.label,
      terms: trend.top_terms,
      subtitle: latestEvidence?.title ?? null,
      stage: trend.stage,
      corroboration: trend.corroboration,
      items7d: trend.items_7d,
      items28d: sum(curve, "items"),
      authors7d: trend.authors_7d,
      volumeRank: rankings.baseline.position,
      scoreRank: rankings.weighted.position,
      score: rankings.weighted.score,
      growth: trend.growth,
      affinity: file.profile_fit.include_score,
      sourceCount: Math.max(trend.sources.length, ...curve.map((day) => day.sources)),
      sources: trend.sources,
      sparkline: curve.slice(-SPARKLINE_DAYS).map((day) => (day.known ? day.items : null)),
      isNew: false,
      trendKey: trendKey.key,
      card: cardOf(file, curve, extra.card),
    };
    return {
      file,
      trendKey,
      lastActivityDay,
      summary,
      curve,
      coverage: file.coverage.by_source.map((entry) => ({
        source: entry.source,
        windowDays: file.coverage.window_days,
        daysComplete: entry.days_complete,
        daysPartial: entry.days_partial,
        daysUnavailable: entry.days_unavailable,
      })),
      evidence,
      judges: extra.judges,
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
