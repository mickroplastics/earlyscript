import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  type EditorialInbox,
  type EditorialTrendInboxState,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyEditorialStreamItem, EMPTY_INBOX_VIEW, withLiveInboxState } from "./state";

const RUN = EditorialRunId.make("run-1");
const NEW_STATE: EditorialTrendInboxState = {
  isNew: true,
  seenRunId: null,
  seenAt: null,
  snoozed: null,
  dismissed: null,
  production: null,
};

const trend = (key: string): EditorialTrendSummary => ({
  dossierId: EditorialDossierId.make(`dos_${key}`),
  runId: RUN,
  label: key,
  terms: [key],
  subtitle: null,
  stage: "growing",
  corroboration: "single_source",
  items7d: 1,
  items28d: 1,
  authors7d: 1,
  volumeRank: 1,
  scoreRank: 1,
  score: 1,
  growth: 0,
  affinity: 0.7,
  sourceCount: 1,
  sources: ["hn"],
  sparkline: [],
  isNew: true,
  trendKey: EditorialTrendKey.make(key),
  inbox: NEW_STATE,
});

const inbox: EditorialInbox = {
  run: null,
  sort: "new-first-growth",
  trends: [trend("a"), trend("b")],
  total: 2,
  newCount: 2,
  snoozedCount: 0,
  dismissedCount: 0,
};

describe("applyEditorialStreamItem", () => {
  it("replaces the view on a snapshot and patches one trend in place on a delta", () => {
    const snapshot = applyEditorialStreamItem(EMPTY_INBOX_VIEW, {
      _tag: "snapshot",
      seq: 4,
      inbox,
    });
    expect(snapshot).toEqual({ seq: 4, inbox });

    const dismissed = {
      ...NEW_STATE,
      isNew: false,
      dismissed: { at: "2026-10-30T10:00:00.000Z", reason: "No" },
    };
    const next = applyEditorialStreamItem(snapshot, {
      _tag: "trend",
      seq: 5,
      trendKey: EditorialTrendKey.make("a"),
      state: dismissed,
      newCount: 1,
    });
    expect(next.seq).toBe(5);
    expect(next.inbox?.trends.map((row) => [row.trendKey, row.isNew])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(next.inbox?.trends[0]?.inbox).toEqual(dismissed);
    expect(next.inbox?.newCount).toBe(1);
    expect(next.inbox?.dismissedCount).toBe(1);

    // A replayed older item never moves the sequence back.
    expect(
      applyEditorialStreamItem(next, {
        _tag: "trend",
        seq: 3,
        trendKey: EditorialTrendKey.make("b"),
        state: NEW_STATE,
        newCount: 1,
      }).seq,
    ).toBe(5);
  });
});

describe("withLiveInboxState", () => {
  const run = {
    runId: EditorialRunId.make("run-1"),
    cutoffAt: "2026-10-19T00:00:00.000Z",
    finishedAt: null,
    status: "ok",
    configVersion: null,
    sources: ["hn"],
    dossierCount: 2,
  };
  const production = {
    ...NEW_STATE,
    isNew: false,
    production: { threadId: "thread-video", linkedAt: "2026-10-31T08:00:00.000Z" },
  };

  it("keeps the read's titles and takes each trend's state from the subscription", () => {
    const read: EditorialInbox = {
      ...inbox,
      run,
      trends: [{ ...trend("a"), label: "drafted later" }, trend("b")],
    };
    const live: EditorialInbox = {
      ...inbox,
      run,
      trends: [{ ...trend("a"), isNew: false, inbox: production }, trend("b")],
      newCount: 1,
    };
    const merged = withLiveInboxState(read, live);
    expect(merged.trends[0]?.label).toBe("drafted later");
    expect(merged.trends[0]?.inbox).toEqual(production);
    expect(merged.trends[0]?.isNew).toBe(false);
    expect(merged.newCount).toBe(1);

    // A run the read has not seen yet replaces it; without a subscription the read stands.
    const newerRun = { ...live, run: { ...run, runId: EditorialRunId.make("run-2") } };
    expect(withLiveInboxState(read, newerRun)).toBe(newerRun);
    expect(withLiveInboxState(read, null)).toBe(read);
  });
});
