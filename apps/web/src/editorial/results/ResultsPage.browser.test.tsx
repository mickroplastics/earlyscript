import type {
  EditorialDurationStats,
  EditorialResultsDecision,
  EditorialResultsMode,
  EditorialResultsModeSummary,
  EditorialResultsSummary,
} from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DECISIONS_PAGE_SIZE } from "./DecisionsTab";
import { FiguresProvider, useFigures } from "./FigureFrame";
import { ManualBaselineView } from "./ManualBaselineSection";
import { BASELINE_RECORD } from "./manualBaseline.fixture";
import { RESULTS_FIGURE_ORDER } from "./resultsFigures.logic";
import {
  ResultsPage,
  ResultsView,
  type ResultsDecisionsControls,
  type ResultsOverviewControls,
} from "./ResultsPage";

// The page's reads, served from memory; each decisions read records the input it asked with.
const reads = vi.hoisted(() => ({
  summary: null as EditorialResultsSummary | null,
  decisions: [] as Array<EditorialResultsDecision>,
  decisionInputs: [] as Array<Readonly<Record<string, unknown>>>,
  atoms: new Map<string, unknown>(),
}));

vi.mock(import("../resultsState"), async (original) => {
  const real = await original();
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const cached = (key: string, value: () => unknown) => {
    if (!reads.atoms.has(key)) reads.atoms.set(key, Atom.make(AsyncResult.success(value())));
    return reads.atoms.get(key) as never;
  };
  return {
    ...real,
    editorialResultsEnvironment: {
      ...real.editorialResultsEnvironment,
      summary: () => cached("summary", () => reads.summary),
      baseline: () => cached("baseline", () => null),
      decisions: ({ input }: { readonly input: Readonly<Record<string, unknown>> }) => {
        reads.decisionInputs.push(input);
        return cached(`decisions:${JSON.stringify(input)}`, () => ({
          offset: 0,
          total: reads.decisions.length,
          decisions: reads.decisions,
        }));
      },
    } as never,
  };
});

vi.mock(import("../EditorialPage"), async (original) => ({
  ...(await original()),
  EditorialPage: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShells: () => [],
}));

const MINUTE = 60_000;

const stats = (n: number, median: number | null, q1 = median, q3 = median) =>
  ({
    n,
    medianMs: median === null ? null : median * MINUTE,
    q1Ms: q1 === null ? null : q1 * MINUTE,
    q3Ms: q3 === null ? null : q3 * MINUTE,
    minMs: q1 === null ? null : q1 * MINUTE,
    maxMs: q3 === null ? null : q3 * MINUTE,
  }) satisfies EditorialDurationStats;

const mode = (
  name: EditorialResultsMode,
  stages: Record<"explore" | "read" | "write" | "decide", EditorialDurationStats>,
  total: EditorialDurationStats,
): EditorialResultsModeSummary => ({
  mode: name,
  threads: 3,
  provisionalClock: 0,
  actions: { accept: 1, edit: 1, reject: 1 },
  stages: (["explore", "read", "write", "decide"] as const).map((stage) => ({
    stage,
    stats: stages[stage],
  })),
  total,
  partialCoverage: 0,
  utility: { n: 3, mean: name === "assisted" ? 4 : 3, distribution: [0, 0, 1, 1, 1] },
  citations: { threads: 3, claims: 13, cited: 11, ratio: 11 / 13 },
  withVideoResults: 1,
});

const NONE = { assisted: 0, manual: 0 };

// The six-thread fixture of the server tests, in minutes.
const SUMMARY: EditorialResultsSummary = {
  modes: [
    mode(
      "assisted",
      {
        explore: stats(1, 4),
        read: stats(3, 8, 7, 9),
        write: stats(3, 26, 24, 28),
        decide: stats(3, 3, 2.5, 3.5),
      },
      stats(3, 40, 36.5, 41),
    ),
    mode(
      "manual",
      {
        explore: stats(3, 45, 41.5, 52.5),
        read: stats(0, null),
        write: stats(3, 50, 45, 52.5),
        decide: stats(3, 4, 3.5, 4.5),
      },
      stats(3, 100, 98.5, 101.5),
    ),
  ],
  comparisons: [
    {
      key: "explore",
      assisted: stats(3, 10, 9, 10),
      manual: stats(3, 45, 41.5, 52.5),
      partial: NONE,
    },
    { key: "write", assisted: stats(3, 26, 24, 28), manual: stats(3, 50, 45, 52.5), partial: NONE },
    {
      key: "total",
      assisted: stats(3, 40, 36.5, 41),
      manual: stats(3, 100, 98.5, 101.5),
      partial: NONE,
    },
    {
      key: "recorded",
      assisted: stats(4, 37, 25, 40.25),
      manual: stats(3, 100, 98.5, 101.5),
      partial: { assisted: 1, manual: 0 },
    },
  ],
  inbox: { read: 6, observing: 1, dismissed: 2, production: 3 },
  excludedByDomain: 0,
  decisionCount: 7,
  firstDecidedAt: "2026-10-20T13:38:00.000Z",
  lastDecidedAt: "2026-10-28T14:00:00.000Z",
  asOf: "2026-10-31T00:00:00.000Z",
};

/** Durations join numbers to units with no-break spaces; the assertions read plain ones. */
const textOf = (element: Element | null | undefined) =>
  element?.textContent?.replaceAll("\u00a0", " ");

const decision = (overrides: Partial<EditorialResultsDecision>): EditorialResultsDecision => ({
  decisionId: "decision-1",
  threadId: "thread-assisted-1",
  environmentId: "env-1",
  mode: "assisted",
  trendKey: "trend:local-models",
  trendLabel: "local models llama",
  runId: null,
  dossierId: null,
  action: "accept",
  utility: 4,
  reason: null,
  decidedAt: "2026-10-20T13:38:00.000Z",
  current: true,
  clockDefinitive: true,
  stages: ["read", "write", "decide"],
  coverage: "complete",
  durations: {
    exploreMs: null,
    readMs: 8 * MINUTE,
    writeMs: 22 * MINUTE,
    decideMs: 3 * MINUTE,
    totalMs: 33 * MINUTE,
  },
  script: { versionHash: "hash", claims: 4, cited: 4 },
  video: {
    views: 1240,
    subscribers: null,
    clicks: null,
    comments: null,
    observedAt: "2026-10-23T13:38:00.000Z",
  },
  ...overrides,
});

const MANUAL_DECISION = decision({
  decisionId: "decision-2",
  threadId: "thread-manual-1",
  mode: "manual",
  trendKey: null,
  action: "edit",
  utility: 3,
  decidedAt: "2026-10-28T14:00:00.000Z",
  clockDefinitive: false,
  stages: ["explore", "write", "decide"],
  durations: {
    exploreMs: 45 * MINUTE,
    readMs: null,
    writeMs: 50 * MINUTE,
    decideMs: 5 * MINUTE,
    totalMs: 100 * MINUTE,
  },
  script: null,
  video: null,
});

const TRIAL_DECISION = decision({
  decisionId: "decision-trial",
  threadId: "thread-trial-1",
  cohort: "trial",
  decidedAt: "2026-10-18T14:00:00.000Z",
});

const controls = (overrides: Partial<ResultsDecisionsControls> = {}): ResultsDecisionsControls => ({
  state: {
    _tag: "ready",
    page: { offset: 0, total: 2, decisions: [MANUAL_DECISION, decision({ current: false })] },
  },
  onRetry: () => {},
  filter: "all",
  onFilter: () => {},
  showTrials: false,
  onShowTrials: () => {},
  onPage: () => {},
  ...overrides,
});

const OVERVIEW: ResultsOverviewControls = {
  state: {
    _tag: "ready",
    page: { offset: 0, total: 2, decisions: [MANUAL_DECISION, decision({})] },
  },
  onRetry: () => {},
};

const TRIALS = [
  { threadId: "thread-trial-1", environmentId: "env-1", createdAt: "2026-10-18T13:00:00.000Z" },
  { threadId: "thread-trial-2", environmentId: "env-1", createdAt: "2026-10-19T13:00:00.000Z" },
];

/** The figures the provider would save, read on click. */
function FigureIds() {
  const figures = useFigures();
  const [ids, setIds] = useState<ReadonlyArray<string>>([]);
  return (
    <button type="button" onClick={() => setIds(figures.figures().map((figure) => figure.id))}>
      {ids.length === 0 ? "Leer figuras" : ids.join(",")}
    </button>
  );
}

describe("ResultsPage", () => {
  it("asks for the trials only once the box is ticked", async () => {
    reads.summary = { ...SUMMARY, trials: TRIALS };
    reads.decisions = [MANUAL_DECISION, decision({})];
    reads.decisionInputs = [];
    reads.atoms = new Map();
    await using screen = await render(<ResultsPage environmentId={"env-1" as EnvironmentId} />, {
      router: "/?tab=decisiones",
    });
    const tableRead = () =>
      reads.decisionInputs.findLast((input) => input.limit === DECISIONS_PAGE_SIZE);
    await expect
      .element(screen.getByRole("table", { name: "Decisiones registradas" }))
      .toBeVisible();
    expect(tableRead()).toEqual({ limit: DECISIONS_PAGE_SIZE, cohort: "human" });
    await userEvent.click(screen.getByText(/Mostrar los 2 ensayos/));
    await vi.waitFor(() => expect(tableRead()).toEqual({ limit: DECISIONS_PAGE_SIZE }));
  });

  it("says a failed reread of the dots instead of the last read it kept", async () => {
    reads.summary = SUMMARY;
    reads.decisions = [MANUAL_DECISION, decision({})];
    reads.decisionInputs = [];
    const previous = AsyncResult.success({ offset: 0, total: 2, decisions: reads.decisions });
    reads.atoms = new Map([
      [
        `decisions:${JSON.stringify({ limit: 100 })}`,
        Atom.make(AsyncResult.failWithPrevious("down", { previous: Option.some(previous) })),
      ],
    ]);
    await using screen = await render(<ResultsPage environmentId={"env-1" as EnvironmentId} />);
    await expect
      .element(screen.getByText("No se pudieron leer los puntos por ficha · raya: mediana."))
      .toBeVisible();
    expect(textOf(screen.container)).not.toContain("Puntos no disponibles");
    await expect.element(screen.getByRole("button", { name: "Reintentar" })).toBeVisible();
  });
});

describe("ResultsView", () => {
  it("shows an empty comparison as a baseline note instead of a headline number", async () => {
    await using screen = await render(
      <ResultsView
        summary={{
          ...SUMMARY,
          comparisons: SUMMARY.comparisons.map((comparison) => ({
            ...comparison,
            assisted: stats(0, null),
            manual: stats(0, null),
          })),
        }}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
    );
    const baselineNote = screen.getByText("Consulta la línea base manual").first();
    await expect.element(baselineNote).toHaveClass("text-xs");
    await expect.element(baselineNote).not.toHaveClass("text-3xl");
  });

  it("says plainly that nothing was decided yet", async () => {
    await using screen = await render(
      <ResultsView
        summary={{
          ...SUMMARY,
          modes: [],
          comparisons: [],
          decisionCount: 0,
          firstDecidedAt: null,
          lastDecidedAt: null,
          inbox: { read: 2, observing: 0, dismissed: 1, production: 0 },
        }}
        decisions={controls({
          state: { _tag: "ready", page: { offset: 0, total: 0, decisions: [] } },
        })}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
    );
    await expect.element(screen.getByText("Aún no hay decisiones registradas")).toBeVisible();
    await expect
      .element(screen.getByText(/Al registrar la decisión de un hilo de video/))
      .toBeVisible();
    await expect.element(screen.getByText("Ninguna decisión registrada todavía.")).toBeVisible();
    // Only the baseline and, once it moved, the inbox: reading happens before any decision.
    const tabs = screen.getByRole("tab");
    expect(tabs.elements().map((tab) => tab.textContent)).toEqual([
      "Línea base manual",
      "Bandeja y video",
    ]);
    await userEvent.click(screen.getByRole("tab", { name: "Bandeja y video" }));
    await expect
      .element(screen.getByRole("heading", { name: "Bandeja de tendencias" }))
      .toBeVisible();
    expect(screen.container.querySelector("[data-kpi-side]")).toBeNull();
    expect(screen.container.querySelector('[data-figure="video"]')).toBeNull();
    expect(screen.container.querySelector("table")).toBeNull();
  });

  it("compares the two modes by medians with n, without a saving", async () => {
    await using screen = await render(
      <ResultsView
        summary={{
          ...SUMMARY,
          // Fewer scores than timed threads in one mode, more in the other.
          modes: SUMMARY.modes.map((entry) => ({
            ...entry,
            utility: { ...entry.utility, n: entry.mode === "assisted" ? 5 : 2 },
          })),
        }}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
    );
    const total = screen.container.querySelector('[data-comparison="total"]');
    expect(textOf(total)).toContain("40 min");
    expect(textOf(total)).toContain("1 h 40 min");
    expect(textOf(total)).toContain("Mediana manual 1 h mayor (n = 3 y 3).");
    expect(textOf(total)).toContain("solo en hilos que las registraron todas");
    // The recorded total takes partial threads in, apart from the whole process, and warns.
    const recorded = screen.container.querySelector('[data-comparison="recorded"]');
    expect(textOf(recorded)).toContain("Total de etapas registradas");
    expect(textOf(recorded)).toContain("asistido 37 min (n = 4)");
    expect(textOf(recorded)).toContain("Cobertura parcial: incluye 1 hilo");
    expect(recorded?.closest("[data-comparison=total]")).toBeNull();
    expect(screen.container.textContent).not.toMatch(/ahorr/i);
    // The utility card counts its own sample, not the time card's.
    const utility = screen
      .getByRole("heading", { name: /^Utilidad registrada/ })
      .element().parentElement;
    expect(textOf(utility?.querySelector('[data-kpi-side="assisted"]'))).toContain("n = 5");
    expect(textOf(utility?.querySelector('[data-kpi-side="manual"]'))).toContain("n = 2");
    // A stage that never ran in a mode is a dashed line, not a zero-length bar.
    const missing = screen.container.querySelector('[data-stage-bar="manual:read"]');
    expect(missing?.querySelector("rect")).toBeNull();
    expect(missing?.querySelector("line")).not.toBeNull();
    const writing = screen.container.querySelector('[data-stage-bar="assisted:write"]');
    expect(writing?.querySelector("rect")).not.toBeNull();
    expect(writing?.querySelector("[data-iqr]")).not.toBeNull();
  });

  it("draws one dot per whole-process thread only when they match the printed n", async () => {
    await using screen = await render(
      <ResultsView
        summary={{
          ...SUMMARY,
          comparisons: SUMMARY.comparisons.map((comparison) =>
            comparison.key === "total"
              ? { ...comparison, assisted: stats(1, 33), manual: stats(0, null) }
              : comparison,
          ),
        }}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
    );
    // The manual decision awaits resolution and the other is replaced: one assisted dot.
    const strip = screen.container.querySelector("[data-time-strip]");
    expect(strip?.getAttribute("data-time-strip")).toBe("dots");
    expect(strip?.querySelectorAll('[data-dot="assisted"]')).toHaveLength(1);
    expect(strip?.querySelectorAll('[data-dot="manual"]')).toHaveLength(0);

    await screen.rerender(
      <ResultsView
        summary={SUMMARY}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
    );
    expect(
      screen.container.querySelector("[data-time-strip]")?.getAttribute("data-time-strip"),
    ).toBe("medians");
    await expect.element(screen.getByText(/^Puntos no disponibles/)).toBeVisible();
  });

  it("never promises dots the time card has not drawn", async () => {
    const onRetry = vi.fn();
    const view = (overview: ResultsOverviewControls) => (
      <ResultsView
        summary={SUMMARY}
        decisions={controls()}
        overview={overview}
        threadTitles={new Map()}
      />
    );
    await using screen = await render(view({ state: { _tag: "loading" }, onRetry }));
    const foot = () => textOf(screen.container);
    expect(foot()).toContain("Cargando los puntos por ficha");
    expect(foot()).not.toContain("Un punto por ficha");
    expect(screen.container.querySelector("[data-points-failure]")).toBeNull();

    await screen.rerender(
      view({ state: { _tag: "failure", message: "No se pudo leer." }, onRetry }),
    );
    expect(foot()).toContain("No se pudieron leer los puntos por ficha");
    expect(foot()).not.toContain("Un punto por ficha");
    expect(screen.container.querySelectorAll("[data-dot]")).toHaveLength(0);
    // The card retries its own read, without visiting another tab.
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("switches tabs by click and by arrow keys and keeps the tab in the URL", async () => {
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
    );
    await expect
      .element(screen.getByRole("tab", { name: "Tiempo por etapa" }))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Utilidad y citas" }));
    await expect.element(screen.getByRole("heading", { name: /útiles y citados/ })).toBeVisible();
    expect(screen.router?.state.location.search).toEqual({ tab: "utilidad" });
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(screen.getByRole("tab", { name: "Línea base manual" }))
      .toHaveAttribute("aria-selected", "true");
    expect(screen.router?.state.location.search).toEqual({ tab: "linea-base" });
    // The panel left stays mounted, hidden: its figure keeps its place.
    await expect.element(screen.getByText(/útiles y citados/)).not.toBeVisible();
  });

  it("opens on the tab the URL names", async () => {
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
      { router: "/?tab=decisiones" },
    );
    await expect
      .element(screen.getByRole("tab", { name: /^Decisiones/ }))
      .toHaveAttribute("aria-selected", "true");
    await expect
      .element(screen.getByRole("table", { name: "Decisiones registradas" }))
      .toBeVisible();
  });

  it("lists decisions newest first, links known threads and marks replaced ones", async () => {
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map([["thread-manual-1", "Guion sobre evaluaciones de agentes"]])}
      />,
      { router: "/?tab=decisiones" },
    );
    const table = screen.getByRole("table", { name: "Decisiones registradas" });
    await expect.element(table).toBeVisible();
    const link = table.getByRole("link", { name: "Guion sobre evaluaciones de agentes" });
    await expect.element(link).toHaveAttribute("href", "/env-1/thread-manual-1");
    const rows = table.element().querySelectorAll("[data-decision]");
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0])).toContain("≥ 1 h 40 min");
    expect(textOf(rows[0])).toContain("sin guion");
    // Without a known title the trend's dossier label names the thread, never its key.
    expect(textOf(rows[1])).toContain("Tendencia: local models llama");
    expect(textOf(rows[1])).not.toContain("trend:");
    expect(rows[1]?.textContent).toContain("reemplazada");
    expect(rows[1]?.textContent).toContain("4 de 4");
    expect(rows[1]?.textContent).toContain("1240");
  });

  it("filters decisions by mode", async () => {
    const onFilter = vi.fn();
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls({ onFilter })}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
      { router: "/?tab=decisiones" },
    );
    await userEvent.click(screen.getByRole("button", { name: "Manual" }));
    expect(onFilter).toHaveBeenCalledWith("manual");
  });

  it("shows the agent trials on request, apart from the human decisions", async () => {
    const onShowTrials = vi.fn();
    const summary = { ...SUMMARY, trials: TRIALS };
    const overview: ResultsOverviewControls = {
      ...OVERVIEW,
      state: {
        _tag: "ready",
        page: { offset: 0, total: 3, decisions: [MANUAL_DECISION, decision({}), TRIAL_DECISION] },
      },
    };
    await using screen = await render(
      <ResultsView
        summary={summary}
        decisions={controls({ onShowTrials })}
        overview={overview}
        threadTitles={new Map()}
      />,
      { router: "/?tab=decisiones" },
    );
    expect(screen.container.querySelector("[data-trials-separator]")).toBeNull();
    await expect
      .element(screen.getByRole("checkbox", { name: /Mostrar los 2 ensayos/ }))
      .not.toBeChecked();
    await userEvent.click(screen.getByText(/Mostrar los 2 ensayos/));
    expect(onShowTrials).toHaveBeenCalledWith(true);

    await screen.rerender(
      <ResultsView
        summary={summary}
        decisions={controls({
          onShowTrials,
          showTrials: true,
          state: {
            _tag: "ready",
            page: { offset: 0, total: 2, decisions: [MANUAL_DECISION, TRIAL_DECISION] },
          },
        })}
        overview={overview}
        threadTitles={new Map()}
      />,
    );
    const table = screen.getByRole("table", { name: "Decisiones registradas" }).element();
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.hasAttribute("data-trials-separator"))).toEqual([
      false,
      true,
      false,
    ]);
    expect(rows[2]?.textContent).toContain("Ensayo");
    // A decided trial with no known title still links, under its place among the trials.
    await expect
      .element(screen.getByRole("table").getByRole("link", { name: "Ensayo 1" }))
      .toHaveAttribute("href", "/env-1/thread-trial-1");
    // The trial without a decision has no row, so it is linked under the table.
    const links = () => screen.container.querySelector("[data-trial-links]");
    expect(textOf(links())).toMatch(/^Ensayos sin decisión: Ensayo 2$/);
    await expect
      .element(screen.getByRole("link", { name: "Ensayo 2" }))
      .toHaveAttribute("href", "/env-1/thread-trial-2");

    // A log read past its page or a failed read cannot tell which trials lack a decision:
    // every trial is linked, without saying so.
    for (const state of [
      {
        _tag: "ready",
        page: { offset: 0, total: 101, decisions: [MANUAL_DECISION, TRIAL_DECISION] },
      },
      { _tag: "failure", message: "No se pudo leer." },
    ] satisfies ReadonlyArray<ResultsOverviewControls["state"]>) {
      await screen.rerender(
        <ResultsView
          summary={summary}
          decisions={controls({ onShowTrials, showTrials: true })}
          overview={{ ...overview, state }}
          threadTitles={new Map()}
        />,
      );
      expect(textOf(links())).toBe("Ensayos de agente: Ensayo 1Ensayo 2");
      expect(links()?.querySelectorAll("a")).toHaveLength(2);
    }
  });

  it("folds the sample and its limits under the caveat", async () => {
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls()}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Muestra y límites" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect.element(screen.getByRole("heading", { name: "Límites" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Ocultar" }));
    await expect.element(screen.getByRole("heading", { name: "Límites" })).not.toBeInTheDocument();
  });

  it("saves every figure, in the fixed order, while another tab is on screen", async () => {
    await using screen = await render(
      <FiguresProvider
        environmentId={"env-1" as EnvironmentId}
        threads={6}
        order={RESULTS_FIGURE_ORDER}
      >
        <ResultsView
          summary={SUMMARY}
          decisions={controls()}
          overview={OVERVIEW}
          threadTitles={new Map()}
          exportAction={<FigureIds />}
          baseline={
            <ManualBaselineView
              record={BASELINE_RECORD}
              failure={null}
              summary={SUMMARY}
              importState={{ _tag: "idle" }}
              onImport={() => {}}
            />
          }
        />
      </FiguresProvider>,
      { router: "/?tab=decisiones" },
    );
    await userEvent.click(screen.getByRole("button", { name: "Leer figuras" }));
    await expect
      .element(screen.getByRole("button", { name: RESULTS_FIGURE_ORDER.join(",") }))
      .toBeVisible();
  });

  it("says the decisions are loading", async () => {
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls({ state: { _tag: "loading" } })}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
      { router: "/?tab=decisiones" },
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("Cargando decisiones…");
    expect(screen.container.querySelector("[data-decision]")).toBeNull();
  });

  it("explains a failed decisions read and retries it", async () => {
    const onRetry = vi.fn();
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls({
          state: {
            _tag: "failure",
            message: "La base editorial de este entorno no se pudo leer.",
          },
          onRetry,
        })}
        overview={OVERVIEW}
        threadTitles={new Map()}
      />,
      { router: "/?tab=decisiones" },
    );
    await expect.element(screen.getByText("No se pudieron leer las decisiones")).toBeVisible();
    await expect
      .element(screen.getByText("La base editorial de este entorno no se pudo leer."))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
