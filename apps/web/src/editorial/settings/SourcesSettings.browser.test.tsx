import type {
  EditorialRssFeed,
  EditorialSourceBacktest,
  EditorialSourceEntry,
  EditorialSourcesView,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import type { RssFeedControls } from "./RssFeedsSettings";
import { SourcesSettingsView } from "./SourcesSettings";

const entry = (overrides: Partial<EditorialSourceEntry> & { source: string }) =>
  ({
    collect: false,
    rank: false,
    backtestRunId: null,
    backtest: null,
    rankBlocked: "no-backtest",
    collectBlocked: null,
    updatedAt: null,
    lastCapture: null,
    recentGaps: [],
    ...overrides,
  }) satisfies EditorialSourceEntry;

const BACKTEST: EditorialSourceBacktest = {
  backtestId: "bt_270a6a39c532f096",
  logicalHash: "sha256:270a",
  experimentAt: "2026-11-01T09:30:00.000Z",
  cutoffFrom: "2026-10-17",
  cutoffTo: "2026-10-30",
  status: "provisional",
  verdict: "not-worse",
  completeCutoffs: 1,
  partialCutoffs: 13,
  p5Baseline: 0.8,
  p5Candidate: 0.8,
  leadBaseline: 1,
  leadCandidate: 1,
  partialP5Baseline: 0.784615,
  partialP5Candidate: 0.784615,
  allowProvisional: true,
  recordedAt: "2026-10-31T10:00:00.000Z",
};

const VIEW: EditorialSourcesView = {
  corpus: {
    status: "ready",
    directory: "/data/live",
    fromDay: "2026-10-03",
    toDay: "2026-10-31",
    message: null,
  },
  sources: [
    entry({
      source: "hn",
      collect: true,
      rank: true,
      rankBlocked: null,
      lastCapture: {
        day: "2026-10-30",
        status: "complete",
        items: 1021,
        retrievedAt: "2026-10-31T00:34:34.066Z",
        note: null,
      },
      recentGaps: [{ day: "2026-10-27", reason: "not_collected" }],
    }),
    entry({ source: "arxiv" }),
    entry({
      source: "npm",
      rankBlocked: null,
      backtestRunId: BACKTEST.backtestId,
      backtest: BACKTEST,
    }),
    entry({
      source: "huggingface",
      backtestRunId: "bt_efd37ff19c83baec",
      backtest: {
        ...BACKTEST,
        experimentAt: "2026-10-29T09:30:00.000Z",
        verdict: "worse",
        allowProvisional: false,
        p5Candidate: 0.6,
      },
    }),
    entry({ source: "stackexchange", rankBlocked: "not-ready", collectBlocked: "pending-review" }),
    entry({ source: "bluesky", rankBlocked: "not-ready", collectBlocked: "pending-review" }),
    entry({ source: "lobsters", rankBlocked: "not-ready", collectBlocked: "blocked" }),
    entry({ source: "rss", rankBlocked: "not-ready", collectBlocked: "pending-review" }),
  ],
  rssFeeds: [
    feed({ id: "openai", name: "OpenAI News", feedUrl: "https://openai.com/news/rss.xml" }),
    feed({
      id: "deepmind",
      name: "Google DeepMind Blog",
      feedUrl: "https://deepmind.google/blog/rss.xml",
      excluded: true,
    }),
    feed({
      id: "user-0123456789ab",
      name: "Example Engineering",
      feedUrl: "https://blog.example.com/feed.xml",
      origin: "user",
      acknowledgedAt: "2026-10-31T10:00:00.000Z",
      note: "Blog del equipo",
      addedAt: "2026-10-31T10:00:00.000Z",
    }),
  ],
  asOf: "2026-10-31T12:00:00.000Z",
};

function feed(overrides: Partial<EditorialRssFeed> & Pick<EditorialRssFeed, "id" | "name">) {
  return {
    feedUrl: "",
    siteUrl: null,
    note: null,
    origin: "default",
    acknowledgedAt: null,
    excluded: false,
    addedAt: null,
    ...overrides,
  } satisfies EditorialRssFeed;
}

const controls = (overrides: Partial<RssFeedControls> = {}): RssFeedControls => ({
  onExcludeDefault: vi.fn(),
  onAdd: vi.fn(async () => ({ ok: true as const, value: undefined })),
  onRemove: vi.fn(),
  onTest: vi.fn(async () => ({ ok: false as const, message: "El feed no responde." })),
  ...overrides,
});

describe("SourcesSettingsView", () => {
  it("writes the capture switch of a source", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <SourcesSettingsView
        view={VIEW}
        pending={new Set()}
        onChange={onChange}
        feeds={controls()}
      />,
    );
    await expect
      .element(page.getByText("Última captura: 30 oct 2026, completa", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText("27 oct (sin capturar)", { exact: false })).toBeVisible();
    await userEvent.click(page.getByRole("switch", { name: "Capturar arXiv" }));
    expect(onChange).toHaveBeenCalledWith("arxiv", { collect: true });
  });

  it("shows the recorded backtest: date, cutoffs, P@5, lead, verdict and provisional state", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <SourcesSettingsView
        view={VIEW}
        pending={new Set()}
        onChange={onChange}
        feeds={controls()}
      />,
    );
    const npm = page.getByRole("switch", { name: "Usar npm (registro) en el motor" });
    await expect.element(npm).toBeEnabled();
    await expect.element(npm).toHaveAccessibleDescription(/^Puede entrar al motor/);
    await expect
      .element(page.getByText("Backtest del 1 nov 2026, cortes del 17 oct al 30 oct: no empeora."))
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "P@5 0,8 sin la fuente y 0,8 con ella; anticipación mediana 1 d y 1 d. Sobre 1 corte completo; aparte, 13 cortes parciales con P@5 0,78 y 0,78.",
        ),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Resultado provisional: seguimiento incompleto. Registrado a sabiendas por el operador.",
        ),
      )
      .toBeVisible();

    // A worse backtest is shown, and keeps the source out of the engine.
    const hf = page.getByRole("switch", { name: "Usar Hugging Face Hub en el motor" });
    await expect.element(hf).toBeDisabled();
    await expect.element(hf).toHaveAccessibleDescription(/^No entra al motor: su backtest empeora/);
    await expect
      .element(page.getByText("Backtest del 29 oct 2026, cortes del 17 oct al 30 oct: empeora."))
      .toBeVisible();
    await expect
      .element(
        page.getByText("Resultado provisional: seguimiento incompleto. No habilita el motor."),
      )
      .toBeVisible();
    await userEvent.click(npm);
    expect(onChange).toHaveBeenCalledWith("npm", { rank: true });
  });

  it("keeps the engine switch off and says why until a backtest is recorded", async () => {
    const onChange = vi.fn();
    await using _screen = await render(
      <SourcesSettingsView
        view={VIEW}
        pending={new Set()}
        onChange={onChange}
        feeds={controls()}
      />,
    );
    const engine = page.getByRole("switch", { name: "Usar arXiv en el motor" });
    await expect.element(engine).toBeDisabled();
    await expect.element(engine).toHaveAccessibleDescription(/Pendiente de backtest/);
    await expect
      .element(page.getByRole("switch", { name: "Usar Hacker News en el motor" }))
      .toBeEnabled();
    await expect.element(page.getByRole("switch", { name: "Capturar Bluesky" })).toBeDisabled();
    const unread = page.getByRole("switch", { name: "Capturar Stack Exchange" });
    await expect.element(unread).toBeDisabled();
    await expect.element(unread).toHaveAccessibleDescription(/^Pendiente de leer sus términos/);
    await expect
      .element(page.getByRole("switch", { name: "Usar Lobsters en el motor" }))
      .toHaveAccessibleDescription(/Bloqueada por sus condiciones de uso/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("unfolds the governance record of a source", async () => {
    await using screen = await render(
      <SourcesSettingsView view={VIEW} pending={new Set()} onChange={vi.fn()} feeds={controls()} />,
    );
    const arxiv = screen.container.querySelector("#editorial-source-arxiv")!;
    const license = page.getByRole("link", { name: /CC0 1\.0/ });
    await expect.element(license).not.toBeInTheDocument();
    await userEvent.click(
      page.elementLocator(arxiv).getByRole("button", { name: "Ficha de la fuente" }),
    );
    await expect
      .element(license)
      .toHaveAttribute("href", "https://creativecommons.org/publicdomain/zero/1.0/");
    await expect
      .element(page.getByRole("link", { name: "Leer términos" }))
      .toHaveAttribute("href", "https://info.arxiv.org/help/api/tou.html");
    await expect.element(page.getByText("31 oct 2026", { exact: false })).toBeVisible();
    // arXiv's documented exception to robots.txt, with the terms it quotes.
    await expect
      .element(page.getByRole("link", { name: "Términos de la API" }))
      .toHaveAttribute("href", "https://info.arxiv.org/help/api/tou.html");
    await expect
      .element(
        page.getByText("make no more than one request every three seconds", { exact: false }),
      )
      .toBeVisible();
  });

  it("adds a feed by URL and clears the form", async () => {
    const feeds = controls();
    await using _screen = await render(
      <SourcesSettingsView view={VIEW} pending={new Set()} onChange={vi.fn()} feeds={feeds} />,
    );
    await userEvent.fill(page.getByLabelText("URL del feed"), "https://notes.example.org/atom");
    await userEvent.fill(page.getByLabelText("URL del sitio"), "https://notes.example.org/");
    await userEvent.fill(page.getByLabelText("Nota del feed"), "Notas");
    // The acceptance is required: without it the form cannot be sent.
    await expect.element(page.getByRole("button", { name: "Agregar feed" })).toBeDisabled();
    await userEvent.click(
      page.getByRole("checkbox", { name: /Uso para análisis privado, sin republicar/ }),
    );
    await userEvent.click(page.getByRole("button", { name: "Agregar feed" }));
    expect(feeds.onAdd).toHaveBeenCalledWith({
      feedUrl: "https://notes.example.org/atom",
      siteUrl: "https://notes.example.org/",
      note: "Notas",
      acknowledged: true,
    });
    await expect.element(page.getByLabelText("URL del feed")).toHaveValue("");
  });

  it("shows why a feed was refused and keeps what the operator typed", async () => {
    const feeds = controls({
      onAdd: vi.fn(async () => ({
        ok: false as const,
        message: "El robots.txt del sitio prohíbe esa ruta a Earlyscript.",
      })),
    });
    await using _screen = await render(
      <SourcesSettingsView view={VIEW} pending={new Set()} onChange={vi.fn()} feeds={feeds} />,
    );
    await userEvent.fill(page.getByLabelText("URL del feed"), "https://lobste.rs/rss");
    await userEvent.click(
      page.getByRole("checkbox", { name: /Uso para análisis privado, sin republicar/ }),
    );
    await userEvent.click(page.getByRole("button", { name: "Agregar feed" }));
    await expect
      .element(page.getByText("El robots.txt del sitio prohíbe esa ruta a Earlyscript."))
      .toHaveAttribute("role", "alert");
    await expect.element(page.getByLabelText("URL del feed")).toHaveValue("https://lobste.rs/rss");
  });

  it("removes and tests the operator's feeds, and excludes a default one", async () => {
    const feeds = controls({
      onTest: vi.fn(async () => ({
        ok: true as const,
        value: {
          feedUrl: "https://blog.example.com/feed.xml",
          format: "rss" as const,
          title: "Example Engineering",
          siteUrl: null,
          entries: 12,
          latestAt: "2026-10-30T08:30:00.000Z",
          checkedAt: "2026-10-31T12:00:00.000Z",
        },
      })),
    });
    await using _screen = await render(
      <SourcesSettingsView view={VIEW} pending={new Set()} onChange={vi.fn()} feeds={feeds} />,
    );
    await userEvent.click(page.getByRole("button", { name: "Probar Example Engineering" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("12 entradas, la más reciente del 30 oct 2026.");
    await userEvent.click(page.getByRole("button", { name: "Quitar Example Engineering" }));
    expect(feeds.onRemove).toHaveBeenCalledWith("https://blog.example.com/feed.xml");

    await userEvent.click(page.getByRole("button", { name: /Feeds por defecto \(1 de 2/ }));
    await expect
      .element(page.getByRole("switch", { name: "Incluir Google DeepMind Blog" }))
      .not.toBeChecked();
    await userEvent.click(page.getByRole("switch", { name: "Incluir OpenAI News" }));
    expect(feeds.onExcludeDefault).toHaveBeenCalledWith("openai", true);
  });

  it("drops a refusal once the URL changes and explains an invalid one in Spanish", async () => {
    const feeds = controls({
      onAdd: vi.fn(async () => ({
        ok: false as const,
        message: "El robots.txt del sitio prohíbe esa ruta a Earlyscript.",
      })),
    });
    await using _screen = await render(
      <SourcesSettingsView view={VIEW} pending={new Set()} onChange={vi.fn()} feeds={feeds} />,
    );
    const url = page.getByLabelText("URL del feed");
    await userEvent.fill(url, "https://lobste.rs/rss");
    await userEvent.click(
      page.getByRole("checkbox", { name: /Uso para análisis privado, sin republicar/ }),
    );
    await userEvent.click(page.getByRole("button", { name: "Agregar feed" }));
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    await userEvent.fill(url, "not-a-url");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Agregar feed" }));
    await expect
      .element(page.getByText("«not-a-url» no es una URL válida", { exact: false }))
      .toHaveAttribute("role", "alert");
    expect(feeds.onAdd).toHaveBeenCalledTimes(1);
  });
});
