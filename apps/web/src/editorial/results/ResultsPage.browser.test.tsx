import type {
  EditorialDurationStats,
  EditorialResultsDecision,
  EditorialResultsMode,
  EditorialResultsModeSummary,
  EditorialResultsSummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ResultsView, type ResultsDecisionsControls } from "./ResultsPage";

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
  utility: { n: 3, mean: name === "assisted" ? 4 : 3, distribution: [0, 0, 1, 1, 1] },
  citations: { threads: 3, claims: 13, cited: 11, ratio: 11 / 13 },
  withVideoResults: 1,
});

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
    { key: "explore", assisted: stats(3, 10, 9, 10), manual: stats(3, 45, 41.5, 52.5) },
    { key: "write", assisted: stats(3, 26, 24, 28), manual: stats(3, 50, 45, 52.5) },
    { key: "total", assisted: stats(3, 40, 36.5, 41), manual: stats(3, 100, 98.5, 101.5) },
  ],
  inbox: { read: 6, observing: 1, dismissed: 2, production: 3 },
  decisionCount: 7,
  firstDecidedAt: "2026-10-20T13:38:00.000Z",
  lastDecidedAt: "2026-10-28T14:00:00.000Z",
  asOf: "2026-10-31T00:00:00.000Z",
};

const decision = (overrides: Partial<EditorialResultsDecision>): EditorialResultsDecision => ({
  decisionId: "decision-1",
  threadId: "thread-assisted-1",
  environmentId: "env-1",
  mode: "assisted",
  trendKey: "trend:local-models",
  runId: null,
  dossierId: null,
  action: "accept",
  utility: 4,
  reason: null,
  decidedAt: "2026-10-20T13:38:00.000Z",
  current: true,
  clockDefinitive: true,
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

const controls = (overrides: Partial<ResultsDecisionsControls> = {}): ResultsDecisionsControls => ({
  page: {
    offset: 0,
    total: 2,
    decisions: [
      decision({
        decisionId: "decision-2",
        threadId: "thread-manual-1",
        mode: "manual",
        trendKey: null,
        action: "edit",
        utility: 3,
        decidedAt: "2026-10-28T14:00:00.000Z",
        clockDefinitive: false,
        durations: {
          exploreMs: 45 * MINUTE,
          readMs: null,
          writeMs: 50 * MINUTE,
          decideMs: 5 * MINUTE,
          totalMs: 100 * MINUTE,
        },
        script: null,
        video: null,
      }),
      decision({ current: false }),
    ],
  },
  filter: "all",
  onFilter: () => {},
  onPage: () => {},
  ...overrides,
});

describe("ResultsView", () => {
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
        decisions={controls({ page: { offset: 0, total: 0, decisions: [] } })}
        threadTitles={new Map()}
      />,
    );
    await expect.element(screen.getByText("Aún no hay decisiones registradas")).toBeVisible();
    await expect
      .element(screen.getByText("Resultados se llena con cada hilo de video que cierres."))
      .toBeVisible();
    // The inbox counters stay: reading and dismissing happen before any decision.
    await expect
      .element(screen.getByRole("heading", { name: "Bandeja de tendencias" }))
      .toBeVisible();
    expect(screen.container.querySelector("#tiempos")).toBeNull();
    expect(screen.container.querySelector("table")).toBeNull();
  });

  it("compares the two modes by medians with n, without a saving", async () => {
    await using screen = await render(
      <ResultsView summary={SUMMARY} decisions={controls()} threadTitles={new Map()} />,
    );
    const total = screen.container.querySelector('[data-comparison="total"]');
    expect(total?.textContent).toContain("40 min");
    expect(total?.textContent).toContain("1 h 40 min");
    expect(total?.textContent).toContain("Mediana manual 1 h mayor (n = 3 y 3)");
    expect(screen.container.querySelector("#tiempos")?.textContent).not.toMatch(/%|ahorr/i);
    // A stage that never ran in a mode is a dashed line, not a zero-length bar.
    const missing = screen.container.querySelector('[data-stage-bar="manual:read"]');
    expect(missing?.querySelector("rect")).toBeNull();
    expect(missing?.querySelector("line")).not.toBeNull();
    const writing = screen.container.querySelector('[data-stage-bar="assisted:write"]');
    expect(writing?.querySelector("rect")).not.toBeNull();
    expect(writing?.querySelector("[data-iqr]")).not.toBeNull();
  });

  it("lists decisions newest first, links known threads and marks replaced ones", async () => {
    await using screen = await render(
      <ResultsView
        summary={SUMMARY}
        decisions={controls()}
        threadTitles={new Map([["thread-manual-1", "Guion sobre evaluaciones de agentes"]])}
      />,
    );
    const table = screen.getByRole("table", { name: "Decisiones registradas" });
    await expect.element(table).toBeVisible();
    const link = screen.getByRole("link", { name: "Guion sobre evaluaciones de agentes" });
    await expect.element(link).toHaveAttribute("href", "/env-1/thread-manual-1");
    const rows = screen.container.querySelectorAll("[data-decision]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("≥ 1 h 40 min");
    expect(rows[0]?.textContent).toContain("sin guion");
    expect(rows[1]?.textContent).toContain("local-models");
    expect(rows[1]?.textContent).toContain("reemplazada");
    expect(rows[1]?.textContent).toContain("4 de 4");
    expect(rows[1]?.textContent).toContain("1240");
  });

  it("filters decisions by mode", async () => {
    const onFilter = vi.fn();
    await using screen = await render(
      <ResultsView summary={SUMMARY} decisions={controls({ onFilter })} threadTitles={new Map()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Manual" }));
    expect(onFilter).toHaveBeenCalledWith("manual");
  });
});
