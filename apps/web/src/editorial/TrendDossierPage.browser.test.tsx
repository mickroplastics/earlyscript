import { EditorialDossierId, EditorialRunId, type EditorialTrendDossier } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { TrendDossierView } from "./TrendDossierPage";

const state = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("../browser/useOpenLink", () => ({
  useOpenLink: () => async (url: string) => {
    state.opened.push(url);
  },
}));

function setup() {
  state.opened = [];
}

const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");

const evidence = (index: number) => ({
  itemId: `itm_hn_${index}`,
  source: "hn",
  title: `Quantum item ${index}`,
  author: "xnx",
  publishedAt: "2026-10-15T18:26:30.000Z",
  permalink: `https://news.ycombinator.com/item?id=${index}`,
  externalUrl: `https://example.com/${index}`,
});

// The quantum computing dossier of the 19 October run, with one uncaptured day added.
const DOSSIER: EditorialTrendDossier = {
  trend: {
    dossierId: EditorialDossierId.make("dos_bbb80d57481e"),
    runId: RUN_ID,
    label: "quantum computing ibm open",
    terms: ["quantum", "computing", "ibm"],
    subtitle: "Designing more efficient quantum circuits with Claude",
    stage: "growing",
    corroboration: "single_source",
    items7d: 11,
    items28d: 38,
    authors7d: 11,
    volumeRank: 2,
    scoreRank: 13,
    score: 1.026179,
    growth: 0.69,
    affinity: 0.608747,
    sourceCount: 1,
    sources: ["hn"],
    sparkline: [],
    isNew: true,
  },
  run: {
    runId: RUN_ID,
    cutoffAt: "2026-10-19T00:00:00.000Z",
    finishedAt: "2026-10-27T00:43:13.414Z",
    status: "ok",
    configVersion: "engine.v0.02",
    sources: ["hn", "github"],
    dossierCount: 18,
  },
  rankMethod: "weighted_sum.v0.01",
  rankComponents: [],
  affinityThreshold: 0.6,
  curve: [
    { day: "2026-10-16", items: 2, authors: 2, sources: 1, known: true },
    { day: "2026-10-17", items: 0, authors: 0, sources: 0, known: false },
    { day: "2026-10-18", items: 0, authors: 0, sources: 0, known: true },
  ],
  coverage: [
    { source: "hn", windowDays: 28, daysComplete: 28, daysPartial: 0, daysUnavailable: 0 },
    { source: "github", windowDays: 28, daysComplete: 0, daysPartial: 28, daysUnavailable: 0 },
  ],
  evidence: [1, 2, 3, 4, 5, 6].map(evidence),
  evidenceTotal: 10,
  evidenceOffset: 0,
};

describe("TrendDossierView", () => {
  it("outlines an uncaptured day instead of drawing it as zero", async () => {
    setup();
    await using screen = await render(
      <TrendDossierView dossier={DOSSIER} evidence={DOSSIER} onEvidencePage={() => {}} />,
    );
    const day = (date: string) => screen.container.querySelector(`[data-curve-day="${date}"]`);
    expect(day("2026-10-17")?.hasAttribute("data-unknown")).toBe(true);
    expect(day("2026-10-18")?.hasAttribute("data-unknown")).toBe(false);
    await expect.element(screen.getByText("Cobertura parcial en GitHub")).toBeVisible();
  });

  it("pages the evidence, opens links outside the app and keeps decisions disabled", async () => {
    setup();
    const onEvidencePage = vi.fn();
    await using screen = await render(
      <TrendDossierView dossier={DOSSIER} evidence={DOSSIER} onEvidencePage={onEvidencePage} />,
    );
    await expect.element(screen.getByText("1–6 de 10")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Siguientes" }));
    expect(onEvidencePage).toHaveBeenCalledWith(6);

    await userEvent.click(screen.getByRole("link", { name: "Quantum item 1" }));
    expect(state.opened).toEqual(["https://example.com/1"]);

    for (const label of ["Crear hilo de video", "Seguir observando", "Descartar…"]) {
      await expect.element(screen.getByRole("button", { name: label })).toBeDisabled();
    }
  });
});
