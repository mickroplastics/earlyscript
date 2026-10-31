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
  Dossier,
  type CurvePoint,
} from "@earlyscript/editorial-contracts/dossier";
import {
  EarlywindowDossier,
  fromEarlywindowRun,
} from "@earlyscript/editorial-contracts/earlywindow";
import { RUN_SCHEMA_VERSION, RunRecord } from "@earlyscript/editorial-contracts/run";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

// Reader for the runs directory. The trend engine writes `earlyscript.run/1` and
// `earlyscript.dossier/1`; Earlywindow's run.json and `dossier/1` are read for compatibility
// and converted to the native `Dossier`, the only shape the editorial space works with.

/** Earlywindow's run.json: no `schema_version`, so a broken native run.json cannot pass as one. */
const EarlywindowRunFile = Schema.Struct({
  schema_version: Schema.optionalKey(Schema.Never),
  run_id: Schema.String,
  cutoff_at: Schema.String,
  finished_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.String),
  config_version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sources: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const RunFile = Schema.Union([RunRecord, EarlywindowRunFile]);
export type RunFile = typeof RunFile.Type;

/** One dossier file in either format; `toDossiers` converts a run's files to `Dossier`. */
export const DossierFile = Schema.Union([Dossier, EarlywindowDossier]);
export type DossierFile = typeof DossierFile.Type;

/** engine.v0.02 `profile.include_min`: an Earlywindow run.json does not carry its config. */
const AFFINITY_THRESHOLD = 0.6;
const CURVE_WINDOW_DAYS = 28;
const SPARKLINE_DAYS = 14;
const DAY_MS = 86_400_000;

export interface LoadedDossier {
  readonly file: Dossier;
  readonly summary: EditorialTrendSummary;
  readonly curve: ReadonlyArray<EditorialCurveDay>;
  readonly coverage: ReadonlyArray<EditorialSourceCoverage>;
  readonly evidence: ReadonlyArray<EditorialEvidenceItem>;
}

export function runSummary(run: RunFile, dossierCount: number): EditorialRunSummary {
  const config =
    run.schema_version === RUN_SCHEMA_VERSION
      ? { configVersion: run.config?.config_version ?? null, sources: run.config?.sources ?? [] }
      : { configVersion: run.config_version ?? null, sources: run.sources ?? [] };
  return {
    runId: EditorialRunId.make(run.run_id),
    cutoffAt: run.cutoff_at,
    finishedAt: run.finished_at ?? null,
    status: run.status ?? "unknown",
    ...config,
    dossierCount,
  };
}

/** The `profile.include_min` the run applied. */
export function affinityThreshold(run: RunFile): number {
  return run.schema_version === RUN_SCHEMA_VERSION
    ? (run.config?.profile.include_min ?? AFFINITY_THRESHOLD)
    : AFFINITY_THRESHOLD;
}

/** Earlywindow dossiers take their ranking positions from the whole run, so they convert together. */
export function toDossiers(files: ReadonlyArray<DossierFile>): ReadonlyArray<Dossier> {
  const native = files.filter(
    (file): file is Dossier => file.schema_version === DOSSIER_SCHEMA_VERSION,
  );
  const earlywindow = files.filter(
    (file): file is EarlywindowDossier => file.schema_version === "dossier/1",
  );
  return [...native, ...fromEarlywindowRun(earlywindow)];
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
 * Builds the inbox rows of one run. Counts and both ranking positions are the engine's (for
 * Earlywindow, what `fromEarlywindowRun` rebuilt). `isNew` marks every trend of the latest run
 * until the inbox has read state (U3); that is the extension point for unread counts.
 */
export function loadRunDossiers(
  runId: string,
  files: ReadonlyArray<Dossier>,
  options: { readonly isLatestRun: boolean },
): ReadonlyArray<LoadedDossier> {
  return files.map((file) => {
    const { trend, rankings } = file;
    const curve = windowCurve(file, file.coverage.window_days || CURVE_WINDOW_DAYS);
    const evidence = evidenceItems(file);
    const latestEvidence = evidence.reduce<EditorialEvidenceItem | null>(
      (latest, item) => (latest === null || item.publishedAt > latest.publishedAt ? item : latest),
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
      isNew: options.isLatestRun,
    };
    return {
      file,
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
