import type { EditorialDurationStats, EditorialResultsSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  actionsText,
  coverageNote,
  decisionsFailureText,
  recordedTotalText,
  sectionAriaCurrent,
  withoutRouteActive,
  decisionThreadFallback,
  decisionTotalText,
  formatDuration,
  iqrText,
  medianDifferenceText,
  pageRangeText,
  provisionalNote,
  stageChartMaxMs,
  statsText,
  visibleSections,
} from "./results.logic";

const MINUTE = 60_000;

const stats = (values: Partial<EditorialDurationStats>): EditorialDurationStats => ({
  n: 0,
  medianMs: null,
  q1Ms: null,
  q3Ms: null,
  minMs: null,
  maxMs: null,
  ...values,
});

const EMPTY_STATS = stats({});

const modeSummary = (
  mode: "assisted" | "manual",
  overrides: Partial<EditorialResultsSummary["modes"][number]> = {},
): EditorialResultsSummary["modes"][number] => ({
  mode,
  threads: 0,
  provisionalClock: 0,
  actions: { accept: 0, edit: 0, reject: 0 },
  stages: (["explore", "read", "write", "decide"] as const).map((stage) => ({
    stage,
    stats: EMPTY_STATS,
  })),
  total: EMPTY_STATS,
  partialCoverage: 0,
  utility: { n: 0, mean: null, distribution: [0, 0, 0, 0, 0] },
  citations: { threads: 0, claims: 0, cited: 0, ratio: null },
  withVideoResults: 0,
  ...overrides,
});

const summary = (modes: EditorialResultsSummary["modes"]): EditorialResultsSummary => ({
  modes,
  comparisons: [],
  inbox: { read: 0, observing: 0, dismissed: 0, production: 0 },
  decisionCount: 0,
  firstDecidedAt: null,
  lastDecidedAt: null,
  asOf: "2026-10-31T00:00:00.000Z",
});

describe("formatDuration", () => {
  it("reads seconds, minutes and hours", () => {
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(26 * MINUTE)).toBe("26 min");
    expect(formatDuration(100 * MINUTE)).toBe("1 h 40 min");
    expect(formatDuration(120 * MINUTE)).toBe("2 h");
  });
});

describe("statsText", () => {
  it("states the median, the interquartile range and n", () => {
    expect(
      statsText(stats({ n: 3, medianMs: 26 * MINUTE, q1Ms: 24 * MINUTE, q3Ms: 28 * MINUTE })),
    ).toBe("26 min · RIC 24–28 min · n = 3");
    expect(statsText(EMPTY_STATS)).toBe("sin datos · n = 0");
  });
});

describe("medianDifferenceText", () => {
  it("describes the difference of medians with both n, never as a saving", () => {
    const assisted = stats({ n: 3, medianMs: 40 * MINUTE });
    const manual = stats({ n: 3, medianMs: 100 * MINUTE });
    const text = medianDifferenceText(assisted, manual);
    expect(text).toBe("Mediana manual 1 h mayor (n = 3 y 3)");
    expect(text).not.toMatch(/%|ahorr|reduc/i);
    expect(medianDifferenceText(manual, assisted)).toBe("Mediana asistida 1 h mayor (n = 3 y 3)");
    expect(medianDifferenceText(assisted, assisted)).toBe("Medianas iguales al minuto (n = 3 y 3)");
  });

  it("says nothing without both medians", () => {
    expect(medianDifferenceText(EMPTY_STATS, stats({ n: 1, medianMs: MINUTE }))).toBeNull();
  });
});

describe("provisionalNote", () => {
  it("counts threads left out of the time statistics", () => {
    expect(provisionalNote(summary([modeSummary("assisted"), modeSummary("manual")]))).toBeNull();
    expect(
      provisionalNote(
        summary([modeSummary("assisted", { provisionalClock: 1 }), modeSummary("manual")]),
      ),
    ).toMatch(/^1 hilo queda fuera de los tiempos/);
  });
});

describe("stageChartMaxMs", () => {
  it("shares one scale across modes, wide enough for every whisker", () => {
    const manual = modeSummary("manual", {
      stages: [
        {
          stage: "explore",
          stats: stats({ n: 3, medianMs: 45 * MINUTE, q3Ms: 52 * MINUTE, maxMs: 60 * MINUTE }),
        },
      ],
    });
    expect(stageChartMaxMs(summary([modeSummary("assisted"), manual]))).toBe(60 * MINUTE);
    expect(stageChartMaxMs(summary([]))).toBe(MINUTE);
  });
});

describe("decision cells", () => {
  it("marks a total with an unresolved segment as a floor", () => {
    expect(decisionTotalText({ clockDefinitive: true, durations: { totalMs: 33 * MINUTE } })).toBe(
      "33 min",
    );
    expect(decisionTotalText({ clockDefinitive: false, durations: { totalMs: 33 * MINUTE } })).toBe(
      "≥ 33 min",
    );
    expect(decisionTotalText({ clockDefinitive: true, durations: { totalMs: null } })).toBe(
      "sin reloj",
    );
  });

  it("names a thread without title by its trend or its short id", () => {
    expect(decisionThreadFallback({ threadId: "abc", trendKey: "trend:local-models" })).toBe(
      "local-models",
    );
    expect(decisionThreadFallback({ threadId: "0123456789", trendKey: null })).toBe(
      "Hilo 01234567",
    );
  });

  it("states the page range", () => {
    expect(pageRangeText(20, 6, 26)).toBe("21–26 de 26");
    expect(pageRangeText(0, 0, 0)).toBe("0 de 0");
  });
});

describe("visibleSections", () => {
  it("keeps only the inbox before the first decision, and nothing when it is quiet", () => {
    const quiet = summary([]);
    expect(visibleSections(quiet)).toEqual([]);
    const read = { ...quiet, inbox: { ...quiet.inbox, read: 2 } };
    expect(visibleSections(read).map((section) => section.id)).toEqual(["bandeja"]);
    expect(visibleSections({ ...read, decisionCount: 1 })).toHaveLength(6);
  });
});

describe("iqrText and actionsText", () => {
  it("shortens a range within minutes and keeps units across an hour", () => {
    const range = (q1: number, q3: number) =>
      iqrText(stats({ n: 3, q1Ms: q1 * MINUTE, q3Ms: q3 * MINUTE }));
    expect(range(42, 53)).toBe("RIC 42–53 min");
    expect(range(58, 62)).toBe("RIC 58 min–1 h 2 min");
  });

  it("agrees in number", () => {
    expect(actionsText({ accept: 1, edit: 2, reject: 0 })).toBe(
      "1 aceptada, 2 editadas, 0 rechazadas",
    );
  });
});

describe("coverage", () => {
  const comparison = (
    key: "total" | "recorded",
    partial: { assisted: number; manual: number },
  ) => ({
    key,
    assisted: stats({ n: 4, medianMs: 37 * MINUTE }),
    manual: stats({ n: 3, medianMs: 100 * MINUTE }),
    partial,
  });

  it("warns when the recorded total takes partial threads in", () => {
    expect(coverageNote(comparison("recorded", { assisted: 1, manual: 0 }))).toBe(
      "Cobertura parcial: incluye 1 hilo sin todas las etapas de su modo; no es el proceso completo.",
    );
    expect(coverageNote(comparison("recorded", { assisted: 0, manual: 0 }))).toBeNull();
    expect(coverageNote(comparison("total", { assisted: 0, manual: 0 }))).toBe(
      "Solo hilos con todas las etapas de su modo registradas.",
    );
    expect(recordedTotalText(comparison("recorded", { assisted: 1, manual: 0 }))).toBe(
      "Total de etapas registradas, mediana: asistido 37 min (n = 4) · manual 1 h 40 min (n = 3)",
    );
  });
});

describe("section anchors", () => {
  it("marks only the section the hash selects", () => {
    expect(sectionAriaCurrent("utilidad", "utilidad")).toBe("location");
    expect(sectionAriaCurrent("#utilidad", "utilidad")).toBe("location");
    expect(sectionAriaCurrent("utilidad", "tiempos")).toBeUndefined();
    expect(sectionAriaCurrent("", "tiempos")).toBeUndefined();
  });

  it("drops the route-active marks of a link", () => {
    const props = withoutRouteActive({
      href: "/editorial/env/results#tiempos",
      "aria-current": "page",
      "data-status": "active",
      className: "active",
    });
    expect(props).toEqual({ href: "/editorial/env/results#tiempos" });
  });
});

describe("decisionsFailureText", () => {
  it("names the reason of the failure", () => {
    expect(decisionsFailureText({ _tag: "EditorialResultsError", reason: "unreadable" })).toBe(
      "La base editorial de este entorno no se pudo leer.",
    );
    expect(decisionsFailureText({ _tag: "EditorialResultsError", reason: "unavailable" })).toBe(
      "La base editorial de este entorno no está disponible.",
    );
    expect(decisionsFailureText({ _tag: "EnvironmentAuthorizationError" })).toBe(
      "Este entorno no autoriza la lectura de resultados.",
    );
    expect(decisionsFailureText(undefined)).toBe("No hubo respuesta del entorno.");
  });
});
