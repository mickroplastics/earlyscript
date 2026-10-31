import {
  SOURCE_CATALOG,
  type CatalogSourceId,
} from "@earlyscript/editorial-contracts/sourceCatalog";
import type {
  EditorialSourceCapture,
  EditorialSourceCaptureStatus,
  EditorialSourceGap,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One coverage.jsonl row, read without failing on a source this build does not know. */
export interface CoverageRow {
  readonly source: string;
  readonly day: string;
  readonly status: EditorialSourceCaptureStatus;
  readonly items: number;
  readonly retrieved_at: string;
  readonly note: string | null;
}

export interface SourceCoverageSummary {
  readonly lastCapture: EditorialSourceCapture | null;
  readonly recentGaps: ReadonlyArray<EditorialSourceGap>;
}

/** Days of the corpus's last week checked for gaps. */
const RECENT_GAP_DAYS = 7;

const DAY_MS = 86_400_000;
const dayMillis = (day: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T00:00:00Z`));
const dayOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis)).slice(0, 10);

const gapReason = (
  source: CatalogSourceId,
  row: CoverageRow | undefined,
): EditorialSourceGap["reason"] | null => {
  if (row === undefined) return "not_collected";
  switch (row.status) {
    case "complete":
      return null;
    case "partial":
      return SOURCE_CATALOG[source].coverage === "sample" ? null : "partial";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
      return "fetch_failed";
  }
};

/**
 * The last day the corpus holds for `source` and the days of the corpus's last week
 * (`toDay` exclusive) without a full collection. A source the corpus never held has no
 * capture and no gaps: nothing was attempted, so nothing is missing. Gaps start at the
 * source's first day, so a source added this week is not blamed for the days before it.
 */
export function summarizeSourceCoverage(
  source: CatalogSourceId,
  rows: ReadonlyArray<CoverageRow>,
  toDay: string,
): SourceCoverageSummary {
  const byDay = new Map(rows.filter((row) => row.source === source).map((row) => [row.day, row]));
  if (byDay.size === 0) return { lastCapture: null, recentGaps: [] };
  const days = [...byDay.keys()].toSorted();
  const last = byDay.get(days.at(-1)!)!;
  const firstMillis = dayMillis(days[0]!);
  const endMillis = dayMillis(toDay);
  const recentGaps: Array<EditorialSourceGap> = [];
  for (let offset = RECENT_GAP_DAYS; offset >= 1; offset -= 1) {
    const millis = endMillis - offset * DAY_MS;
    if (millis < firstMillis) continue;
    const day = dayOf(millis);
    const reason = gapReason(source, byDay.get(day));
    if (reason !== null) recentGaps.push({ day, reason });
  }
  return {
    lastCapture: {
      day: last.day,
      status: last.status,
      items: last.items,
      retrievedAt: last.retrieved_at,
      note: last.note,
    },
    recentGaps,
  };
}
