import {
  EditorialDossierId,
  EditorialRunId,
  EditorialTrendKey,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type EditorialTrendDossier,
  type EditorialTrendInboxState,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
// The dialog's layers stack by its CSS; without it the inert overlay takes the clicks.
import "~/index.css";

import { render } from "../../test/render";
import { TrendDossierView, type TrendPresentationActions } from "./TrendDossierPage";

const state = vi.hoisted(() => ({
  opened: [] as string[],
  commands: [] as Array<readonly [string, unknown]>,
}));
vi.mock("../browser/useOpenLink", () => ({
  useOpenLink: () => async (url: string) => {
    state.opened.push(url);
  },
}));
// Each command answers as the server would for the quantum trend.
vi.mock("../state/use-orchestration-command", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useOrchestrationCommand:
      (command: { readonly label: string }) => async (value: { readonly input: unknown }) => {
        state.commands.push([command.label, value.input]);
        return AsyncResult.success(
          command.label.endsWith("create-video") ? { threadId: "thread-video" } : {},
        );
      },
  };
});
vi.mock("./videoThreadTarget", () => ({
  resolveVideoThreadTarget: () => ({
    projectId: "project:studio",
    modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
    runtimeMode: "approval-required",
  }),
}));

function setup() {
  state.opened = [];
  state.commands = [];
}

const ENVIRONMENT_ID = EnvironmentId.make("env-1");
const TREND_KEY = EditorialTrendKey.make("sig_69a4b83dd577");
const AT = "2026-10-31T08:00:00.000Z";

const RUN_ID = EditorialRunId.make("run_20261019_20261027T003754_2263f7");

const evidence = (index: number) => ({
  itemId: `itm_hn_${index}`,
  source: "hn",
  title: `Quantum item ${index}`,
  // Link posts have no body: only the second item carries an excerpt.
  excerpt: index === 2 ? "IBM opened its quantum stack to outside researchers." : "",
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
    trendKey: TREND_KEY,
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
  evidenceRange: { from: "2026-09-09T08:27:14.000Z", to: "2026-10-16T18:00:18.000Z" },
};

describe("TrendDossierView", () => {
  it("outlines an uncaptured day instead of drawing it as zero", async () => {
    setup();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        evidence={DOSSIER}
        onEvidencePage={() => {}}
      />,
    );
    const day = (date: string) => screen.container.querySelector(`[data-curve-day="${date}"]`);
    expect(day("2026-10-17")?.hasAttribute("data-unknown")).toBe(true);
    expect(day("2026-10-18")?.hasAttribute("data-unknown")).toBe(false);
    await expect.element(screen.getByText("Cobertura parcial en GitHub")).toBeVisible();
  });

  it("pages the evidence and opens links outside the app", async () => {
    setup();
    const onEvidencePage = vi.fn();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        evidence={DOSSIER}
        onEvidencePage={onEvidencePage}
      />,
    );
    await expect
      .element(
        screen.getByRole("heading", {
          name: "Evidencia seleccionada (10) · 9 sept 2026 – 16 oct 2026",
        }),
      )
      .toBeVisible();
    await expect.element(screen.getByText("1–6 de 10")).toBeVisible();
    await expect
      .element(screen.getByText("IBM opened its quantum stack to outside researchers."))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Siguientes" }));
    expect(onEvidencePage).toHaveBeenCalledWith(6);

    await userEvent.click(screen.getByRole("link", { name: "Quantum item 1" }));
    expect(state.opened).toEqual(["https://example.com/1"]);
  });

  it("keeps watching until growth, without a time, and creates the video thread", async () => {
    setup();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        evidence={DOSSIER}
        onEvidencePage={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Seguir observando", exact: true }));
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        ["environment-data:editorial:snooze", { trendKey: TREND_KEY }],
      ]),
    );

    await userEvent.click(screen.getByRole("button", { name: "Crear hilo de video" }));
    await vi.waitFor(() =>
      expect(state.commands.at(-1)).toEqual([
        "environment-data:editorial:create-video",
        {
          trendKey: TREND_KEY,
          runId: RUN_ID,
          dossierId: DOSSIER.trend.dossierId,
          projectId: ProjectId.make("project:studio"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
          runtimeMode: "approval-required",
        },
      ]),
    );
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/env-1/thread-video"),
    );
  });

  it("dismisses only with a reason of at least three characters", async () => {
    setup();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        evidence={DOSSIER}
        onEvidencePage={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Descartar…" }));
    const dialog = page.getByRole("dialog", { name: "Descartar tendencia" });
    await userEvent.click(dialog.getByRole("button", { name: "Descartar" }));
    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent("Escribe el motivo, al menos 3 caracteres.");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Motivo" }), "  ok ");
    await userEvent.click(dialog.getByRole("button", { name: "Descartar" }));
    await expect.element(dialog.getByRole("alert")).toBeVisible();
    expect(state.commands).toEqual([]);

    await userEvent.fill(dialog.getByRole("textbox", { name: "Motivo" }), "  Ya cubierto  ");
    await userEvent.click(dialog.getByRole("button", { name: "Descartar" }));
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        ["environment-data:editorial:dismiss", { trendKey: TREND_KEY, reason: "Ya cubierto" }],
      ]),
    );
    await expect.element(dialog).not.toBeInTheDocument();
  });

  it("offers the way back of each state and links a trend in production to its thread", async () => {
    setup();
    const withState = (patch: Partial<EditorialTrendInboxState>): EditorialTrendDossier => ({
      ...DOSSIER,
      trend: {
        ...DOSSIER.trend,
        isNew: false,
        inbox: {
          isNew: false,
          seenRunId: RUN_ID,
          seenAt: AT,
          snoozed: null,
          dismissed: null,
          production: null,
          ...patch,
        },
      },
    });
    const snoozed = withState({
      snoozed: {
        at: AT,
        until: null,
        returnWhen: { metric: "items7d", baseline: 11, atLeast: 17 },
      },
      production: { threadId: "thread-video", linkedAt: AT },
    });
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={snoozed}
        evidence={snoozed}
        onEvidencePage={() => {}}
      />,
    );
    await expect
      .element(screen.getByText("En observación: vuelve con 17 publicaciones en 7 días (hoy 11)."))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Abrir hilo de video" }))
      .toHaveAttribute("href", "/env-1/thread-video");
    await userEvent.click(screen.getByRole("button", { name: "Volver a la bandeja" }));

    const dismissed = withState({ dismissed: { at: AT, reason: "Fuera de tema" } });
    await screen.rerender(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={dismissed}
        evidence={dismissed}
        onEvidencePage={() => {}}
      />,
    );
    await expect.element(screen.getByText("Descartada: Fuera de tema")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reabrir" }));
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        ["environment-data:editorial:unsnooze", { trendKey: TREND_KEY }],
        ["environment-data:editorial:reopen", { trendKey: TREND_KEY }],
      ]),
    );
  });

  it("links only http and https evidence and falls back to a valid permalink", async () => {
    setup();
    const item = (title: string, permalink: string | null, externalUrl: string | null) => ({
      ...evidence(0),
      itemId: title,
      title,
      permalink,
      externalUrl,
    });
    const unsafe: EditorialTrendDossier = {
      ...DOSSIER,
      evidence: [
        item(
          "Javascript external",
          "https://news.ycombinator.com/item?id=1",
          'javascript:alert("x")',
        ),
        item("Data external", "http://news.ycombinator.com/item?id=2", "data:text/html,x"),
        item("File external", "https://news.ycombinator.com/item?id=3", "file:///etc/passwd"),
        item("Nothing valid", 'javascript:alert("x")', "data:text/html,x"),
        item("Http external", "https://news.ycombinator.com/item?id=5", "http://example.com/5"),
      ],
      evidenceTotal: 5,
    };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={unsafe}
        evidence={unsafe}
        onEvidencePage={() => {}}
      />,
    );
    for (const name of ["Javascript external", "Data external", "File external", "Http external"]) {
      await userEvent.click(screen.getByRole("link", { name }));
    }
    expect(state.opened).toEqual([
      "https://news.ycombinator.com/item?id=1",
      "http://news.ycombinator.com/item?id=2",
      "https://news.ycombinator.com/item?id=3",
      "http://example.com/5",
    ]);
    await expect.element(screen.getByText("Nothing valid")).toBeVisible();
    expect(
      screen.container.querySelector("a[href^='javascript:'], a[href^='data:'], a[href^='file:']"),
    ).toBeNull();
    // Only the http item has a distinct valid permalink, so only it gets a discussion link.
    await expect
      .element(screen.getByRole("link", { name: "discusión" }))
      .toHaveAttribute("href", "https://news.ycombinator.com/item?id=5");
  });

  it("shows the assistant's title and summary with citations linked to the evidence", async () => {
    setup();
    const actions: TrendPresentationActions = {
      busy: null,
      error: null,
      onDraft: vi.fn(),
      onRegenerate: vi.fn(),
    };
    const drafted: EditorialTrendDossier = {
      ...DOSSIER,
      trend: {
        ...DOSSIER.trend,
        presentation: {
          title: "IBM abre su pila de computación cuántica",
          summary: {
            whatHappened: "IBM publicó herramientas abiertas [itm_hn_2] y un SDK [itm_hn_8].",
            whyItMatters: "Toca herramientas para desarrolladores [itm_hn_1].",
            videoAngle: "Un video podría probar el SDK [itm_unknown].",
          },
          citedItemIds: ["itm_hn_2", "itm_hn_8", "itm_hn_1"],
          provider: "claudeAgent",
          model: "claude-haiku-5-5",
          promptVersion: "trend-presentation.v3",
          generatedAt: "2026-10-31T12:00:00.000Z",
        },
      },
    };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={drafted}
        evidence={drafted}
        onEvidencePage={() => {}}
        citationEvidence={[1, 2, 3, 4, 5, 6, 7, 8].map(evidence)}
        presentationActions={actions}
      />,
    );
    await expect
      .element(screen.getByRole("heading", { level: 1 }))
      .toHaveTextContent("IBM abre su pila de computación cuántica");
    await expect.element(screen.getByText("Redactado por el asistente")).toBeVisible();
    // The engine's words stay under the title.
    await expect
      .element(screen.getByText("Términos del motor: quantum computing ibm open"))
      .toBeVisible();
    await expect.element(screen.getByText("Por qué importa al canal")).toBeVisible();

    // A citation past the first evidence page still resolves to its item.
    await userEvent.click(screen.getByRole("link", { name: "Evidencia 8: Quantum item 8" }));
    await userEvent.click(screen.getByRole("link", { name: "Evidencia 2: Quantum item 2" }));
    expect(state.opened).toEqual(["https://example.com/8", "https://example.com/2"]);
    // An id the dossier does not list stays as text, never as a link.
    await expect
      .element(screen.getByText("Un video podría probar el SDK [itm_unknown]."))
      .toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Regenerar" }));
    expect(actions.onRegenerate).toHaveBeenCalledOnce();
    expect(screen.container.textContent).not.toContain("Redactar con el asistente");
  });

  it("offers drafting when there is no presentation and reports a failure in place", async () => {
    setup();
    const onDraft = vi.fn();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        evidence={DOSSIER}
        onEvidencePage={() => {}}
        presentationActions={{
          busy: null,
          error: "Text generation failed in generateTrendPresentation: quota",
          onDraft,
          onRegenerate: vi.fn(),
        }}
      />,
    );
    await expect
      .element(screen.getByRole("heading", { level: 1 }))
      .toHaveTextContent("quantum computing ibm open");
    await userEvent.click(screen.getByRole("button", { name: "Redactar con el asistente" }));
    expect(onDraft).toHaveBeenCalledOnce();
    await expect
      .element(screen.getByRole("alert").filter({ hasText: "No se pudo redactar" }))
      .toHaveTextContent(
        "No se pudo redactar: Text generation failed in generateTrendPresentation: quota",
      );
  });

  it("disables drafting while it runs", async () => {
    setup();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        evidence={DOSSIER}
        onEvidencePage={() => {}}
        presentationActions={{
          busy: "draft",
          error: null,
          onDraft: vi.fn(),
          onRegenerate: vi.fn(),
        }}
      />,
    );
    await expect.element(screen.getByRole("button", { name: /Redactando/ })).toBeDisabled();
  });

  it("marks a presentation written for an earlier input as outdated and offers to regenerate", async () => {
    setup();
    const onRegenerate = vi.fn();
    const stale: EditorialTrendDossier = {
      ...DOSSIER,
      trend: {
        ...DOSSIER.trend,
        presentation: {
          title: "IBM abre su pila de computación cuántica",
          summary: {
            whatHappened: "Pasó algo.",
            whyItMatters: "Importa.",
            videoAngle: "Un video.",
          },
          citedItemIds: [],
          provider: "claudeAgent",
          model: "claude-haiku-5-5",
          promptVersion: "trend-presentation.v2",
          generatedAt: "2026-10-31T12:00:00.000Z",
          status: "stale",
        },
      },
    };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={stale}
        evidence={stale}
        onEvidencePage={() => {}}
        presentationActions={{ busy: null, error: null, onDraft: vi.fn(), onRegenerate }}
      />,
    );
    await expect.element(screen.getByText("Desactualizado", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Redacción desactualizada")).toBeVisible();
    // The previous text stays readable until it is regenerated.
    await expect
      .element(screen.getByRole("heading", { level: 1 }))
      .toHaveTextContent("IBM abre su pila de computación cuántica");
    await userEvent.click(screen.getByRole("button", { name: "Regenerar" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });
});
