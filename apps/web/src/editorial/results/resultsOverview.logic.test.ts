import type {
  EditorialDurationStats,
  EditorialResultsComparison,
  EditorialResultsDecision,
  EditorialResultsSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeResultsTab,
  citationShare,
  compactDurations,
  completeProcessPoints,
  headerLineText,
  resultsTabFromSearch,
  rowDateText,
  scriptRows,
  shortResultsDate,
  splitValueUnit,
  stripLayout,
  timeStripText,
  timeZoneLabel,
  trialsWithoutDecision,
  utilityDistributionText,
  visibleTabs,
} from "./resultsOverview.logic";

const MINUTE = 60_000;
const ZONE = "America/Guayaquil";

const plain = (text: string) => text.replaceAll(" ", " ");

const stats = (n: number, median: number | null = null): EditorialDurationStats => ({
  n,
  medianMs: median === null ? null : median * MINUTE,
  q1Ms: median === null ? null : median * MINUTE,
  q3Ms: median === null ? null : median * MINUTE,
  minMs: null,
  maxMs: null,
});

const modeEntry = (
  mode: "assisted" | "manual",
  overrides: Partial<EditorialResultsSummary["modes"][number]> = {},
): EditorialResultsSummary["modes"][number] => ({
  mode,
  threads: 0,
  provisionalClock: 0,
  actions: { accept: 0, edit: 0, reject: 0 },
  stages: [],
  total: stats(0),
  partialCoverage: 0,
  utility: { n: 0, mean: null, distribution: [0, 0, 0, 0, 0] },
  citations: { threads: 0, claims: 0, cited: 0, ratio: null },
  withVideoResults: 0,
  ...overrides,
});

const summary = (overrides: Partial<EditorialResultsSummary> = {}): EditorialResultsSummary => ({
  modes: [modeEntry("assisted"), modeEntry("manual")],
  comparisons: [],
  inbox: { read: 0, observing: 0, dismissed: 0, production: 0 },
  excludedByDomain: 0,
  decisionCount: 0,
  firstDecidedAt: null,
  lastDecidedAt: null,
  asOf: "2026-11-12T00:00:00.000Z",
  ...overrides,
});

const decision = (
  id: string,
  overrides: Partial<EditorialResultsDecision> = {},
): EditorialResultsDecision => {
  return {
    decisionId: id,
    threadId: `thread-${id}`,
    environmentId: "env-1",
    mode: "assisted",
    trendKey: null,
    trendLabel: null,
    runId: null,
    dossierId: null,
    action: "accept",
    utility: 5,
    reason: null,
    decidedAt: "2026-11-09T20:30:00.000Z",
    current: true,
    clockDefinitive: true,
    stages: ["read", "write", "decide"],
    coverage: "complete",
    durations: {
      exploreMs: null,
      readMs: MINUTE,
      writeMs: 8 * MINUTE,
      decideMs: MINUTE,
      totalMs: 10 * MINUTE,
    },
    script: null,
    video: null,
    ...overrides,
  };
};

const total = (assisted: number, manual: number): EditorialResultsComparison => ({
  key: "total",
  assisted: stats(assisted, assisted === 0 ? null : 10),
  manual: stats(manual, manual === 0 ? null : 30),
  partial: { assisted: 0, manual: 0 },
});

describe("completeProcessPoints", () => {
  const kept = [
    decision("d1", { durations: { ...decision("d2").durations, totalMs: 12 * MINUTE } }),
    decision("d3", {
      mode: "manual",
      durations: { ...decision("d4").durations, totalMs: 30 * MINUTE },
    }),
  ];
  const left = [
    decision("d5", { cohort: "trial" }),
    decision("d6", { current: false }),
    decision("d7", { clockDefinitive: false }),
    decision("d8", { coverage: "partial" }),
  ];
  const page = (decisions: ReadonlyArray<EditorialResultsDecision>, extra = 0) => ({
    decisions,
    total: decisions.length + extra,
    offset: 0,
  });

  it("takes the threads of the whole-process comparison and nothing else", () => {
    expect(completeProcessPoints(page([...kept, ...left]), total(1, 1))).toEqual({
      assisted: [12 * MINUTE],
      manual: [30 * MINUTE],
    });
  });

  it("gives no dots when they could contradict the printed median", () => {
    // One decision the client cannot see, or one the server left out by domain.
    expect(completeProcessPoints(page(kept, 1), total(1, 1))).toBeNull();
    expect(completeProcessPoints(page(kept), total(2, 1))).toBeNull();
  });
});

describe("stripLayout", () => {
  it("stacks equal values without moving them sideways", () => {
    const dots = stripLayout([10 * MINUTE, 10.2 * MINUTE, 20 * MINUTE], 40 * MINUTE);
    expect(dots.map((dot) => dot.stack)).toEqual([0, 1, 0]);
    expect(dots[0]?.x).toBe(0.25);
    expect(dots[1]?.x).toBeCloseTo(0.255);
  });
});

describe("timeStripText", () => {
  it("lists every thread with one unit and the median", () => {
    const text = timeStripText(
      { assisted: [5 * MINUTE, 8.5 * MINUTE, 12 * MINUTE], manual: [] },
      total(3, 0),
    );
    expect(plain(text)).toBe(
      "Asistido: 5, 8,5 y 12 min; mediana 10 min. Manual: sin hilos medidos.",
    );
  });

  it("keeps the units when they differ", () => {
    expect(compactDurations(["45 min", "1 h 5 min"])).toEqual(["45 min", "1 h 5 min"]);
    expect(splitValueUnit("10,5 min")).toEqual(["10,5", "min"]);
  });
});

describe("dates", () => {
  it("says the zone once and the year only when it changes", () => {
    const dated = (first: string, last: string) =>
      plain(
        headerLineText(
          summary({
            decisionCount: 12,
            firstDecidedAt: first,
            lastDecidedAt: last,
            modes: [modeEntry("assisted", { threads: 6 }), modeEntry("manual", { threads: 1 })],
          }),
          ZONE,
        ),
      );
    expect(dated("2026-11-09T20:30:00.000Z", "2026-11-10T05:11:00.000Z")).toBe(
      "12 decisiones · 9 nov, 15:30 a 10 nov 2026, 0:11 (Guayaquil) · 6 hilos asistidos y 1 manual cerrados",
    );
    expect(dated("2026-12-31T20:00:00.000Z", "2027-01-02T20:00:00.000Z")).toContain(
      "31 dic 2026, 15:00 a 2 ene 2027, 15:00 (Guayaquil)",
    );
    expect(dated("2026-11-09T20:30:00.000Z", "2026-11-09T23:00:00.000Z")).toContain(
      "9 nov 2026, 15:30 a 18:00 (Guayaquil)",
    );
    expect(shortResultsDate("2026-11-10T05:11:00.000Z", { year: true, timeZone: ZONE })).toBe(
      "10 nov 2026, 0:11",
    );
    const last = "2026-11-10T05:11:00.000Z";
    expect(rowDateText("2026-11-03T20:00:00.000Z", last, ZONE)).toBe("3 nov, 15:00");
    expect(rowDateText("2025-12-03T20:00:00.000Z", last, ZONE)).toBe("3 dic 2025, 15:00");
  });

  it("names the zone by its city", () => {
    expect(timeZoneLabel("America/Guayaquil")).toBe("Guayaquil");
    expect(timeZoneLabel("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
    expect(timeZoneLabel("UTC")).toBe("UTC");
  });
});

describe("overview cards", () => {
  it("describes the utility distribution without empty scores", () => {
    const text = utilityDistributionText(
      summary({
        modes: [
          modeEntry("assisted", { utility: { n: 6, mean: 5, distribution: [0, 0, 0, 0, 6] } }),
          modeEntry("manual", { utility: { n: 6, mean: 3.8, distribution: [0, 0, 2, 3, 1] } }),
        ],
      }),
    );
    expect(text).toBe(
      "Fichas por puntuación. Asistido: 6 con 5. Manual: 2 con 3, 3 con 4 y 1 con 5.",
    );
  });

  it("shares nothing without claims", () => {
    expect(citationShare(modeEntry("assisted"))).toBe(0);
    expect(citationShare(undefined)).toBe(0);
  });

  it("lists one script per current human decision of the mode, newest first", () => {
    const older = decision("d9", { decidedAt: "2026-11-09T10:00:00.000Z" });
    const newer = decision("d10", { decidedAt: "2026-11-09T12:00:00.000Z" });
    const rows = scriptRows(
      [
        older,
        decision("d11", { current: false }),
        decision("d12", { cohort: "trial" }),
        decision("d13", { mode: "manual" }),
        newer,
      ],
      "assisted",
    );
    expect(rows.map((row) => row.decisionId)).toEqual([newer.decisionId, older.decisionId]);
  });

  it("keeps the trials no row links to", () => {
    const trials = [{ threadId: "a" }, { threadId: "b" }];
    expect(trialsWithoutDecision(trials, [{ threadId: "a" }])).toEqual([{ threadId: "b" }]);
  });
});

describe("tabs", () => {
  it("keeps the manual baseline and the inbox, once it moved, before the first decision", () => {
    const quiet = summary();
    expect(visibleTabs(quiet).map((tab) => tab.id)).toEqual(["linea-base"]);
    const read = { ...quiet, inbox: { ...quiet.inbox, read: 2 } };
    expect(visibleTabs(read).map((tab) => tab.id)).toEqual(["linea-base", "bandeja"]);
    expect(visibleTabs({ ...read, decisionCount: 1 })).toHaveLength(5);
  });

  it("falls back to the first visible tab", () => {
    const quiet = visibleTabs(summary());
    expect(resultsTabFromSearch("decisiones")).toBe("decisiones");
    expect(resultsTabFromSearch("tiempos")).toBeUndefined();
    expect(activeResultsTab(undefined, visibleTabs(null))).toBe("etapas");
    expect(activeResultsTab("decisiones", quiet)).toBe("linea-base");
  });
});
