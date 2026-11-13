import type {
  EditorialJob,
  EditorialJobPhase,
  EditorialNightlySettings,
  EditorialProfileVersion,
  EditorialSourceEntry,
  EditorialSourcesView,
} from "@t3tools/contracts";
import { SOURCE_CATALOG } from "@earlyscript/editorial-contracts/sourceCatalog";
import { describe, expect, it } from "vite-plus/test";

import { versionChange } from "./channel.logic";
import {
  draftCell,
  failureDetail,
  modelCell,
  nightlyState,
  sourcesCell,
  stripAlert,
} from "./editorialStatus.logic";
import { initialMethod, methodChoices, nightRows } from "./nightly.logic";
import { dayCells, deletionOf, sourceStatus } from "./sources.logic";

const PHASES = ["collect", "run", "check", "import", "presentations"] as const;
const phases = (failedAt: number | null): ReadonlyArray<EditorialJobPhase> =>
  PHASES.map((phase, index) => ({
    phase,
    status:
      failedAt === null || index < failedAt ? "done" : index === failedAt ? "failed" : "pending",
    startedAt: "2026-11-12T08:00:00.000Z",
    finishedAt: "2026-11-12T08:05:00.000Z",
    note: null,
    log: null,
  }));

const job = (overrides: Partial<EditorialJob> & { readonly day: string }): EditorialJob => ({
  jobId: `job-${overrides.day}`,
  kind: "daily",
  profileHash: "sha256:p",
  cutoffAt: `${overrides.day}T00:00:00.000Z`,
  configHash: "sha256:c",
  timezone: "America/Guayaquil",
  scheduledFor: `${overrides.day}T08:00:00.000Z`,
  startedAt: `${overrides.day}T08:00:00.000Z`,
  finishedAt: `${overrides.day}T08:10:00.000Z`,
  attempt: 1,
  status: "done",
  error: null,
  ...overrides,
  artifacts: {
    jobDir: "/j",
    corpusDir: "/c",
    runsDir: "/r",
    sources: { collect: ["hn", "github"], rank: ["hn", "github"] },
    phases: phases(null),
    collect: null,
    runId: "run",
    runDir: null,
    dossiers: 11,
    presentations: null,
    notes: [],
    notices: [],
    failure: null,
    progress: null,
    ...overrides.artifacts,
  },
});

const failedToday = job({
  day: "2026-11-12",
  status: "failed",
  attempt: 3,
  artifacts: {
    ...job({ day: "2026-11-12" }).artifacts,
    phases: phases(1),
    failure: { code: "engine_failed", phase: "run" },
  },
});

const SETTINGS: EditorialNightlySettings = {
  enabled: true,
  timeOfDay: "03:00",
  timezone: "America/Guayaquil",
  workers: 4,
  nextRunAt: "2026-11-13T08:00:00.000Z",
  engineConfig: "engine.v3-sel.json",
  engineConfigChosenAt: "2026-11-09T08:13:00.000Z",
  engineConfigs: ["engine.v1.json", "engine.v2.json", "engine.v3-sel.json", "engine.v3.json"],
};

/** 12 nov 2026, 18:00 in Guayaquil. */
const NOW = Date.parse("2026-11-12T23:00:00.000Z");

const entry = (overrides: Partial<EditorialSourceEntry> & { source: string }) =>
  ({
    collect: true,
    rank: false,
    backtestRunId: null,
    backtest: null,
    rankBlocked: null,
    collectBlocked: null,
    updatedAt: null,
    lastCapture: null,
    recentGaps: [],
    ...overrides,
  }) satisfies EditorialSourceEntry;

const capture = (day: string, items: number, status: "complete" | "partial" = "complete") => ({
  day,
  status,
  items,
  retrievedAt: "2026-11-12T08:00:00.000Z",
  note: null,
});

const view = (sources: ReadonlyArray<EditorialSourceEntry>): EditorialSourcesView => ({
  corpus: {
    status: "ready",
    directory: "/c",
    fromDay: "2026-10-01",
    toDay: "2026-11-12",
    message: null,
  },
  sources,
  rssFeeds: [],
  asOf: "2026-11-12T23:00:00.000Z",
});

const name = (source: string) => (source === "github" ? "GitHub" : "Hacker News");

describe("nightlyState", () => {
  it("reads the newest night that was not replaced", () => {
    const skipped = job({ day: "2026-11-12", jobId: "replaced", status: "skipped" });
    expect(
      nightlyState({
        settings: SETTINGS,
        jobs: [skipped, failedToday, job({ day: "2026-11-11" })],
        active: null,
        now: NOW,
      }),
    ).toMatchObject({ _tag: "failed", job: failedToday, lastDone: { jobId: "job-2026-11-11" } });
  });

  it("counts a failed night waiting to retry as failed", () => {
    const retrying = { ...failedToday, status: "pending" as const };
    expect(
      nightlyState({ settings: SETTINGS, jobs: [retrying], active: null, now: NOW })._tag,
    ).toBe("failed");
  });

  it("is current after tonight's review, due once the next time passes, off when disabled", () => {
    const jobs = [job({ day: "2026-11-12" })];
    expect(nightlyState({ settings: SETTINGS, jobs, active: null, now: NOW })._tag).toBe("current");
    const later = Date.parse("2026-11-13T09:00:00.000Z");
    expect(nightlyState({ settings: SETTINGS, jobs, active: null, now: later })._tag).toBe("due");
    expect(
      nightlyState({
        settings: { ...SETTINGS, enabled: false, nextRunAt: null },
        jobs,
        active: null,
        now: later,
      })._tag,
    ).toBe("disabled");
  });

  it("follows the job in flight before anything the list says", () => {
    const running = { ...failedToday, status: "running" as const };
    expect(nightlyState({ settings: null, jobs: null, active: running, now: NOW })).toMatchObject({
      _tag: "running",
      job: running,
    });
  });
});

describe("failureDetail", () => {
  it("says where it failed and that «Reintentar» keeps what was captured", () => {
    expect(failureDetail(failedToday)).toBe(
      "Falló al agrupar las publicaciones. «Reintentar» sigue desde ahí; lo capturado no se repite.",
    );
  });
});

describe("stripAlert", () => {
  const base = {
    sources: view([entry({ source: "hn", rank: true, lastCapture: capture("2026-11-11", 9) })]),
    model: modelCell(
      {
        status: "ready",
        revision: "r",
        path: "/m",
        location: "~/m",
        bytesPresent: 1,
        bytesExpected: 1,
        download: null,
        error: null,
      },
      false,
    ),
    draft: draftCell({ monthlyLimit: 400, usedThisMonth: 212, month: "2026-11" }, true),
    budgetReset: "1 de diciembre",
    timeZone: "America/Guayaquil",
    now: NOW,
  };

  it("puts a failed review first, with what the inbox still shows", () => {
    const nightly = nightlyState({
      settings: SETTINGS,
      jobs: [failedToday, job({ day: "2026-11-11" })],
      active: null,
      now: NOW,
    });
    expect(stripAlert({ ...base, nightly })).toEqual({
      _tag: "retry",
      text: "Sin tendencias nuevas hoy: la bandeja muestra las de ayer.",
    });
  });

  it("reads hoy and ayer from when a review ran, not from its UTC cutoff", () => {
    // «Revisar ahora» at 19:10 in Guayaquil takes the next UTC day as its cutoff.
    const evening = job({
      day: "2026-11-13",
      status: "failed",
      startedAt: "2026-11-13T00:10:00.000Z",
      artifacts: { ...failedToday.artifacts },
    });
    const nightly = nightlyState({
      settings: SETTINGS,
      jobs: [evening, job({ day: "2026-11-11" })],
      active: null,
      now: Date.parse("2026-11-13T00:30:00.000Z"),
    });
    expect(
      stripAlert({ ...base, nightly, now: Date.parse("2026-11-13T00:30:00.000Z") })?.text,
    ).toBe("Sin tendencias nuevas hoy: la bandeja muestra las de ayer.");
  });

  it("then a review with nowhere to look, a missing model and a spent cap; else nothing", () => {
    const nightly = nightlyState({
      settings: SETTINGS,
      jobs: [job({ day: "2026-11-12" })],
      active: null,
      now: NOW,
    });
    expect(stripAlert({ ...base, nightly })).toBeNull();
    expect(stripAlert({ ...base, nightly, sources: view([entry({ source: "hn" })]) })?._tag).toBe(
      "sources",
    );
    expect(stripAlert({ ...base, nightly, model: modelCell(null, true) })?._tag).toBe("model");
    expect(
      stripAlert({
        ...base,
        nightly,
        draft: draftCell({ monthlyLimit: 400, usedThisMonth: 400, month: "2026-11" }, true),
      }),
    ).toEqual({
      _tag: "budget",
      text: "Tope de redacción alcanzado: las tendencias nuevas llegan sin resumen hasta el 1 de diciembre.",
    });
  });
});

describe("sourcesCell", () => {
  it("names a counting source that brought nothing, or one that stopped arriving", () => {
    const hn = entry({ source: "hn", rank: true, lastCapture: capture("2026-11-11", 1154) });
    expect(sourcesCell(view([hn]), name)).toEqual({ tone: "ok", text: "Al día" });
    const empty = entry({ source: "github", rank: true, lastCapture: capture("2026-11-11", 0) });
    expect(sourcesCell(view([hn, empty]), name)).toEqual({
      tone: "warning",
      text: "GitHub: 0 repositorios",
    });
    const stale = entry({ source: "github", rank: true, lastCapture: capture("2026-11-09", 80) });
    expect(sourcesCell(view([hn, stale]), name).text).toBe("GitHub: nada desde 9 nov");
  });
});

describe("sourceStatus and dayCells", () => {
  it("calls a sample source's partial day a sample and groups thousands", () => {
    const github = entry({
      source: "github",
      rank: true,
      lastCapture: capture("2026-11-11", 1154, "partial"),
    });
    expect(
      sourceStatus(github, SOURCE_CATALOG.github, view([github])).map((part) => part.text),
    ).toEqual(["Ayer, muestra", "1.154 repositorios"]);
  });

  it("marks the last seven days from the gaps the server reports", () => {
    const arxiv = entry({
      source: "arxiv",
      lastCapture: capture("2026-11-10", 400),
      recentGaps: [
        { day: "2026-11-07", reason: "fetch_failed" },
        { day: "2026-11-11", reason: "not_collected" },
      ],
    });
    expect(dayCells(arxiv, view([arxiv])).map((cell) => cell.label)).toEqual([
      "5 nov: sin huecos",
      "6 nov: sin huecos",
      "7 nov: falló",
      "8 nov: sin huecos",
      "9 nov: sin huecos",
      "10 nov: sin huecos",
      "11 nov: sin captura",
    ]);
  });
});

describe("deletionOf", () => {
  it("offers the catalog's purge command and says what it removes by", () => {
    expect(deletionOf(SOURCE_CATALOG.hn)).toEqual({
      text: "Por autor o enlace, con un comando. Queda solo su huella y no se vuelve a capturar.",
      command: "engine purge --source hn --author <autor> o --url <enlace>",
    });
    expect(deletionOf(SOURCE_CATALOG.rss).text).toMatch(/^Por feed, autor o enlace/);
  });
});

describe("the method dialog", () => {
  it("names v3 and v1 and puts the other installed files apart, opening on v3", () => {
    expect(methodChoices(SETTINGS)).toEqual({
      named: ["engine.v3-sel.json", "engine.v1.json"],
      others: ["engine.v2.json", "engine.v3.json"],
    });
    expect(initialMethod({ ...SETTINGS, engineConfig: "engine.v1.json" })).toBe(
      "engine.v3-sel.json",
    );
  });
});

describe("nightRows", () => {
  it("adds the start time only when two reviews share a night", () => {
    const rows = nightRows(
      [
        job({ day: "2026-11-10" }),
        job({ day: "2026-11-09", jobId: "late", startedAt: "2026-11-09T08:56:00.000Z" }),
        job({ day: "2026-11-09", jobId: "early", startedAt: "2026-11-09T08:10:00.000Z" }),
      ],
      null,
      "America/Guayaquil",
    );
    expect(rows.map((row) => [row.day, row.time])).toEqual([
      ["10 nov", null],
      ["9 nov", "03:56"],
      ["9 nov", "03:10"],
    ]);
  });
});

describe("versionChange", () => {
  const v1: EditorialProfileVersion = {
    version: 1,
    name: "SingulariDev",
    audience: "Solo founders",
    language: "en",
    include: ["a", "b", "c", "d", "e"],
    exclude: ["x", "y", "z", "w"],
    hash: "sha256:1",
    createdAt: "2026-11-01T00:00:00.000Z",
    origin: "earlywindow",
    active: false,
  };

  it("says what the first version holds and what a later one changed", () => {
    expect(versionChange(v1, undefined)).toBe(
      "Importada de Earlywindow · 5 temas que cubre, 4 que deja fuera",
    );
    const v2 = {
      ...v1,
      version: 2,
      origin: "operator" as const,
      include: [...v1.include, "home labs and local AI hosting for solo builders"],
    };
    expect(versionChange(v2, v1)).toBe("añade el tema «home labs and local AI hosting for…»");
    const v3 = { ...v2, version: 3, audience: "Founders", exclude: ["x"] };
    expect(versionChange(v3, v2)).toBe("cambia la audiencia y vuelve a admitir 3 temas");
  });
});
