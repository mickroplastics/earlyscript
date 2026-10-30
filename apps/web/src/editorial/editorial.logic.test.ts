import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialSourceCoverage,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  compactCount,
  coverageStatus,
  editorialClaimsRoot,
  evidenceHeading,
  evidenceLinks,
  growthBand,
  growthText,
  resolveLandingTarget,
  resolveRouteSpace,
  runGroupLabel,
  spaceTabName,
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

describe("spaceTabName", () => {
  it("keeps the whole name and the count for assistive tech", () => {
    expect(spaceTabName("Tendencias", 18)).toBe("Tendencias, 18 nuevas");
    expect(spaceTabName("Tendencias", 1)).toBe("Tendencias, 1 nueva");
    expect(spaceTabName("Resultados", null)).toBe("Resultados");
    expect(compactCount(18)).toBe("18");
    expect(compactCount(140)).toBe("99+");
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

describe("editorialClaimsRoot", () => {
  const trends = { space: "trends", trend: null } as const;
  const threads = { space: "threads", trend: null } as const;
  it("claims / once for a stored Trends or Results space and yields everything else", () => {
    expect(editorialClaimsRoot({ pathname: "/", claim: "pending", state: trends })).toBe(true);
    expect(
      editorialClaimsRoot({
        pathname: "/",
        claim: "pending",
        state: { space: "results", trend: null },
      }),
    ).toBe(true);
    expect(editorialClaimsRoot({ pathname: "/", claim: "pending", state: threads })).toBe(false);
    // The redirect is still resolving: the claim holds even if the store changed meanwhile.
    expect(editorialClaimsRoot({ pathname: "/", claim: "editorial", state: threads })).toBe(true);
    // Once landed (or declined) "/" is upstream's again.
    expect(editorialClaimsRoot({ pathname: "/", claim: "done", state: trends })).toBe(false);
    expect(editorialClaimsRoot({ pathname: "/", claim: "upstream", state: trends })).toBe(false);
    // A deep link is never claimed.
    expect(editorialClaimsRoot({ pathname: "/env/thread", claim: "pending", state: trends })).toBe(
      false,
    );
  });
});

describe("evidenceLinks", () => {
  const https = "https://news.ycombinator.com/item?id=1";
  it("keeps only http and https and falls back to the permalink", () => {
    expect(evidenceLinks({ permalink: https, externalUrl: "http://example.com/" })).toEqual({
      title: "http://example.com/",
      discussion: https,
    });
    for (const unsafe of ['javascript:alert("x")', "data:text/html,x", "file:///etc/passwd"]) {
      expect(evidenceLinks({ permalink: https, externalUrl: unsafe })).toEqual({
        title: https,
        discussion: null,
      });
      expect(evidenceLinks({ permalink: unsafe, externalUrl: null })).toEqual({
        title: null,
        discussion: null,
      });
    }
    expect(evidenceLinks({ permalink: https, externalUrl: https })).toEqual({
      title: https,
      discussion: null,
    });
  });
});

describe("evidenceHeading", () => {
  it("counts the selection and dates its items, without the 28-day volume", () => {
    expect(
      evidenceHeading(10, { from: "2026-09-09T08:27:14.000Z", to: "2026-10-16T18:00:18.000Z" }),
    ).toBe("Evidencia seleccionada (10) · 9 sept 2026 – 16 oct 2026");
    expect(evidenceHeading(0, null)).toBe("Evidencia seleccionada (0)");
  });
});

describe("growthBand", () => {
  it("bands the log growth component and shows its value", () => {
    expect(growthBand(-0.4)).toBe("en descenso");
    expect(growthBand(0)).toBe("estable");
    expect(growthBand(0.29)).toBe("estable");
    expect(growthBand(0.3)).toBe("crece");
    expect(growthBand(1)).toBe("crece");
    expect(growthBand(1.01)).toBe("crece rápido");
    expect(growthText(-0.4)).toBe("en descenso (-0,40)");
    expect(growthText(Math.LN2)).toBe("crece (0,69)");
    expect(growthText(null)).toBe("crecimiento sin dato");
  });
});

describe("whyHereReasons", () => {
  it("states volume, authors, affinity against 0.60, growth, score position and coverage", () => {
    expect(
      whyHereReasons({
        trend: QUANTUM,
        affinityThreshold: 0.6,
        coverage: [coverage("hn", 28, 0), coverage("github", 0, 28)],
      }),
    ).toEqual([
      "11 publicaciones esta semana: #2 por volumen.",
      "11 autores distintos en las publicaciones de la semana.",
      "Afinidad con el perfil del canal 0,61, sobre el umbral 0,60.",
      "Crecimiento 0,69 en escala logarítmica: crece.",
      "#13 por puntaje (1,03).",
      "Cobertura incompleta en GitHub.",
      "Solo aparece en HN.",
    ]);
  });

  it("never claims a cause or anticipation", () => {
    for (const growth of [-0.5, 0.1, 0.5, 1.8]) {
      const reasons = whyHereReasons({
        trend: { ...QUANTUM, growth, affinity: 0.4 },
        affinityThreshold: 0.6,
        coverage: [coverage("hn", 28, 0)],
      });
      for (const reason of reasons) {
        expect(reason).not.toMatch(/así que|anticipación|ya es tema|porque/);
      }
    }
  });

  it("names each growth band with its value, negative included", () => {
    const growthReason = (growth: number) =>
      whyHereReasons({
        trend: { ...QUANTUM, growth },
        affinityThreshold: 0.6,
        coverage: [],
      }).find((reason) => reason.startsWith("Crecimiento"));
    expect(growthReason(-0.25)).toBe("Crecimiento -0,25 en escala logarítmica: en descenso.");
    expect(growthReason(0.1)).toBe("Crecimiento 0,10 en escala logarítmica: estable.");
    expect(growthReason(0.5)).toBe("Crecimiento 0,50 en escala logarítmica: crece.");
    expect(growthReason(1.8)).toBe("Crecimiento 1,80 en escala logarítmica: crece rápido.");
  });
});
