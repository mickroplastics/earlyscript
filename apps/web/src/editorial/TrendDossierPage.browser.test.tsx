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
import { SidebarMenu, SidebarProvider } from "../components/ui/sidebar";
import {
  TrendDossierScreen,
  TrendDossierView,
  type TrendPresentationActions,
} from "./TrendDossierPage";
import { TrendInboxRow } from "./TrendInboxRow";
import { NO_MODEL_DESCRIPTION } from "./videoThreadTarget";

const STUDIO_TARGET = {
  projectId: "project:studio",
  modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
  runtimeMode: "approval-required",
} as const;
const state = vi.hoisted(() => ({
  opened: [] as string[],
  commands: [] as Array<readonly [string, unknown]>,
  toasts: [] as Array<{
    readonly title?: unknown;
    readonly description?: unknown;
    readonly actionProps?: { readonly children?: unknown };
  }>,
  // The client's target for a video thread; set per test, `null` when no model can run it.
  target: null as object | null,
}));
vi.mock("../components/ui/toast", async (original) => {
  const actual = await original<typeof import("../components/ui/toast")>();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: (toast: (typeof state.toasts)[number]) => {
        state.toasts.push(toast);
        return "toast";
      },
    },
  };
});
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
vi.mock("./videoThreadTarget", async (original) => ({
  ...(await original<typeof import("./videoThreadTarget")>()),
  resolveVideoThreadTarget: () => state.target,
}));

function setup(target: object | null = STUDIO_TARGET) {
  state.opened = [];
  state.commands = [];
  state.toasts = [];
  state.target = target;
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

const CARD: NonNullable<EditorialTrendDossier["trend"]["card"]> = {
  origin: "v3",
  section: "moving",
  position: 1,
  movement: "weak",
  since: "2026-10-15",
  perennial: false,
  curve: [
    { source: "hn", status: "comparable", weeks: [1, 3, 0, 5] },
    { source: "github", status: "comparable", weeks: [0, 0, null, 2] },
    { source: "npm", status: "comparable", weeks: [0, 0, 0, 0] },
    { source: "wikipedia", status: "unused", weeks: [] },
  ],
  sourceCount: 2,
  firstSource: { source: "hn", day: "2026-09-09" },
  secondSource: { source: "github", day: "2026-10-16" },
  fit: { topic: "AI coding agents and agent harnesses for developers", terms: ["agent"] },
  saturated: false,
  headlines: [
    {
      itemId: "itm_hn_1",
      source: "hn",
      title: "Quantum item 1",
      day: "2026-10-15",
      url: "https://example.com/1",
    },
  ],
  evidence: [
    {
      itemId: "itm_hn_1",
      source: "hn",
      title: "Quantum item 1",
      day: "2026-10-15",
      url: "https://example.com/1",
      alsoIn: ["rss"],
    },
    {
      itemId: "itm_gh_2",
      source: "github",
      title: "ibm/qiskit-next",
      day: "2026-10-16",
      url: "https://github.com/ibm/qiskit-next",
    },
  ],
  incompleteSources: ["github"],
  decision: null,
  priorDecision: null,
};

/** The quantum dossier with a stored story the dossier no longer draws. */
const outdatedDossier = (stored: {
  readonly title: string;
  readonly titleRejected?: boolean;
}): EditorialTrendDossier => ({
  ...DOSSIER,
  trend: {
    ...DOSSIER.trend,
    card: CARD,
    presentation: {
      title: stored.title,
      summary: {
        whatHappened: "En los últimos 7 días el motor registró 11 elementos.",
        whyItMatters: "Importa.",
        videoAngle: "Un video.",
      },
      citedItemIds: [],
      provider: "claudeAgent",
      model: "claude-haiku-5-5",
      promptVersion: "trend-presentation.v3",
      generatedAt: "2026-10-31T12:00:00.000Z",
      status: "outdated",
      ...(stored.titleRejected ? { titleRejected: true } : {}),
    },
  },
});

describe("TrendDossierView", () => {
  it("shows movement with weekly values and keeps ranks and scores off screen", async () => {
    setup();
    const withCard: EditorialTrendDossier = {
      ...DOSSIER,
      coverage: [
        ...DOSSIER.coverage,
        { source: "npm", windowDays: 28, daysComplete: 7, daysPartial: 21, daysUnavailable: 0 },
      ],
      trend: { ...DOSSIER.trend, card: CARD },
    };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={withCard}
        onEvidencePage={() => {}}
      />,
    );
    await expect.element(screen.getByText("Señal débil", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("desde hace 4 días")).toBeVisible();
    // Without a summary, the latest headlines stand in for it.
    await expect.element(screen.getByText("Titulares recientes")).toBeVisible();
    const chart = screen.getByRole("img", { name: /^Publicaciones por semana/ });
    await expect
      .element(chart)
      .toHaveAccessibleName(
        "Publicaciones por semana. Hacker News: 1, 3, 0 y 5; GitHub: 0, 0, sin captura y 2, de la semana del 21 a 27 sept a la del 12 a 18 oct.",
      );
    // An uncaptured week is a "?", never a zero.
    expect(chart.element().textContent).toContain("?sin captura");
    // One sentence for a quiet source whose capture was partial, never two that contradict.
    expect(screen.container.textContent).toContain(
      "npm sin publicaciones registradas, pero con captura parcial.",
    );
    expect(screen.container.textContent).not.toContain("Sin publicaciones en npm");
    // GitHub has bars, but its daily capture was partial: said next to the figure.
    await expect
      .element(
        screen.getByRole("button", { name: /^Captura diaria incompleta\W+Días.*quedarse cortas/ }),
      )
      .toBeVisible();
    expect(screen.container.textContent).toContain("cortas.: GitHub 0 de 28 días.");
    expect(screen.container.textContent).not.toContain("Cobertura incompleta en GitHub");
    // The third week has no total: GitHub did not capture it.
    expect(screen.container.textContent).toContain("7en la última semana");
    // The days each source captured stay one click away, with the unused source.
    await userEvent.click(screen.getByRole("button", { name: "Semanas por fuente" }));
    await expect.element(screen.getByText("7 de 28 · 21 parciales")).toBeVisible();
    await expect.element(screen.getByText("se captura pero no se agrupa")).toBeVisible();
    await expect
      .element(screen.getByText("Tema del perfil: AI coding agents · términos: agent"))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Procedencia y detalles técnicos" }));
    await expect
      .element(screen.getByText("Hacker News · 9 sept 2026 (hace 40 días)"))
      .toBeVisible();
    const text = screen.container.textContent ?? "";
    for (const removed of [
      "Por puntaje",
      "Por volumen",
      "Afinidad con el canal",
      "#13",
      "Por qué está aquí",
      "Cobertura por fuente",
    ]) {
      expect(text).not.toContain(removed);
    }
    expect(text).not.toMatch(/motor/i);
  });

  it("shows three evidence items, then all of them, and opens links outside the app", async () => {
    setup();
    const onShowAllEvidence = vi.fn();
    const all: EditorialTrendDossier = {
      ...DOSSIER,
      evidence: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(evidence),
    };
    const withCard: EditorialTrendDossier = { ...DOSSIER, trend: { ...DOSSIER.trend, card: CARD } };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={withCard}
        allEvidence={all}
        onShowAllEvidence={onShowAllEvidence}
        onEvidencePage={() => {}}
      />,
    );
    const evidenceList = screen.getByRole("region", { name: /^Lee la evidencia/ });
    await expect.element(evidenceList.getByText("9 sept a 16 oct 2026")).toBeVisible();
    const rows = () => evidenceList.element().querySelectorAll("[data-evidence-number]");
    expect(rows()).toHaveLength(3);
    await expect
      .element(screen.getByText("IBM opened its quantum stack to outside researchers."))
      .toBeVisible();
    await expect.element(evidenceList.getByText(/también en RSS/)).toBeVisible();
    // The item id is in the row for hover and focus, without taking room.
    expect(evidenceList.element().textContent).toContain("itm_hn_1");

    await userEvent.click(screen.getByRole("button", { name: "Ver toda la evidencia (10)" }));
    expect(onShowAllEvidence).toHaveBeenCalledOnce();
    await expect.element(screen.getByRole("link", { name: "Quantum item 10" })).toBeVisible();
    expect(rows()).toHaveLength(10);
    await userEvent.click(screen.getByRole("button", { name: "Mostrar solo tres" }));
    expect(rows()).toHaveLength(3);

    await userEvent.click(evidenceList.getByRole("link", { name: "Quantum item 1" }));
    expect(state.opened).toEqual(["https://example.com/1"]);
  });

  it("keeps watching until growth, without a time, and creates the video thread", async () => {
    setup();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
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

  it("creates the video thread of an install with no project, leaving the project to the server", async () => {
    const { projectId: _none, ...withoutProject } = STUDIO_TARGET;
    setup(withoutProject);
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        onEvidencePage={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Crear hilo de video" }));
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        [
          "environment-data:editorial:create-video",
          {
            trendKey: TREND_KEY,
            runId: RUN_ID,
            dossierId: DOSSIER.trend.dossierId,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
            runtimeMode: "approval-required",
          },
        ],
      ]),
    );
    await vi.waitFor(() =>
      expect(screen.router?.state.location.pathname).toBe("/env-1/thread-video"),
    );
    expect(state.toasts).toEqual([]);
  });

  it("says where to connect a model when none can run the assisted thread", async () => {
    setup(null);
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
        onEvidencePage={() => {}}
      />,
    );
    const create = screen.getByRole("button", { name: "Crear hilo de video" });
    await userEvent.click(create);
    await vi.waitFor(() =>
      expect(state.toasts).toEqual([
        expect.objectContaining({
          title: "No se pudo crear el hilo de video",
          description: NO_MODEL_DESCRIPTION,
          actionProps: expect.objectContaining({ children: "Abrir Proveedores" }),
        }),
      ]),
    );
    expect(state.commands).toEqual([]);
    // The button comes back for a second try once a provider is connected.
    await expect.element(create).toBeEnabled();
  });

  it("dismisses only with a reason of at least three characters", async () => {
    setup();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={DOSSIER}
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

  it("prepares the thread's folder when «Abrir hilo de video» opens it", async () => {
    setup();
    const inProduction: EditorialTrendDossier = {
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
          production: { threadId: "thread-video", linkedAt: AT },
        },
      },
    };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={inProduction}
        onEvidencePage={() => {}}
      />,
    );
    // The thread's subscription may be alive from an earlier visit; the link asks anyway.
    await userEvent.click(screen.getByRole("link", { name: "Abrir hilo de video" }));
    expect(state.commands).toContainEqual([
      "environment-data:editorial:video-prepare",
      { threadId: "thread-video" },
    ]);
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

    const trial = withState({ trial: { threadId: "thread-trial", linkedAt: AT } });
    await screen.rerender(
      <TrendDossierView environmentId={ENVIRONMENT_ID} dossier={trial} onEvidencePage={() => {}} />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Crear hilo de video", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Abrir hilo de video" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("link", { name: "Ver el ensayo" }))
      .toHaveAttribute("href", "/env-1/thread-trial");

    const dismissed = withState({ dismissed: { at: AT, reason: "Fuera de tema" } });
    await screen.rerender(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={dismissed}
        onEvidencePage={() => {}}
      />,
    );
    await expect.element(screen.getByText("Descartada el 31 oct 2026")).toBeVisible();
    await expect.element(screen.getByText("«Fuera de tema»")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reabrir" }));
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        ["environment-data:editorial:unsnooze", { trendKey: TREND_KEY }],
        ["environment-data:editorial:reopen", { trendKey: TREND_KEY }],
      ]),
    );
    // Dismissing does not hide the way to a thread.
    await expect.element(screen.getByRole("button", { name: "Crear hilo de video" })).toBeVisible();

    const decided: EditorialTrendDossier = {
      ...DOSSIER,
      trend: {
        ...DOSSIER.trend,
        card: {
          ...CARD,
          decision: {
            threadId: "thread-decided",
            action: "edit",
            utility: 4,
            reason: "me interesa",
            decidedAt: AT,
          },
        },
      },
    };
    await screen.rerender(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={decided}
        onEvidencePage={() => {}}
      />,
    );
    await expect.element(screen.getByText("Editado · utilidad 4 de 5")).toBeVisible();
    await expect.element(screen.getByText("Tu decisión · 31 oct 2026")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Abrir hilo de video" }))
      .toHaveAttribute("href", "/env-1/thread-decided");
    // The other exits stay reachable once decided.
    for (const name of ["Seguir observando", "Descartar…", "Crear hilo manual"]) {
      await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
    }
  });

  it("links only http and https evidence and falls back to a valid permalink", async () => {
    setup();
    const item = (title: string, permalink: string | null, externalUrl: string | null) => ({
      ...evidence(0),
      itemId: `itm_${title.replaceAll(" ", "_")}`,
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
        allEvidence={unsafe}
        onEvidencePage={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Ver toda la evidencia (5)" }));
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
        onEvidencePage={() => {}}
        citationEvidence={[1, 2, 3, 4, 5, 6, 7, 8].map(evidence)}
        presentationActions={actions}
      />,
    );
    await expect
      .element(screen.getByRole("heading", { level: 1 }))
      .toHaveTextContent("IBM abre su pila de computación cuántica");
    await expect.element(screen.getByText("Redactado por el asistente")).toBeVisible();
    const fit = screen.getByRole("region", { name: "Encaje con el canal" }).getByRole("paragraph");
    await expect.element(fit).toHaveTextContent("Toca herramientas para desarrolladores1.");
    // The last word, the citation and the period wrap as one piece.
    expect(
      fit.getByRole("link", { name: /^Evidencia 1:/ }).element().parentElement?.textContent,
    ).toBe("desarrolladores1.");
    await expect.element(screen.getByText(/^Modelo: claude-haiku-5-5/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Procedencia y detalles técnicos" }));
    await expect
      .element(screen.getByText(/^Modelo: claude-haiku-5-5 · prompt trend-presentation\.v3/))
      .toBeVisible();
    await expect.element(screen.getByText("quantum computing ibm open")).toBeVisible();
    expect(screen.container.textContent).not.toMatch(/motor/i);

    // The citation's tooltip names its item id.
    await userEvent.hover(screen.getByRole("link", { name: "Evidencia 8: Quantum item 8" }));
    await expect.element(page.getByText("itm_hn_8", { exact: true })).toBeVisible();

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
        onEvidencePage={() => {}}
        presentationActions={{ busy: null, error: null, onDraft: vi.fn(), onRegenerate }}
      />,
    );
    await expect.element(screen.getByText("Redacción desactualizada")).toBeVisible();
    // The previous text stays readable until it is regenerated.
    await expect
      .element(screen.getByRole("heading", { level: 1 }))
      .toHaveTextContent("IBM abre su pila de computación cuántica");
    await userEvent.click(screen.getByRole("button", { name: "Regenerar" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });
  it("never turns weeks nobody captured into zero publications", async () => {
    setup();
    const uncaptured: EditorialTrendDossier = {
      ...DOSSIER,
      trend: {
        ...DOSSIER.trend,
        card: {
          ...CARD,
          curve: [
            { source: "hn", status: "comparable", weeks: [1, 2, 3, 4] },
            { source: "github", status: "partial", weeks: [0, null, 0, null] },
            { source: "npm", status: "comparable", weeks: [0, 0, 0, 0] },
          ],
          incompleteSources: [],
        },
      },
    };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={uncaptured}
        onEvidencePage={() => {}}
      />,
    );
    await expect.element(screen.getByText("Última semana sin captura completa")).toBeVisible();
    expect(screen.container.textContent).toContain(
      "Sin publicaciones en npm. Sin captura completa en GitHub: no se sabe si tuvo publicaciones.",
    );
    // Without a total next to it, the lone series still says whose bars these are.
    await expect.element(screen.getByText("Hacker News", { exact: true })).toBeVisible();
    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("Sin publicaciones en GitHub");
    expect(text).not.toContain("en la última semana");
    expect(text).not.toContain(", en Hacker News");
  });

  it("keeps earlier decisions and every thread reachable whatever the state", async () => {
    setup();
    const PRIOR = {
      threadId: "thread-prior",
      action: "accept" as const,
      utility: 5,
      reason: "buen tema",
      decidedAt: "2026-09-30T10:00:00.000Z",
    };
    const DECISION = {
      threadId: "thread-decided",
      action: "edit" as const,
      utility: 4,
      reason: "me interesa",
      decidedAt: AT,
    };
    const withDecisions = (
      decisions: Pick<typeof CARD, "decision" | "priorDecision">,
      patch: Partial<EditorialTrendInboxState>,
    ): EditorialTrendDossier => ({
      ...DOSSIER,
      trend: {
        ...DOSSIER.trend,
        isNew: false,
        card: { ...CARD, ...decisions },
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
    const decisionPanel = () => screen.getByRole("region", { name: "Decisión" });

    // A topic decided in another thread, now in production in a new one.
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={withDecisions(
          { decision: null, priorDecision: PRIOR },
          { production: { threadId: "thread-video", linkedAt: AT } },
        )}
        onEvidencePage={() => {}}
      />,
    );
    await expect
      .element(
        decisionPanel().getByText("Antes lo decidiste el 30 sept 2026: aceptado · utilidad 5 de 5"),
      )
      .toBeVisible();
    await expect.element(decisionPanel().getByText("· «buen tema»")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Abrir ese hilo" }))
      .toHaveAttribute("href", "/env-1/thread-prior");
    await expect
      .element(screen.getByRole("link", { name: "Abrir hilo de video" }))
      .toHaveAttribute("href", "/env-1/thread-video");

    // Decided in one thread, produced in another: both, each by its name.
    await screen.rerender(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={withDecisions(
          { decision: DECISION, priorDecision: null },
          { production: { threadId: "thread-video", linkedAt: AT } },
        )}
        onEvidencePage={() => {}}
      />,
    );
    await expect
      .element(screen.getByRole("link", { name: "Abrir hilo decidido" }))
      .toHaveAttribute("href", "/env-1/thread-decided");
    await userEvent.click(screen.getByRole("link", { name: "Abrir hilo en producción" }));
    expect(state.commands).toContainEqual([
      "environment-data:editorial:video-prepare",
      { threadId: "thread-video" },
    ]);

    // Dismissing a decided trend keeps the decision, its reason and its thread.
    await screen.rerender(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={withDecisions(
          { decision: DECISION, priorDecision: PRIOR },
          { dismissed: { at: AT, reason: "Fuera de tema" } },
        )}
        onEvidencePage={() => {}}
      />,
    );
    await expect.element(screen.getByText("Descartada el 31 oct 2026")).toBeVisible();
    await expect
      .element(decisionPanel().getByText("Tu decisión del 31 oct 2026: editado · utilidad 4 de 5"))
      .toBeVisible();
    await expect.element(decisionPanel().getByText("· «me interesa»")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Abrir hilo decidido" }))
      .toHaveAttribute("href", "/env-1/thread-decided");
    await expect
      .element(screen.getByRole("link", { name: "Abrir ese hilo" }))
      .toHaveAttribute("href", "/env-1/thread-prior");
  });

  it("draws no story written with an older prompt and offers to draft it again", async () => {
    setup();
    const onRegenerate = vi.fn();
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={outdatedDossier({ title: "Once autores hablan de computación cuántica" })}
        onEvidencePage={() => {}}
        presentationActions={{ busy: null, error: null, onDraft: vi.fn(), onRegenerate }}
      />,
    );
    await expect
      .element(
        screen.getByText(
          "El resumen guardado no cumple las reglas actuales de redacción; vuelve a redactarlo.",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText("Resumen desactualizado")).toBeVisible();
    await expect.element(screen.getByText("Titulares recientes")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Procedencia y detalles técnicos" }));
    const text = screen.container.textContent ?? "";
    expect(text).not.toMatch(/motor/i);
    expect(text).not.toContain("trend-presentation.v3");
    await userEvent.click(screen.getByRole("button", { name: "Redactar con el asistente" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });

  it.each([
    // A title that passes today's voice rules names the trend everywhere, marked outdated.
    ["IBM abre su pila de computación cuántica", false, "IBM abre su pila de computación cuántica"],
    // A rejected one shows nowhere: every surface uses the engine's terms.
    ["El motor registró once titulares", true, "quantum computing ibm open"],
  ])(
    "names an outdated story «%s» the same in the row, header, breadcrumb and dismiss dialog",
    async (stored, titleRejected, expected) => {
      setup();
      const dossier = outdatedDossier({ title: stored, titleRejected });
      {
        await using inbox = await render(
          <SidebarProvider defaultOpen>
            <SidebarMenu>
              <TrendInboxRow environmentId={ENVIRONMENT_ID} trend={dossier.trend} isActive />
            </SidebarMenu>
          </SidebarProvider>,
        );
        const row = inbox.getByRole("link", { name: /Redacción desactualizada/ });
        expect(row.element().textContent).toContain(expected);
        if (titleRejected) expect(row.element().textContent).not.toContain(stored);
      }
      await using screen = await render(
        <SidebarProvider defaultOpen>
          <TrendDossierScreen
            environmentId={ENVIRONMENT_ID}
            dossier={dossier}
            onEvidencePage={() => {}}
          />
        </SidebarProvider>,
      );
      await expect.element(screen.getByRole("heading", { level: 1 })).toHaveTextContent(expected);
      await expect
        .element(screen.getByRole("navigation", { name: "Ruta en Tendencias" }))
        .toHaveTextContent(`Tendencias/${expected}`);
      await userEvent.click(screen.getByRole("button", { name: "Descartar…" }));
      const dialog = page.getByRole("dialog", { name: "Descartar tendencia" });
      await expect.element(dialog).toBeVisible();
      expect(dialog.element().textContent).toContain(`«${expected}» pasa a Descartadas`);
      if (titleRejected) expect(document.body.textContent).not.toContain(stored);
    },
  );

  it("explains the partial history and the recurring topic from the keyboard", async () => {
    setup();
    const marked: EditorialTrendDossier = {
      ...DOSSIER,
      trend: {
        ...DOSSIER.trend,
        card: {
          ...CARD,
          perennial: true,
          curve: [
            { source: "hn", status: "comparable", weeks: [1, 3, 0, 5] },
            { source: "rss", status: "partial", weeks: [0, 1, 2, 2] },
          ],
        },
      },
    };
    await using screen = await render(
      <TrendDossierView
        environmentId={ENVIRONMENT_ID}
        dossier={marked}
        onEvidencePage={() => {}}
      />,
    );
    const recurring = screen.getByRole("button", {
      name: /^tema recurrente\W+Tuvo actividad varias semanas antes de este movimiento\.$/,
    });
    await expect.element(recurring).toBeVisible();
    const partial = screen.getByRole("button", {
      name: /^parcial\W+Esta fuente aún no tiene las 5 semanas de historia/,
    });
    await expect.element(partial).toBeVisible();
    // Tab reaches them: native buttons in the focus order, not pointer-only spans.
    for (const mark of [recurring, partial]) {
      expect(mark.element().tagName).toBe("BUTTON");
      expect((mark.element() as HTMLButtonElement).tabIndex).toBe(0);
    }
  });
});
