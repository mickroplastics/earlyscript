import type {
  EditorialRssFeed,
  EditorialSourceBacktest,
  EditorialSourceEntry,
  EditorialSourcesView,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

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
    entry({
      source: "arxiv",
      collect: true,
      lastCapture: {
        day: "2026-10-30",
        status: "unavailable",
        items: 0,
        retrievedAt: "2026-10-31T00:34:34.066Z",
        note: null,
      },
      recentGaps: [
        { day: "2026-10-28", reason: "fetch_failed" },
        { day: "2026-10-30", reason: "fetch_failed" },
      ],
    }),
    entry({
      source: "npm",
      rankBlocked: null,
      backtestRunId: BACKTEST.backtestId,
      backtest: { ...BACKTEST, status: "final" },
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
    entry({ source: "rss", collect: true }),
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

const renderView = (feeds = controls()) => {
  const onChange = vi.fn();
  return render(
    <SourcesSettingsView view={VIEW} pending={new Set()} onChange={onChange} feeds={feeds} />,
  ).then((screen) => ({ screen, onChange, feeds }));
};

const openLater = () => userEvent.click(page.getByRole("button", { name: /Todavía no cuentan/ }));
const row = (source: string): Locator => page.getByTestId(`source-${source}`);
const openRow = async (source: string, name: string | RegExp) =>
  userEvent.click(row(source).getByRole("button", { name }).first());
const openRss = async () => {
  await openLater();
  await openRow("rss", /Blogs y newsletters/);
};

describe("SourcesSettingsView", () => {
  it("locks the sources that count and folds the ones that do not, with their count", async () => {
    const { screen } = await renderView();
    await using _screen = screen;
    await expect.element(page.getByText("Tus tendencias salen de Hacker News.")).toBeVisible();
    await expect
      .element(page.getByText("Hacker News cuenta para tus tendencias; se cambia en su ficha"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("switch", { name: "Capturar Hacker News" }))
      .not.toBeInTheDocument();
    const later = page.getByRole("button", { name: /Todavía no cuentan/ });
    await expect.element(later).toMatchTextContent("· 7");
    await expect.element(later).toHaveAttribute("aria-expanded", "false");
    await expect.element(row("arxiv")).not.toBeInTheDocument();
    await openLater();
    await expect.element(row("arxiv")).toMatchTextContent("No responde · 2 fallos esta semana");
    await expect.element(row("npm")).toMatchTextContent("lista para contar");
    await expect.element(row("lobsters")).toMatchTextContent("Bloqueada");
    await expect.element(page.getByRole("switch", { name: "Capturar Lobsters" })).toBeDisabled();
  });

  it("asks before a source stops counting, and can stop its capture in the same step", async () => {
    const { screen, onChange } = await renderView();
    await using _screen = screen;
    await openRow("hn", /Hacker News/);
    await expect.element(row("hn")).toMatchTextContent("Parte del método evaluado");
    const stop = page.getByRole("button", { name: "Dejar de contar o de capturar…" });
    await userEvent.click(stop);
    await expect
      .element(page.getByRole("alertdialog"))
      .toMatchTextContent("Es parte del método evaluado.");
    await userEvent.click(page.getByRole("button", { name: "Cancelar" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(stop);
    await userEvent.click(page.getByRole("radio", { name: /Dejar de contar y de capturar/ }));
    await userEvent.click(page.getByRole("button", { name: "Dejar de contar y de capturar" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("hn", { rank: false, collect: false });
  });

  it("starts counting only a source whose test allows it, and only after confirming", async () => {
    const { screen, onChange } = await renderView();
    await using _screen = screen;
    await openLater();
    await openRow("arxiv", /arXiv/);
    await expect
      .element(row("arxiv").getByRole("button", { name: "Contar para tendencias…" }))
      .toBeDisabled();
    await expect
      .element(row("arxiv"))
      .toMatchTextContent(
        "Para contar necesita una prueba que no empeore los resultados · pendiente",
      );
    await openRow("npm", /npm/);
    await userEvent.click(row("npm").getByRole("button", { name: "Contar para tendencias…" }));
    await expect
      .element(page.getByRole("alertdialog"))
      .toMatchTextContent("Tus tendencias dejarán de salir del método evaluado.");
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: /^Contar npm/ }));
    // npm was not being captured: counting it starts its capture too.
    expect(onChange).toHaveBeenCalledExactlyOnceWith("npm", { rank: true, collect: true });
  });

  it("turns a capture on at once and asks before turning one off", async () => {
    const { screen, onChange } = await renderView();
    await using _screen = screen;
    await openLater();
    await userEvent.click(page.getByRole("switch", { name: "Capturar npm (registro)" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("npm", { collect: true });
    await userEvent.click(page.getByRole("switch", { name: "Capturar arXiv" }));
    await expect
      .element(page.getByRole("alertdialog"))
      .toMatchTextContent("los días sin captura no se recuperan");
    await userEvent.click(page.getByRole("button", { name: "Dejar de capturar" }));
    expect(onChange).toHaveBeenLastCalledWith("arxiv", { collect: false });
  });

  it("names each of the last seven days for assistive technology", async () => {
    const { screen } = await renderView();
    await using _screen = screen;
    const days = row("hn").getByRole("img");
    await expect.element(days).toHaveAttribute("tabindex", "0");
    await expect
      .element(days)
      .toHaveAccessibleName(
        "Hacker News, últimos 7 días: 24 oct: sin huecos; 25 oct: sin huecos; 26 oct: sin huecos; 27 oct: sin captura; 28 oct: sin huecos; 29 oct: sin huecos; 30 oct: sin huecos",
      );
  });

  it("unfolds the record of a source: conditions, access, retention and deletion", async () => {
    const { screen } = await renderView();
    await using _screen = screen;
    await openLater();
    await openRow("arxiv", /arXiv/);
    const record = row("arxiv");
    await expect.element(record).toMatchTextContent(/Ayer no respondió/);
    await expect
      .element(record.getByRole("link", { name: /CC0 1\.0/ }))
      .toHaveAttribute("href", "https://creativecommons.org/publicdomain/zero/1.0/");
    await expect
      .element(record.getByRole("link", { name: "Leer términos" }))
      .toHaveAttribute("href", "https://info.arxiv.org/help/api/tou.html");
    for (const text of [
      "Su robots.txt lo prohíbe; los términos de la API lo permiten",
      "Cuánto se guardaTodo lo capturado, sin plazo fijado",
      "BorrarPor autor o enlace, con un comando.",
    ]) {
      await expect.element(record).toMatchTextContent(text);
    }
    await userEvent.click(record.getByRole("button", { name: "Nota completa" }));
    await expect
      .element(record)
      .toMatchTextContent("make no more than one request every three seconds");
  });

  it("adds a feed by URL only with the acceptance, and clears the form", async () => {
    const { screen, feeds } = await renderView();
    await using _screen = screen;
    await openRss();
    await userEvent.fill(page.getByLabelText("URL del feed"), "https://notes.example.org/atom");
    await userEvent.click(page.getByRole("button", { name: "Nombre, sitio y nota (opcional)" }));
    await userEvent.fill(page.getByLabelText("URL del sitio"), "https://notes.example.org/");
    await userEvent.fill(page.getByLabelText("Nota del feed"), "Notas");
    // The acceptance is required: without it the form cannot be sent.
    await expect.element(page.getByRole("button", { name: "Probar y agregar" })).toBeDisabled();
    await userEvent.click(
      page.getByRole("checkbox", { name: /Lo uso para análisis privado, sin republicar/ }),
    );
    await userEvent.click(page.getByRole("button", { name: "Probar y agregar" }));
    expect(feeds.onAdd).toHaveBeenCalledWith({
      feedUrl: "https://notes.example.org/atom",
      siteUrl: "https://notes.example.org/",
      note: "Notas",
      acknowledged: true,
    });
    await expect.element(page.getByLabelText("URL del feed")).toHaveValue("");
  });

  it("keeps a refused URL with its reason, drops the reason once it changes and explains an invalid one", async () => {
    const { screen, feeds } = await renderView(
      controls({
        onAdd: vi.fn(async () => ({
          ok: false as const,
          message: "El robots.txt del sitio prohíbe esa ruta a Earlyscript.",
        })),
      }),
    );
    await using _screen = screen;
    await openRss();
    const url = page.getByLabelText("URL del feed");
    await userEvent.fill(url, "https://lobste.rs/rss");
    await userEvent.click(
      page.getByRole("checkbox", { name: /Lo uso para análisis privado, sin republicar/ }),
    );
    await userEvent.click(page.getByRole("button", { name: "Probar y agregar" }));
    await expect
      .element(page.getByText("El robots.txt del sitio prohíbe esa ruta a Earlyscript."))
      .toHaveAttribute("role", "alert");
    await expect.element(url).toHaveValue("https://lobste.rs/rss");
    await userEvent.fill(url, "not-a-url");
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Probar y agregar" }));
    await expect
      .element(page.getByText("«not-a-url» no es una URL válida", { exact: false }))
      .toHaveAttribute("role", "alert");
    expect(feeds.onAdd).toHaveBeenCalledTimes(1);
  });

  it("tests and removes the operator's feeds, and leaves out a default one", async () => {
    const { screen, feeds } = await renderView(
      controls({
        onTest: vi.fn(async () => ({
          ok: true as const,
          value: {
            feedUrl: "https://blog.example.com/feed.xml",
            title: "Example Engineering",
            siteUrl: null,
            entries: 12,
            latestAt: "2026-10-30T08:30:00.000Z",
            checkedAt: "2026-10-31T12:00:00.000Z",
          },
        })),
      }),
    );
    await using _screen = screen;
    await openRss();
    await userEvent.click(page.getByRole("button", { name: "Probar Example Engineering" }));
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Responde · 12 entradas, la más reciente del 30 oct 2026");
    await userEvent.click(page.getByRole("button", { name: "Quitar Example Engineering" }));
    expect(feeds.onRemove).toHaveBeenCalledWith("https://blog.example.com/feed.xml");
    await userEvent.click(page.getByRole("button", { name: /2 feeds por defecto/ }));
    await expect
      .element(page.getByRole("switch", { name: "Incluir Google DeepMind Blog" }))
      .not.toBeChecked();
    await userEvent.click(page.getByRole("switch", { name: "Incluir OpenAI News" }));
    expect(feeds.onExcludeDefault).toHaveBeenCalledWith("openai", true);
  });
});
