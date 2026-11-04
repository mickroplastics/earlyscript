import type {
  EditorialDurationStats,
  EditorialResultsMode,
  EditorialResultsModeSummary,
  EditorialResultsSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { figureDescription, renderFigureSvg } from "./figureExport.logic";
import {
  RESULTS_FIGURE_TEXT,
  inboxFigure,
  resultsThreadCount,
  stagesFigure,
  timesFigure,
  utilityFigure,
  videoFigure,
} from "./resultsFigures.logic";
import { formatPercent } from "./results.logic";

const MINUTE = 60_000;
const stats = (
  n: number,
  median: number | null,
  q1 = median,
  q3 = median,
): EditorialDurationStats => ({
  n,
  medianMs: median === null ? null : median * MINUTE,
  q1Ms: q1 === null ? null : q1 * MINUTE,
  q3Ms: q3 === null ? null : q3 * MINUTE,
  minMs: null,
  maxMs: null,
});

const mode = (name: EditorialResultsMode, threads: number): EditorialResultsModeSummary => ({
  mode: name,
  threads,
  provisionalClock: 0,
  actions: { accept: 1, edit: 1, reject: 1 },
  stages: [
    { stage: "explore", stats: name === "manual" ? stats(3, 45, 41.5, 52.5) : stats(1, 4) },
    { stage: "read", stats: name === "manual" ? stats(0, null) : stats(3, 8, 7, 9) },
    { stage: "write", stats: stats(3, 26, 24, 28) },
    { stage: "decide", stats: stats(3, 3, 2.5, 3.5) },
  ],
  total: stats(3, 40, 36.5, 41),
  partialCoverage: 0,
  utility: { n: 3, mean: name === "assisted" ? 4 : 3, distribution: [0, 0, 1, 1, 1] },
  citations: { threads: 3, claims: 13, cited: 11, ratio: 11 / 13 },
  withVideoResults: 1,
});

const SUMMARY: EditorialResultsSummary = {
  modes: [mode("assisted", 4), mode("manual", 3)],
  comparisons: [
    {
      key: "write",
      assisted: stats(3, 26, 24, 28),
      manual: stats(3, 50, 45, 52.5),
      partial: { assisted: 0, manual: 0 },
    },
    {
      key: "total",
      assisted: stats(1, 40),
      manual: stats(3, 100, 98.5, 101.5),
      partial: { assisted: 0, manual: 0 },
    },
  ],
  inbox: { read: 6, observing: 1, dismissed: 2, production: 3 },
  excludedByDomain: 0,
  decisionCount: 7,
  firstDecidedAt: "2026-10-20T13:38:00.000Z",
  lastDecidedAt: "2026-10-28T14:00:00.000Z",
  asOf: "2026-10-31T00:00:00.000Z",
};

describe("Results figures", () => {
  it("counts the threads of both modes for the provenance line", () => {
    expect(resultsThreadCount(SUMMARY)).toBe(7);
  });

  it("draws time per script as median bars per comparison, with the difference in words", () => {
    const figure = timesFigure(SUMMARY);
    if (figure.kind !== "bars") throw new Error("bars expected");
    expect(figure.groups.map((group) => group.label)).toEqual(["Escribir", "Proceso completo"]);
    expect(figure.groups[0]?.note).toContain("Mediana manual 24 min mayor (n = 3 y 3)");
    // A single thread has no whisker, as on the page.
    const total = figure.groups[1]?.rows[0];
    expect(total?.low).toBeNull();
    expect(figure.axis.max).toBeGreaterThanOrEqual(101.5 * MINUTE);
    expect(figureDescription(figure).join(" ")).not.toMatch(/%|ahorr/i);
  });

  it("draws every stage, a missing one as no value", () => {
    const figure = stagesFigure(SUMMARY);
    if (figure.kind !== "bars") throw new Error("bars expected");
    expect(figure.groups.map((group) => group.label)).toHaveLength(4);
    const read = figure.groups[1]?.rows.find((row) => row.series === "manual");
    expect(read?.value).toBeNull();
    expect(read?.text).toBe("sin datos · n = 0");
  });

  it("keeps utility, inbox and video as tiles with the page's words", () => {
    const utility = utilityFigure(SUMMARY);
    if (utility.kind !== "metrics") throw new Error("metrics expected");
    expect(utility.metrics.map((metric) => metric.value)).toEqual([
      "4,0 de 5",
      "3,0 de 5",
      formatPercent(11 / 13),
      formatPercent(11 / 13),
    ]);
    const inbox = inboxFigure(SUMMARY);
    if (inbox.kind !== "metrics") throw new Error("metrics expected");
    expect(inbox.metrics.map((metric) => metric.value)).toEqual(["6", "1", "2", "3"]);
    const video = videoFigure(SUMMARY);
    if (video.kind !== "metrics") throw new Error("metrics expected");
    expect(video.metrics[0]?.value).toBe("1 de 4");
  });

  it("renders every Results figure without a dash or a causal word", () => {
    const exportedAt = new Date(2026, 10, 4);
    for (const [id, body] of [
      ["tiempos", timesFigure(SUMMARY)],
      ["etapas", stagesFigure(SUMMARY)],
      ["utilidad", utilityFigure(SUMMARY)],
      ["bandeja", inboxFigure(SUMMARY)],
      ["video", videoFigure(SUMMARY)],
    ] as const) {
      const svg = renderFigureSvg(
        { id, ...RESULTS_FIGURE_TEXT[id], body },
        { threads: 7, exportedAt },
      );
      expect(svg).toContain("Earlyscript · 7 hilos");
      expect(svg).not.toMatch(/—|ahorr/i);
    }
  });
});
