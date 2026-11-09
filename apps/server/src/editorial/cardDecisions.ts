import type { EditorialCardDecision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

// "Ya decidido": a decision recorded before the cutoff on the same topic. Without centroids in
// the dossiers, same topic is the same trend key or half of the smaller evidence set shared
// (two items at least): the item half of the engine's `sameTopic`, without its 0.80 cosine gate.
// It can miss a topic retold with other items; it never merges two topics sharing no item.

/** The latest decision of each human video thread tied to a trend. Rehearsals do not count. */
export interface ThreadDecisionRow {
  readonly thread_id: string;
  readonly trend_key: string;
  readonly run_id: string | null;
  readonly dossier_id: string | null;
  readonly action: string;
  readonly utility: number | null;
  readonly reason: string | null;
  readonly decided_at: string;
}

export const selectThreadDecisions = (sql: SqlClient.SqlClient) =>
  sql<ThreadDecisionRow>`
    SELECT t.thread_id, t.trend_key, t.run_id, t.dossier_id, d.action, d.utility, d.reason,
      d.decided_at
    FROM editorial_decisions d
    JOIN editorial_video_threads t ON t.thread_id = d.thread_id
    WHERE t.trend_key IS NOT NULL AND t.cohort = 'human'
      AND d.rowid = (
        SELECT d2.rowid FROM editorial_decisions d2 WHERE d2.thread_id = d.thread_id
        ORDER BY d2.decided_at DESC, d2.rowid DESC LIMIT 1
      )
    ORDER BY d.decided_at DESC, d.rowid DESC
  `.pipe(Effect.map((rows): ReadonlyArray<ThreadDecisionRow> => rows));

const ACTIONS = new Set(["accept", "edit", "reject"]);

function toCardDecision(row: ThreadDecisionRow): EditorialCardDecision | null {
  if (!ACTIONS.has(row.action) || Number.isNaN(Date.parse(row.decided_at))) return null;
  return {
    threadId: row.thread_id,
    action: row.action as EditorialCardDecision["action"],
    utility:
      typeof row.utility === "number" && Number.isSafeInteger(row.utility) && row.utility >= 0
        ? row.utility
        : null,
    reason: row.reason,
    decidedAt: row.decided_at,
  };
}

/** What the topic rule compares of a dossier. */
export interface TopicFingerprint {
  readonly trendKey: string;
  readonly itemIds: ReadonlySet<string>;
}

const MIN_SHARED_ITEMS = 2;
const SHARED_ITEMS_MIN_FRACTION = 0.5;

/** Same trend, or at least half of the smaller evidence set shared (two items minimum). */
export function sameTopicByItems(a: TopicFingerprint, b: TopicFingerprint): boolean {
  if (a.trendKey === b.trendKey) return true;
  const [small, large] = a.itemIds.size <= b.itemIds.size ? [a, b] : [b, a];
  if (small.itemIds.size === 0) return false;
  let shared = 0;
  for (const id of small.itemIds) if (large.itemIds.has(id)) shared++;
  return shared >= MIN_SHARED_ITEMS && shared >= SHARED_ITEMS_MIN_FRACTION * small.itemIds.size;
}

/** Newest first, as `selectThreadDecisions` returns them. */
export function latestDecisionOf(
  trendKey: string,
  rows: ReadonlyArray<ThreadDecisionRow>,
): EditorialCardDecision | null {
  for (const row of rows) {
    if (row.trend_key !== trendKey) continue;
    const decision = toCardDecision(row);
    if (decision !== null) return decision;
  }
  return null;
}

/**
 * The latest decision recorded before `cutoffAt` on the same topic as `trend`. `fingerprintOf`
 * gives the decided dossier's fingerprint (null when its run is gone: then only the same trend
 * key matches).
 */
export function priorDecisionOf(
  trend: TopicFingerprint,
  cutoffAt: string,
  rows: ReadonlyArray<ThreadDecisionRow>,
  fingerprintOf: (row: ThreadDecisionRow) => TopicFingerprint | null,
): EditorialCardDecision | null {
  const cutoffMs = Date.parse(cutoffAt);
  if (Number.isNaN(cutoffMs)) return null;
  for (const row of rows) {
    const decidedMs = Date.parse(row.decided_at);
    if (Number.isNaN(decidedMs) || decidedMs >= cutoffMs) continue;
    const other = fingerprintOf(row) ?? { trendKey: row.trend_key, itemIds: new Set<string>() };
    if (!sameTopicByItems(trend, other)) continue;
    const decision = toCardDecision(row);
    if (decision !== null) return decision;
  }
  return null;
}
