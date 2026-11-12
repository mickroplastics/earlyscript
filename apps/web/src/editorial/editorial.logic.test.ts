import {
  EditorialDossierId,
  EditorialRunId,
  type EditorialSourceCoverage,
  type EditorialTrendSummary,
  type EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  citationSegments,
  compactCount,
  coverageStatus,
  editorialClaimsRoot,
  evidenceHeading,
  evidenceLinks,
  growthBand,
  growthText,
  inboxSections,
  isResultsRouteId,
  resolveLandingTarget,
  resolveRouteSpace,
  runGroupLabel,
  runPresentationProgressText,
  snoozePresetLabel,
  snoozeStateText,
  spaceTabName,
  spaceTabTarget,
  splitInbox,
  trendMenuItems,
  whyHereReasons,
} from "./editorial.logic";
import { migrateSpaceState, selectEnvironmentSpace } from "./spaceStore";

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
    // Results is a page: the sidebar keeps the list it had.
    expect(resolveRouteSpace("/_chat/editorial/$environmentId/results")).toBeNull();
    expect(isResultsRouteId("/_chat/editorial/$environmentId/results")).toBe(true);
    expect(isResultsRouteId("/_chat/editorial/$environmentId/trends")).toBe(false);
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
  });
});

describe("spaceTabTarget", () => {
  it("opens another space, and the shown one from a page that is not its own", () => {
    expect(spaceTabTarget({ pressed: "trends", shown: "threads", routeSpace: "threads" })).toBe(
      "trends",
    );
    // On a thread, pressing Hilos again (the toggle deselects) stays put.
    expect(spaceTabTarget({ pressed: undefined, shown: "threads", routeSpace: "threads" })).toBe(
      null,
    );
    // On Results the shown list's tab still leads to its space, pressed or deselected.
    expect(spaceTabTarget({ pressed: undefined, shown: "trends", routeSpace: null })).toBe(
      "trends",
    );
    expect(spaceTabTarget({ pressed: "threads", shown: "threads", routeSpace: null })).toBe(
      "threads",
    );
    expect(spaceTabTarget({ pressed: "threads", shown: "trends", routeSpace: null })).toBe(
      "threads",
    );
  });
});

describe("migrateSpaceState", () => {
  it("reopens a stored Results space, or any unknown one, as the Threads list", () => {
    const trend = { runId: RUN_ID, dossierId: QUANTUM.dossierId };
    const migrated = migrateSpaceState({
      byEnvironment: {
        a: { space: "results", trend },
        b: { space: "trends", trend },
        c: { space: "threads", trend: null },
        d: {},
      },
      threadsHref: "/env/thread",
    });
    expect(migrated).toEqual({
      byEnvironment: {
        a: { space: "threads", trend },
        b: { space: "trends", trend },
        c: { space: "threads", trend: null },
        d: { space: "threads", trend: null },
      },
      threadsHref: "/env/thread",
    });
    // A stored Results never claims the root: the app opens on the Threads list.
    expect(
      editorialClaimsRoot({
        pathname: "/",
        claim: "pending",
        state: selectEnvironmentSpace(migrated, "a" as EnvironmentId),
      }),
    ).toBe(false);
    expect(migrateSpaceState(undefined)).toEqual({ byEnvironment: {}, threadsHref: null });
  });
});

describe("spaceTabName", () => {
  it("keeps the whole name and the count for assistive tech", () => {
    expect(spaceTabName("Tendencias", 18)).toBe("Tendencias, 18 nuevas");
    expect(spaceTabName("Tendencias", 1)).toBe("Tendencias, 1 nueva");
    expect(spaceTabName("Hilos", null)).toBe("Hilos");
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

describe("inboxSections", () => {
  const AT = "2026-10-31T08:00:00.000Z";
  const state = (patch: Partial<NonNullable<EditorialTrendSummary["inbox"]>> = {}) => ({
    isNew: false,
    seenRunId: null,
    seenAt: null,
    snoozed: null,
    dismissed: null,
    production: null,
    ...patch,
  });
  // Server order for "new-first-growth": new trends first, then by growth.
  const trend = (id: string, inbox: ReturnType<typeof state>) => ({
    id,
    isNew: inbox.isNew,
    inbox,
  });

  it("keeps the server order, folds past ten and moves snoozed and dismissed apart", () => {
    const fresh = Array.from({ length: 12 }, (_, index) =>
      trend(`new-${index}`, state({ isNew: true })),
    );
    const production = trend(
      "production",
      state({ production: { threadId: "thread-video", linkedAt: AT } }),
    );
    const snoozed = trend("snoozed", state({ snoozed: { at: AT, until: null, returnWhen: null } }));
    const dismissed = trend("dismissed", state({ dismissed: { at: AT, reason: "Ya cubierto" } }));
    const both = trend(
      "both",
      state({
        snoozed: { at: AT, until: null, returnWhen: null },
        dismissed: { at: AT, reason: "Fuera de tema" },
      }),
    );

    const sections = inboxSections([...fresh, snoozed, production, dismissed, both]);

    expect(sections.visible.map((entry) => entry.id)).toEqual(
      fresh.slice(0, 10).map((entry) => entry.id),
    );
    expect(sections.folded.map((entry) => entry.id)).toEqual(["new-10", "new-11", "production"]);
    expect(sections.snoozed.map((entry) => entry.id)).toEqual(["snoozed"]);
    expect(sections.dismissed.map((entry) => entry.id)).toEqual(["dismissed", "both"]);
    expect(sections.newCount).toBe(12);
  });

  it("treats a trend without inbox state, from an older server, as active", () => {
    const sections = inboxSections([{ id: "old", isNew: true }]);
    expect(sections.visible.map((entry) => entry.id)).toEqual(["old"]);
    expect(sections.newCount).toBe(1);
  });
});

describe("trendMenuItems", () => {
  const AT = "2026-10-31T08:00:00.000Z";
  const base = {
    isNew: false,
    seenRunId: null,
    seenAt: null,
    snoozed: null,
    dismissed: null,
    production: null,
  };
  const ids = (items: ReturnType<typeof trendMenuItems>) => items.map((item) => item.id);
  const presets = [{ id: "after:60", label: "In 1 hour", whenLabel: "9:00" }];

  it("offers the three exits of a trend in the inbox, watching by growth first", () => {
    const items = trendMenuItems(base, presets);
    expect(ids(items)).toEqual(["create-video", "keep-watching", "dismiss"]);
    expect(items[1]?.children?.map((child) => child.id)).toEqual([
      "keep-watching",
      "snooze:after:60",
      "snooze:custom",
    ]);
  });

  it("replaces each exit taken with its way back", () => {
    expect(
      ids(
        trendMenuItems(
          {
            ...base,
            snoozed: { at: AT, until: null, returnWhen: null },
            production: { threadId: "thread-video", linkedAt: AT },
          },
          presets,
        ),
      ),
    ).toEqual(["open-video", "return-to-inbox", "dismiss"]);
    expect(ids(trendMenuItems({ ...base, dismissed: { at: AT, reason: "No" } }, presets))).toEqual([
      "create-video",
      "reopen",
    ]);
  });
});

describe("snoozePresetLabel", () => {
  it("says T3's snooze times in Spanish and keeps a label it does not know", () => {
    expect(
      [
        "In 1 hour",
        "In 3 hours",
        "In 90 minutes",
        "In 2 days",
        "This evening",
        "Tomorrow",
        "Next week",
        "Next Monday",
        "Friday",
        "Someday",
      ].map(snoozePresetLabel),
    ).toEqual([
      "En 1 hora",
      "En 3 horas",
      "En 90 minutos",
      "En 2 días",
      "Esta noche",
      "Mañana",
      "La próxima semana",
      "El próximo lunes",
      "El viernes",
      "Someday",
    ]);
  });
});

describe("snoozeStateText", () => {
  it("names the growth target the server set and the time when there is one", () => {
    expect(
      snoozeStateText({
        at: "2026-10-31T08:00:00.000Z",
        until: null,
        returnWhen: { metric: "items7d", baseline: 11, atLeast: 17 },
      }),
    ).toBe("En observación: vuelve con 17 publicaciones en 7 días (hoy 11).");
    expect(snoozeStateText({ at: "2026-10-31T08:00:00.000Z", until: null, returnWhen: null })).toBe(
      "En observación.",
    );
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
  it("claims / once for a stored Trends space and yields everything else", () => {
    expect(editorialClaimsRoot({ pathname: "/", claim: "pending", state: trends })).toBe(true);
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

describe("citationSegments", () => {
  const item = (itemId: string) => ({
    itemId,
    source: "hn",
    title: `Title ${itemId}`,
    excerpt: "",
    author: null,
    publishedAt: "2026-10-15T18:26:30.000Z",
    permalink: null,
    externalUrl: `https://example.com/${itemId}`,
  });
  const evidence = [item("itm_hn_1"), item("itm_hn_2"), item("itm_gh_3")];

  it("turns known [itemId] markers into numbered citations in evidence order", () => {
    const segments = citationSegments(
      "IBM opened a quantum stack [itm_hn_2] and a SDK [itm_gh_3][itm_hn_1].",
      evidence,
    );
    expect(
      segments.map((segment) =>
        segment.kind === "text" ? segment.text : `#${segment.number}:${segment.itemId}`,
      ),
    ).toEqual([
      "IBM opened a quantum stack",
      "#2:itm_hn_2",
      " and a SDK",
      "#3:itm_gh_3",
      "#1:itm_hn_1",
      ".",
    ]);
  });

  it("keeps unknown markers and other brackets as written", () => {
    const segments = citationSegments("Claim [itm_x_9] and [a note] stay [itm_hn_1]", evidence);
    expect(
      segments.map((segment) => (segment.kind === "text" ? segment.text : `#${segment.number}`)),
    ).toEqual(["Claim [itm_x_9] and [a note] stay", "#1"]);
  });

  it("returns the text whole when there is nothing to cite", () => {
    expect(citationSegments("No citations here.", evidence)).toEqual([
      { kind: "text", text: "No citations here." },
    ]);
    expect(citationSegments("", evidence)).toEqual([]);
  });
});

describe("runPresentationProgressText", () => {
  it("counts drafted trends and names failures apart", () => {
    expect(runPresentationProgressText({ total: 18, ready: 3, failed: 0 })).toBe("3/18 redactadas");
    expect(runPresentationProgressText({ total: 1, ready: 0, failed: 1 })).toBe(
      "0/1 redactada · 1 falló",
    );
    expect(runPresentationProgressText({ total: 18, ready: 15, failed: 3 })).toBe(
      "15/18 redactadas · 3 fallaron",
    );
  });
});
