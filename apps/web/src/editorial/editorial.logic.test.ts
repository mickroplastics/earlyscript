import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialSourceCoverage,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coverageStatus,
  resolveLandingTarget,
  resolveRouteSpace,
  runGroupLabel,
  splitInbox,
  whyHereReasons,
} from "./editorial.logic";

const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");

// The quantum computing trend of the 19 October run, as the server summarizes it.
const QUANTUM: EditorialTrendSummary = {
  dossierId: EditorialDossierId.make("dos_bbb80d57481e"),
  runId: RUN_ID,
  label: "quantum computing ibm open",
  terms: ["quantum", "computing", "ibm", "open"],
  subtitle: "Designing more efficient quantum circuits with Claude",
  stage: "growing",
  corroboration: "single_source",
  items7d: 11,
  items28d: 38,
  authors7d: 11,
  volumeRank: 2,
  scoreRank: 13,
  score: 1.026179,
  growth: Math.LN2,
  affinity: 0.608747,
  sourceCount: 1,
  sources: ["hn"],
  sparkline: [2, 2, 1, 0, 0, 0, 0, 2, 0, 1, 5, 2, 0, 1],
  isNew: true,
};

const coverage = (
  source: string,
  daysComplete: number,
  daysPartial: number,
): EditorialSourceCoverage => ({
  source,
  windowDays: 28,
  daysComplete,
  daysPartial,
  daysUnavailable: 28 - daysComplete - daysPartial,
});

describe("resolveRouteSpace", () => {
  it("maps editorial and thread routes to their space and leaves the rest to the store", () => {
    expect(resolveRouteSpace("/_chat/editorial/$environmentId/trends")).toBe("trends");
    expect(resolveRouteSpace("/_chat/editorial/$environmentId/trends/$dossierId")).toBe("trends");
    expect(resolveRouteSpace("/_chat/editorial/$environmentId/results")).toBe("results");
    expect(resolveRouteSpace("/_chat/$environmentId/$threadId")).toBe("threads");
    expect(resolveRouteSpace("/_chat/draft/$draftId")).toBe("threads");
    expect(resolveRouteSpace("/_chat/")).toBeNull();
    expect(resolveRouteSpace("/_chat/settings/general")).toBeNull();
  });
});

describe("resolveLandingTarget", () => {
  it("opens the root in the space left last, and keeps upstream's landing for Threads", () => {
    const trend = { runId: RUN_ID, dossierId: QUANTUM.dossierId };
    expect(resolveLandingTarget({ space: "threads", trend })).toBeNull();
    expect(resolveLandingTarget({ space: "trends", trend })).toEqual({ space: "trends", trend });
    expect(resolveLandingTarget({ space: "results", trend: null })).toEqual({ space: "results" });
  });
});

describe("splitInbox", () => {
  it("shows ten trends and folds the rest", () => {
    const { visible, folded } = splitInbox(Array.from({ length: 18 }, (_, index) => index));
    expect(visible).toHaveLength(10);
    expect(folded).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });
});

describe("runGroupLabel", () => {
  const run = {
    runId: RUN_ID,
    cutoffAt: "2026-10-19T00:00:00.000Z",
    finishedAt: "2026-10-27T12:43:13.414Z",
    status: "ok",
    configVersion: "engine.v0.02",
    sources: ["hn", "github"],
    dossierCount: 18,
  };
  it("names the run by its cutoff day and says Hoy only on the day it finished", () => {
    expect(runGroupLabel(run, "2026-10-27T13:00")).toBe("Hoy · corrida 19 oct");
    expect(runGroupLabel(run, "2026-10-30T13:00")).toBe("Más reciente · corrida 19 oct");
  });
});

describe("coverageStatus", () => {
  it("tells complete, partial and missing coverage apart", () => {
    expect(coverageStatus(coverage("hn", 28, 0))).toBe("complete");
    expect(coverageStatus(coverage("github", 0, 28))).toBe("partial");
    expect(coverageStatus(coverage("reddit", 0, 0))).toBe("unavailable");
  });
});

describe("whyHereReasons", () => {
  it("explains a trend from volume, authors, affinity against 0.60, growth and coverage", () => {
    expect(
      whyHereReasons({
        trend: QUANTUM,
        affinityThreshold: 0.6,
        coverage: [coverage("hn", 28, 0), coverage("github", 0, 28)],
      }),
    ).toEqual([
      "Entre las de más volumen esta semana: 11 publicaciones, #2 por volumen.",
      "Muchos autores distintos: 11 en la semana, no es una sola cuenta.",
      "Pasa el umbral de afinidad con el perfil por poco: 0,61 frente a 0,60.",
      "Crece despacio (0,69), así que por puntaje queda #13: ya es tema, no anticipación.",
      "Cobertura incompleta en GitHub: los conteos de esa fuente son un piso.",
      "Solo aparece en HN: sin corroboración de otra fuente.",
    ]);
  });

  it("flags few authors and a high affinity", () => {
    const reasons = whyHereReasons({
      trend: { ...QUANTUM, items7d: 3, authors7d: 1, volumeRank: 9, affinity: 0.75, growth: 1.8 },
      affinityThreshold: 0.6,
      coverage: [coverage("hn", 28, 0)],
    });
    expect(reasons).toContain("Pocos autores: 1 en la semana; puede ser una sola conversación.");
    expect(reasons).toContain("Afinidad alta con el perfil del canal: 0,75, umbral 0,60.");
    expect(reasons).toContain("Crecimiento semanal 1,80: por puntaje queda #13.");
  });
});
