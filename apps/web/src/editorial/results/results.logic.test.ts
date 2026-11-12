import type { EditorialDurationStats, EditorialResultsSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  actionsText,
  coverageNote,
  decisionsFailureText,
  recordedTotalText,
  withoutRouteActive,
  decisionThreadLabel,
  decisionTotalText,
  emptySideText,
  closingStrip,
  formatDuration,
  iqrText,
  medianDifferenceText,
  pageRangeText,
  provisionalNote,
  stageChartMaxMs,
  statsText,
  domainNote,
} from "./results.logic";

const MINUTE = 60_000;

/** The texts join numbers to units with no-break spaces; the expectations read plain ones. */
const plain = (text: string | null) => text?.replaceAll("\u00a0", " ") ?? null;

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
  excludedByDomain: 0,
  decisionCount: 0,
  firstDecidedAt: null,
  lastDecidedAt: null,
  asOf: "2026-10-31T00:00:00.000Z",
});

describe("formatDuration", () => {
  it("reads seconds, minutes and hours", () => {
    expect(plain(formatDuration(45_000))).toBe("45 s");
    expect(plain(formatDuration(117))).toBe("< 1 s");
    expect(plain(formatDuration(0))).toBe("0 s");
    expect(plain(formatDuration(26 * MINUTE))).toBe("26 min");
    expect(plain(formatDuration(100 * MINUTE))).toBe("1 h 40 min");
    expect(plain(formatDuration(120 * MINUTE))).toBe("2 h");
    expect(formatDuration(100 * MINUTE)).not.toContain(" ");
  });
});

describe("statsText", () => {
  it("states the median, the interquartile range and n", () => {
    expect(
      plain(
        statsText(stats({ n: 3, medianMs: 26 * MINUTE, q1Ms: 24 * MINUTE, q3Ms: 28 * MINUTE })),
      ),
    ).toBe("26 min · RIC 24 a 28 min · n = 3");
    expect(plain(statsText(EMPTY_STATS))).toBe("sin datos · n = 0");
  });

  it("gives no spread for a single thread", () => {
    expect(
      plain(
        statsText(stats({ n: 1, medianMs: 14 * MINUTE, q1Ms: 14 * MINUTE, q3Ms: 14 * MINUTE })),
      ),
    ).toBe("14 min · n = 1");
  });
});

describe("medianDifferenceText", () => {
  it("avisa de muestra pequeña aunque solo un modo tenga hilos", () => {
    const one = {
      n: 1,
      medianMs: 60_000,
      q1Ms: 60_000,
      q3Ms: 60_000,
      minMs: 60_000,
      maxMs: 60_000,
    };
    const none = { n: 0, medianMs: null, q1Ms: null, q3Ms: null, minMs: null, maxMs: null };
    expect(medianDifferenceText(one, none)).toBe(
      "Sin hilos medidos en modo manual: no hay diferencia que describir. Con tan pocos hilos describe casos sueltos, no una tendencia.",
    );
  });
  it("describes the difference of medians with both n, never as a saving", () => {
    const assisted = stats({ n: 3, medianMs: 40 * MINUTE });
    const manual = stats({ n: 3, medianMs: 100 * MINUTE });
    const text = plain(medianDifferenceText(assisted, manual));
    expect(text).toBe("Mediana manual 1 h mayor (n = 3 y 3).");
    expect(text).not.toMatch(/%|ahorr|reduc/i);
    expect(plain(medianDifferenceText(manual, assisted))).toBe(
      "Mediana asistida 1 h mayor (n = 3 y 3).",
    );
    expect(plain(medianDifferenceText(assisted, assisted))).toBe(
      "Medianas iguales al minuto (n = 3 y 3).",
    );
  });

  it("warns that a handful of threads are single cases", () => {
    expect(
      plain(
        medianDifferenceText(
          stats({ n: 1, medianMs: MINUTE }),
          stats({ n: 4, medianMs: 3 * MINUTE }),
        ),
      ),
    ).toBe(
      "Mediana manual 2 min mayor (n = 1 y 4). Con tan pocos hilos describe casos sueltos, no una tendencia.",
    );
  });

  it("names the mode without a median", () => {
    expect(medianDifferenceText(EMPTY_STATS, stats({ n: 1, medianMs: MINUTE }))).toBe(
      "Sin hilos medidos en modo asistido: no hay diferencia que describir. Con tan pocos hilos describe casos sueltos, no una tendencia.",
    );
    expect(medianDifferenceText(EMPTY_STATS, EMPTY_STATS)).toBe(
      "Sin hilos medidos en ningún modo: no hay diferencia que describir.",
    );
  });

  it("says why a side is empty when its threads await resolution", () => {
    expect(plain(emptySideText(EMPTY_STATS, 1))).toBe("n = 0 · 1 hilo espera resolver un tramo");
    expect(plain(emptySideText(EMPTY_STATS, 0))).toBe("n = 0");
    expect(plain(emptySideText(stats({ n: 2, medianMs: MINUTE }), 1))).toBe("n = 2");
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
    expect(
      plain(decisionTotalText({ clockDefinitive: true, durations: { totalMs: 33 * MINUTE } })),
    ).toBe("33 min");
    expect(
      plain(decisionTotalText({ clockDefinitive: false, durations: { totalMs: 33 * MINUTE } })),
    ).toBe("≥ 33 min");
    expect(decisionTotalText({ clockDefinitive: true, durations: { totalMs: null } })).toBe(
      "sin reloj",
    );
  });

  it("names a thread by its title, else its trend, never by an id", () => {
    const decision = { mode: "assisted" as const, trendLabel: "local models llama" };
    expect(decisionThreadLabel(decision, "Video: Modelos locales")).toBe("Modelos locales");
    expect(decisionThreadLabel(decision, undefined)).toBe("Tendencia: local models llama");
    expect(decisionThreadLabel({ mode: "manual", trendLabel: null }, undefined)).toBe(
      "Hilo manual sin título",
    );
  });

  it("states the page range", () => {
    expect(pageRangeText(20, 6, 26)).toBe("21–26 de 26");
    expect(pageRangeText(0, 0, 0)).toBe("0 de 0");
  });
});

describe("iqrText and actionsText", () => {
  it("shortens a range within minutes and keeps units across an hour", () => {
    const range = (q1: number, q3: number) =>
      plain(iqrText(stats({ n: 3, q1Ms: q1 * MINUTE, q3Ms: q3 * MINUTE })));
    expect(range(42, 53)).toBe("RIC 42 a 53 min");
    expect(range(58, 62)).toBe("RIC 58 min a 1 h 2 min");
    expect(range(2, 2.2)).toBe("cuartiles en 2 min");
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
    expect(coverageNote(comparison("total", { assisted: 0, manual: 0 }))).toBeNull();
    expect(plain(recordedTotalText(comparison("recorded", { assisted: 1, manual: 0 })))).toBe(
      "Total de etapas registradas, mediana: asistido 37 min (n = 4) · manual 1 h 40 min (n = 3)",
    );
  });
});

describe("tab links", () => {
  it("drops the route-active marks of a link", () => {
    const props = withoutRouteActive({
      href: "/editorial/env/results?tab=etapas",
      "aria-current": "page",
      "data-status": "active",
      className: "active",
    });
    expect(props).toEqual({ href: "/editorial/env/results?tab=etapas" });
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

  it("explains decisions left out by domain", () => {
    expect(domainNote(summary([]))).toBeNull();
    expect(domainNote({ ...summary([]), excludedByDomain: 2 })).toBe(
      "2 decisiones quedan fuera de los agregados: un valor guardado está fuera de su dominio (utilidad de 1 a 5, tiempos y conteos no negativos).",
    );
  });
});

describe("closingStrip", () => {
  it("states missing data without inventing achievements", () => {
    const blocks = closingStrip({
      modes: [],
      comparisons: [],
      inbox: { read: 0, observing: 0, dismissed: 0, production: 0 },
      excludedByDomain: 0,
      decisionCount: 0,
      firstDecidedAt: null,
      lastDecidedAt: null,
      asOf: "2026-11-04T12:00:00.000Z",
    });
    expect(blocks[0]?.text).toContain("Todavía sin hilos manuales");
    expect(blocks[1]?.text).toContain("0 bloques de línea base, todavía sin registro importado");
    expect(blocks[2]?.text).toContain("no mide un efecto");
  });

  it("writes the sample dates with the formatters it is given", () => {
    const blocks = closingStrip(
      {
        ...summary([]),
        trials: [{ threadId: "t", environmentId: "e", createdAt: "2026-11-03T20:00:00.000Z" }],
        firstDecidedAt: "2026-11-09T20:30:00.000Z",
        lastDecidedAt: "2026-11-10T05:11:00.000Z",
        baselineSample: { blocks: 17, firstDay: "2026-10-01", lastDay: "2026-10-14" },
      },
      (iso) => iso.slice(0, 10),
      (day) => `día ${day.slice(8)}`,
    );
    expect(blocks[1]?.text).toContain("17 bloques de línea base entre día 01 y día 14");
    expect(blocks[1]?.text).toContain("entre 2026-11-03 y 2026-11-03");
    expect(blocks[1]?.text).toContain("desde 2026-11-09 hasta 2026-11-10");
  });
});
