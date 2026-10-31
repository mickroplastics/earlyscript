import {
  EditorialRunId,
  EditorialSnoozeMetric,
  type EditorialSnoozeReturn,
  type EditorialTrendInboxState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { SnoozeReturnCondition, TrendInboxState } from "./persistence/EditorialModel.ts";

/** What the inbox rules need to know about the revision on screen. */
export interface TrendRevision {
  /** Cutoff of the run the dossier belongs to. */
  readonly runCutoffAt: string;
  /** Last day of the curve with items, or null when the curve is empty. */
  readonly lastActivityDay: string | null;
}

/** A snooze is in effect until its `until` passes; growth returns are written by the importer. */
function isSnoozedAt(state: TrendInboxState, now: number): boolean {
  if (state.snoozedAt === null) return false;
  return state.snoozedUntil === null || Date.parse(state.snoozedUntil) > now;
}

/**
 * New = activity after the revision last opened, the trend counterpart of a thread's unseen
 * completion. Never opened is new. Opened in an older run is new again only when the current
 * dossier has items on or after the cutoff of that run, which the operator could not have
 * seen. A snoozed or dismissed trend is never new.
 */
function isNewRevision(state: TrendInboxState, revision: TrendRevision, now: number): boolean {
  if (state.dismissedAt !== null || isSnoozedAt(state, now)) return false;
  if (state.seenRunCutoffAt === null) return true;
  if (Date.parse(revision.runCutoffAt) <= Date.parse(state.seenRunCutoffAt)) return false;
  return (
    revision.lastActivityDay !== null &&
    revision.lastActivityDay >= state.seenRunCutoffAt.slice(0, 10)
  );
}

const isSnoozeMetric = Schema.is(EditorialSnoozeMetric);

/** Stored conditions use a free metric name; only the ones the contract knows go out. */
const toSnoozeReturn = (condition: SnoozeReturnCondition | null): EditorialSnoozeReturn | null =>
  condition !== null && isSnoozeMetric(condition.metric)
    ? { metric: condition.metric, baseline: condition.baseline, atLeast: condition.atLeast }
    : null;

/** The contract view of one stored inbox row. */
export function toTrendInboxState(
  state: TrendInboxState,
  revision: TrendRevision | null,
  now: number,
): EditorialTrendInboxState {
  return {
    isNew: revision === null ? false : isNewRevision(state, revision, now),
    seenRunId: state.seenRunId === null ? null : EditorialRunId.make(state.seenRunId),
    seenAt: state.seenAt,
    snoozed:
      state.snoozedAt !== null && isSnoozedAt(state, now)
        ? {
            at: state.snoozedAt,
            until: state.snoozedUntil,
            returnWhen: toSnoozeReturn(state.snoozeReturn),
          }
        : null,
    dismissed:
      state.dismissedAt === null
        ? null
        : { at: state.dismissedAt, reason: state.dismissedReason ?? "" },
    production:
      state.productionThreadId === null || state.productionLinkedAt === null
        ? null
        : { threadId: state.productionThreadId, linkedAt: state.productionLinkedAt },
  };
}
