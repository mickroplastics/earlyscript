import { RegistryContext } from "@effect/atom-react";
import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  EnvironmentId,
  type EditorialCardDecision,
  type EditorialGetJudgeOpinionResult,
  type EditorialInbox,
  type EditorialTrendCard,
  type EditorialTrendSummary,
} from "@t3tools/contracts";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import { usePairsModeStore } from "./pairsMode";
import { TrendCardView } from "./TrendCard";
import { TrendCardList } from "./TrendCardList";

const state = vi.hoisted(() => ({ judgeReads: [] as Array<unknown> }));
const judgeAtom = Atom.make<AsyncResult.AsyncResult<EditorialGetJudgeOpinionResult>>(
  AsyncResult.initial(),
);

vi.mock("./state", async () => {
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    editorialEnvironment: {
      ...actual.editorialEnvironment,
      judgeOpinion: (target: unknown) => {
        state.judgeReads.push(target);
        return judgeAtom;
      },
    },
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const RUN_ID = EditorialRunId.make("run_v3_20261013");
const CUTOFF = "2026-10-13T00:00:00.000Z";

const DECISION: EditorialCardDecision = {
  threadId: "thread-1",
  action: "accept",
  utility: 4,
  reason: "Buen tema para el canal",
  decidedAt: "2026-10-14T10:00:00.000Z",
};

const SHOWN: EditorialGetJudgeOpinionResult = {
  _tag: "shown",
  decidedAt: DECISION.decidedAt,
  view: {
    utility: 3.5,
    opinions: [
      {
        judge: "opus",
        model: "claude-opus-5-5",
        utility: 4,
        fit: "core",
        reason: "JUDGE-REASON-OPUS",
        angle: "JUDGE-ANGLE",
      },
      {
        judge: "sol",
        model: "gpt-6.1-sol",
        utility: 3,
        fit: "adjacent",
        reason: "JUDGE-REASON-SOL",
        angle: null,
      },
    ],
  },
};

const card = (overrides: Partial<EditorialTrendCard> = {}): EditorialTrendCard => ({
  origin: "v3",
  section: "moving",
  position: 1,
  movement: "new",
  since: "2026-10-08",
  perennial: false,
  curve: [
    { source: "huggingface", status: "comparable", weeks: [0, 0, 0, 11] },
    { source: "wikipedia", status: "unused", weeks: [] },
  ],
  sourceCount: 1,
  firstSource: { source: "huggingface", day: "2026-10-07" },
  secondSource: null,
  fit: {
    topic: "local and open-weight language models running on personal hardware",
    terms: ["model", "language"],
  },
  saturated: false,
  headlines: [
    {
      itemId: "itm_hf_model_1",
      source: "huggingface",
      title: "nvidia/Nemotron-3.5-Embed-8B-BF16",
      day: "2026-10-09",
      url: "https://huggingface.co/nvidia/Nemotron-3.5-Embed-8B-BF16",
    },
  ],
  evidence: [
    {
      itemId: "itm_hf_model_1",
      source: "huggingface",
      title: "nvidia/Nemotron-3.5-Embed-8B-BF16",
      day: "2026-10-09",
      url: "https://huggingface.co/nvidia/Nemotron-3.5-Embed-8B-BF16",
    },
  ],
  incompleteSources: [],
  decision: DECISION,
  priorDecision: null,
  ...overrides,
});

const trend = (
  id: string,
  label: string,
  overrides: Partial<EditorialTrendCard> = {},
): EditorialTrendSummary => ({
  dossierId: EditorialDossierId.make(id),
  runId: RUN_ID,
  label,
  terms: label.split(" "),
  subtitle: null,
  stage: "growing",
  corroboration: "single_source",
  items7d: 11,
  items28d: 11,
  authors7d: 4,
  volumeRank: 1,
  scoreRank: 1,
  score: 1,
  growth: 1,
  affinity: 0.7,
  sourceCount: 1,
  sources: ["huggingface"],
  sparkline: [],
  isNew: true,
  trendKey: EditorialTrendKey.make(`sig_${id}`),
  card: card(overrides),
});

const renderCard = (summary: EditorialTrendSummary) => {
  const registry = AtomRegistry.make();
  registry.set(judgeAtom, AsyncResult.success(SHOWN));
  return render(
    <RegistryContext.Provider value={registry}>
      <TrendCardView environmentId={ENVIRONMENT_ID} trend={summary} cutoffAt={CUTOFF} defaultOpen />
    </RegistryContext.Provider>,
  );
};

// Everything that would tell the operator what the judges think, or which arm made the card.
const JUDGE_TRACES = [
  "JUDGE-REASON",
  "JUDGE-ANGLE",
  "jueces",
  "juez",
  "opinión del modelo",
  "Opinión del modelo",
  "Utilidad media",
  "claude-opus",
  "gpt-6.1",
  "opus",
  "brazo",
];

/** Sets pairs mode for one test and restores it, with the recorded reads, when the test ends. */
function pairsMode(enabled: boolean): Disposable {
  usePairsModeStore.setState({ enabled });
  state.judgeReads = [];
  return {
    [Symbol.dispose]: () => {
      usePairsModeStore.setState({ enabled: false });
      state.judgeReads = [];
    },
  };
}

describe("brief trend card", () => {
  it("shows its three lines with the movement, the curve by source and the fit", async () => {
    using _mode = pairsMode(false);
    await using screen = await renderCard(trend("dos_a", "architecture commercial deployment"));
    await expect
      .element(screen.getByText("· nueva, desde hace 5 días", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          "huggingface 0→0→0→11 · wikipedia no usada · 1 fuente · apareció en huggingface hace 6 días",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByText(
          /^encaja: local and open-weight language models \(model, language\) · saturado: no/,
        ),
      )
      .toBeVisible();
  });

  it("in pairs mode the DOM holds no judge field, and the opinion is never requested", async () => {
    using _mode = pairsMode(true);
    await using screen = await renderCard(trend("dos_a", "architecture commercial deployment"));
    // The operator's own decision is there, with its time.
    await expect.element(screen.getByText("aceptado", { exact: true })).toBeVisible();
    const html = screen.container.innerHTML;
    for (const trace of JUDGE_TRACES) expect(html).not.toContain(trace);
    expect(screen.container.querySelector("[data-judge-opinion]")).toBeNull();
    expect(state.judgeReads).toEqual([]);
  });

  it("outside pairs mode shows the judges only after a decision with utility", async () => {
    using _mode = pairsMode(false);
    const undecided = await renderCard(trend("dos_b", "gguf openbmb model", { decision: null }));
    await expect
      .element(undecided.getByText("Se muestra después de que registres tu decisión con utilidad."))
      .toBeVisible();
    expect(undecided.container.innerHTML).not.toContain("JUDGE-REASON");
    expect(state.judgeReads).toEqual([]);
    await undecided[Symbol.asyncDispose]();

    await using decided = await renderCard(trend("dos_a", "architecture commercial deployment"));
    await expect.element(decided.getByText("Opinión del modelo, no validada.")).toBeVisible();
    await expect.element(decided.getByText(/JUDGE-REASON-OPUS/)).toBeVisible();
    await expect.element(decided.getByText("Utilidad media 3,5 de 5")).toBeVisible();
    expect(state.judgeReads).toEqual([
      { environmentId: ENVIRONMENT_ID, input: { runId: RUN_ID, dossierId: "dos_a" } },
    ]);
  });

  it("shows 'ya decidido' from an earlier decision on the same topic", async () => {
    using _mode = pairsMode(false);
    await using screen = await renderCard(
      trend("dos_c", "typescript compiler native bun", {
        priorDecision: { ...DECISION, action: "reject", decidedAt: "2026-09-30T08:00:00.000Z" },
      }),
    );
    await expect.element(screen.getByText("ya decidido el 2026-09-30: rechazado")).toBeVisible();
  });
});

describe("card list", () => {
  it("lists 'En movimiento' and 'De fondo' in the engine's order", async () => {
    using _mode = pairsMode(false);
    const inbox: EditorialInbox = {
      run: {
        runId: RUN_ID,
        cutoffAt: CUTOFF,
        finishedAt: null,
        status: "ok",
        configVersion: "earlyscript.engine.v3",
        sources: ["hn", "huggingface"],
        dossierCount: 3,
      },
      sort: "new-first-growth",
      trends: [
        trend("dos_z", "second moving", { position: 2 }),
        trend("dos_y", "background one", { section: "background", position: 1, perennial: true }),
        trend("dos_x", "first moving", { position: 1 }),
      ],
      total: 3,
      newCount: 3,
      snoozedCount: 0,
      dismissedCount: 0,
    };
    const registry = AtomRegistry.make();
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <TrendCardList environmentId={ENVIRONMENT_ID} inbox={inbox} />
      </RegistryContext.Provider>,
    );
    const moving = screen.getByRole("region", { name: "En movimiento" });
    const background = screen.getByRole("region", { name: "De fondo" });
    await expect.element(moving).toBeVisible();
    expect(
      [...moving.element().querySelectorAll("[data-trend-card]")].map((node) =>
        node.getAttribute("aria-label"),
      ),
    ).toEqual(["first moving", "second moving"]);
    await expect.element(background.getByText(/con antecedente perenne/)).toBeVisible();
    // No position, rank or score is printed on a card.
    expect(screen.container.textContent).not.toMatch(/#\d|puntaje|puesto/);
  });
});
