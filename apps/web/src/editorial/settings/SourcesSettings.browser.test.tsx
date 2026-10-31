import type {
  EditorialRssFeed,
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
    rankBlocked: "no-backtest",
    collectBlocked: false,
    updatedAt: null,
    lastCapture: null,
    recentGaps: [],
    ...overrides,
  }) satisfies EditorialSourceEntry;

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
    entry({ source: "bluesky", rankBlocked: "not-ready", collectBlocked: true }),
    entry({ source: "rss", rankBlocked: "not-ready" }),
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
    await expect
      .element(page.getByRole("switch", { name: "Usar Bluesky en el motor" }))
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
  });

  it("adds a feed by URL and clears the form", async () => {
    const feeds = controls();
    await using _screen = await render(
      <SourcesSettingsView view={VIEW} pending={new Set()} onChange={vi.fn()} feeds={feeds} />,
    );
    await userEvent.fill(page.getByLabelText("URL del feed"), "https://notes.example.org/atom");
    await userEvent.fill(page.getByLabelText("Nota del feed"), "Notas");
    await userEvent.click(page.getByRole("button", { name: "Agregar feed" }));
    expect(feeds.onAdd).toHaveBeenCalledWith({
      feedUrl: "https://notes.example.org/atom",
      note: "Notas",
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
});
