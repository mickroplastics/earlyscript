import type { EditorialSourceEntry, EditorialSourcesView } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Dialog, DialogPopup, DialogTitle } from "../../components/ui/dialog";
import { COMMON_STORED_LINE, DATA_CONSENT_POLICY, policyHash } from "./dataConsent.logic";
import {
  DATA_OUTBOUND,
  OTHER_OUTBOUND,
  OTHER_OUTBOUND_PREFIX,
  otherOutboundItem,
  otherOutboundLine,
} from "./dataOutbound";
import { DataHandlingDialog } from "./DataHandlingDialog";
import { DataConsentView, type DataConsentViewProps } from "./DataConsentStep";

// Screenshots for review: VITE_EARLYSCRIPT_SHOTS=1 writes them to the git-ignored
// __screenshots__/data-consent/ next to this file; without it the test only asserts.
const SHOTS = import.meta.env.VITE_EARLYSCRIPT_SHOTS === "1";
async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: `__screenshots__/data-consent/${name}.png` });
}

/** The viewport for one test; back to the desktop size on dispose. */
async function viewport(width: number, height: number): Promise<AsyncDisposable> {
  await page.viewport(width, height);
  return { [Symbol.asyncDispose]: () => page.viewport(1280, 800) };
}

/** The dark theme for one test. */
function darkTheme(): Disposable {
  document.documentElement.classList.add("dark");
  return { [Symbol.dispose]: () => document.documentElement.classList.remove("dark") };
}

const entry = (source: string, overrides: Partial<EditorialSourceEntry> = {}) =>
  ({
    source,
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

// What a fresh install answers: no corpus yet, the catalog's ten sources with their defaults.
const FIRST_RUN: EditorialSourcesView = {
  corpus: {
    status: "missing",
    directory: "/home/operador/earlyscript-data/live",
    fromDay: null,
    toDay: null,
    message: null,
  },
  sources: [
    entry("hn", { collect: true, rank: true, rankBlocked: null }),
    entry("github", { collect: true, rank: true, rankBlocked: null }),
    entry("arxiv"),
    entry("wikipedia"),
    entry("npm"),
    entry("stackexchange", { rankBlocked: "not-ready", collectBlocked: "pending-review" }),
    entry("bluesky", { rankBlocked: "not-ready", collectBlocked: "pending-review" }),
    entry("huggingface"),
    entry("lobsters", { rankBlocked: "not-ready", collectBlocked: "blocked" }),
    entry("rss"),
  ],
  rssFeeds: Array.from({ length: 14 }, (_, index) => ({
    id: `feed-${index}`,
    name: `Feed ${index}`,
    feedUrl: `https://example.com/${index}.xml`,
    siteUrl: null,
    note: null,
    origin: "default" as const,
    acknowledgedAt: null,
    excluded: false,
    addedAt: null,
  })),
  asOf: "2026-11-02T12:00:00.000Z",
};

/** The step inside a dialog of the wizard's size, as the shell mounts it. */
function InWizard({ children }: { readonly children: ReactNode }) {
  return (
    <Dialog open disablePointerDismissal>
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="h-[min(48.25rem,calc(100dvh-2rem))] w-[min(62.5rem,calc(100vw-2rem))] max-w-none overflow-hidden"
      >
        <DialogTitle className="sr-only">Configurar Earlyscript</DialogTitle>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </DialogPopup>
    </Dialog>
  );
}

const props = (overrides: Partial<DataConsentViewProps> = {}): DataConsentViewProps => ({
  view: FIRST_RUN,
  loadError: null,
  onRetry: vi.fn(),
  save: vi.fn(async () => null),
  onBack: null,
  onContinue: vi.fn(),
  ...overrides,
});

const acceptBox = () => page.getByRole("checkbox", { name: DATA_CONSENT_POLICY.accept });
const continueButton = () => page.getByRole("button", { name: "Aceptar y continuar" });
const openDetail = () =>
  userEvent.click(page.getByRole("button", { name: "Ver cada conexión, conservación y borrado" }));

describe("DataConsentStep", () => {
  it("summarises what leaves in three lines and folds the accepted wording, the dialog's list included", async () => {
    await using _viewport = await viewport(1440, 900);
    const ids = (root: ParentNode) =>
      [...root.querySelectorAll<HTMLElement>("[data-outbound-id]")].map(
        (node) => node.dataset.outboundId,
      );
    {
      await using _screen = await render(
        <InWizard>
          <DataConsentView {...props()} />
        </InWizard>,
      );
      const summary = page.getByTestId("consent-summary");
      await expect.element(summary.getByText("A cada fuente activada")).toBeVisible();
      await expect.element(summary.getByText("Hasta 12 publicaciones")).toBeVisible();
      await expect.element(summary.getByText("Lo demás, sin tus textos")).toBeVisible();
      expect(page.getByTestId("consent-detail").elements()).toHaveLength(0);
      await shot("01-resumen");

      await openDetail();
      const detail = page.getByTestId("consent-detail");
      await expect.element(detail).toBeVisible();
      expect(ids(detail.element())).toEqual(DATA_OUTBOUND.map((entry) => entry.id));
      // The hashed sentence, one row per entry.
      expect(page.getByTestId("consent-other-outbound").element().textContent).toBe(
        `${OTHER_OUTBOUND_PREFIX.trim()}${OTHER_OUTBOUND.map(otherOutboundItem).join(";")}.`,
      );
      expect(otherOutboundLine()).toBe(
        `${OTHER_OUTBOUND_PREFIX}${OTHER_OUTBOUND.map(otherOutboundItem).join("; ")}.`,
      );
      expect(page.getByTestId("consent-common-stored").element().textContent).toBe(
        COMMON_STORED_LINE,
      );
      for (const text of [
        DATA_CONSENT_POLICY.intro,
        ...DATA_CONSENT_POLICY.outbound,
        ...DATA_CONSENT_POLICY.retention,
        ...DATA_CONSENT_POLICY.deletion,
      ]) {
        expect(detail.element().textContent).toContain(text);
      }
      await expect.element(page.getByText(/^Aún no hay capturas\./)).toBeInTheDocument();
      await userEvent.click(page.getByText("Orden para borrar desde la terminal"));
      await expect
        .element(
          page.getByText(
            "engine purge --corpus /home/operador/earlyscript-data/live --source <fuente>",
            { exact: false },
          ),
        )
        .toBeVisible();
      // Reading the detail is not accepting it.
      await expect.element(acceptBox()).not.toBeChecked();
      await expect.element(continueButton()).toBeDisabled();
      await shot("02-detalle");
    }
    await using _dialog = await render(<DataHandlingDialog trigger={<button type="button" />} />);
    await userEvent.click(page.getByRole("button", { name: "Cómo se tratan tus datos" }));
    const dialog = page.getByRole("dialog", { name: "Cómo se tratan tus datos" });
    await expect.element(dialog).toBeVisible();
    expect(ids(dialog.element())).toEqual(DATA_OUTBOUND.map((entry) => entry.id));
  });

  it("lists the readable sources with their terms folded, and names the ones without permission", async () => {
    await using _viewport = await viewport(1440, 900);
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props()} />
      </InWizard>,
    );
    await expect.element(page.getByRole("heading", { name: "Tus datos" })).toBeVisible();
    const ready = page.getByRole("list", { name: "Fuentes que se leerán" });
    expect(
      ready
        .getByRole("listitem")
        .elements()
        .map((item) => item.dataset.testid),
    ).toEqual([
      "consent-source-hn",
      "consent-source-github",
      "consent-source-arxiv",
      "consent-source-wikipedia",
      "consent-source-npm",
      "consent-source-huggingface",
      "consent-source-rss",
    ]);
    expect(page.getByTestId("consent-locked").element().textContent).toBe(
      "Sin permiso confirmado, no se leen: Stack Exchange, Bluesky y Lobsters.",
    );
    await expect.element(page.getByRole("switch", { name: "Leer Hacker News" })).toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Leer GitHub" })).toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Leer arXiv" })).not.toBeChecked();
    expect(page.getByRole("switch", { name: "Leer Lobsters" }).elements()).toHaveLength(0);

    const hn = page.getByTestId("consent-source-hn");
    expect(
      hn.getByText("Hasta la revisión del 27 nov 2026.", { exact: false }).elements(),
    ).toHaveLength(0);
    await userEvent.click(hn.getByRole("button", { expanded: false }));
    await expect
      .element(hn.getByText("leídos el 26 de octubre de 2026", { exact: false }))
      .toBeVisible();
    await expect
      .element(hn.getByRole("link", { name: "abrir" }))
      .toHaveAttribute("href", "https://www.ycombinator.com/legal");
    await expect
      .element(hn.getByText(/^Título; enlace a la discusión; usuario que la envió/))
      .toBeVisible();
    await expect.element(hn.getByText(/Hasta la revisión del 27 nov 2026\.$/)).toBeVisible();
    // The terms link opens apart: the row stays unfolded.
    await expect.element(hn.getByRole("button", { expanded: true })).toBeVisible();

    const rss = page.getByTestId("consent-source-rss");
    await userEvent.click(rss.getByRole("button", { expanded: false }));
    await expect.element(rss.getByText(/^14 feeds curados/)).toBeVisible();

    await openDetail();
    await expect
      .element(page.getByTestId("consent-locked-lobsters").getByText(/Bloqueada: Su robots\.txt/))
      .toBeVisible();
    await expect
      .element(
        page
          .getByTestId("consent-locked-stackexchange")
          .getByText(/Pendiente de leer sus términos/),
      )
      .toBeVisible();
    await shot("03-fuente-desplegada");
  });

  it("saves the switches only on «Aceptar y continuar», with the same policy hash", async () => {
    await using _viewport = await viewport(1280, 800);
    const save = vi.fn(async () => null);
    const onContinue = vi.fn();
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props({ save, onContinue })} />
      </InWizard>,
    );
    await userEvent.click(page.getByRole("switch", { name: "Leer arXiv" }));
    await userEvent.click(page.getByRole("switch", { name: "Leer GitHub" }));
    await expect.element(page.getByRole("switch", { name: "Leer arXiv" })).toBeChecked();
    expect(save).not.toHaveBeenCalled();

    await expect.element(continueButton()).toBeDisabled();
    await userEvent.click(acceptBox());
    await expect.element(continueButton()).toBeEnabled();
    await userEvent.click(continueButton());
    await vi.waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith([
      { source: "github", collect: false },
      { source: "arxiv", collect: true },
    ]);
    expect(onContinue).toHaveBeenCalledWith({
      sources: ["hn", "arxiv"],
      acknowledgedTerms: true,
      catalogHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      policyHash: await policyHash(),
      acceptedTermsDates: { hn: "2026-10-26", arxiv: "2026-10-31" },
    });
  });

  it("keeps a failed save next to the button and does not continue", async () => {
    let resolveSave: (value: string | null) => void = () => {};
    const save = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onContinue = vi.fn();
    await using _viewport = await viewport(1280, 800);
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props({ save, onContinue })} />
      </InWizard>,
    );
    await userEvent.click(page.getByRole("switch", { name: "Leer arXiv" }));
    await userEvent.click(acceptBox());
    await userEvent.click(continueButton());
    await expect.element(page.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    await expect.element(page.getByRole("switch", { name: "Leer arXiv" })).toBeDisabled();

    const message =
      "No se guardó la lectura de arXiv. La base editorial no respondió. Vuelve a intentarlo.";
    resolveSave(message);
    const alert = page.getByRole("alert").filter({ hasText: "No se guardó" });
    await expect.element(alert).toBeVisible();
    expect(alert.element().textContent).toBe(message);
    await expect.element(continueButton()).toHaveAccessibleDescription(message);
    expect(onContinue).not.toHaveBeenCalled();
    await shot("04-error-al-guardar");

    // Changing a switch clears the stale error.
    await userEvent.click(page.getByRole("switch", { name: "Leer arXiv" }));
    expect(alert.elements()).toHaveLength(0);
  });

  it("names a source the server locks though this client's catalog thinks it is ready", async () => {
    await using _viewport = await viewport(1280, 800);
    const locked: EditorialSourcesView = {
      ...FIRST_RUN,
      sources: FIRST_RUN.sources.map((source) =>
        source.source === "arxiv" ? { ...source, collectBlocked: "blocked" as const } : source,
      ),
    };
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props({ view: locked })} />
      </InWizard>,
    );
    expect(page.getByRole("switch", { name: "Leer arXiv" }).elements()).toHaveLength(0);
    expect(page.getByTestId("consent-locked").element().textContent).toContain("arXiv");
    await openDetail();
    await expect
      .element(
        page
          .getByTestId("consent-locked-arxiv")
          .getByText("Bloqueada en esta instalación", { exact: false }),
      )
      .toBeVisible();
  });

  it("shows loading, then an RPC error in Spanish with a retry", async () => {
    await using _viewport = await viewport(1280, 800);
    const onRetry = vi.fn();
    await using screen = await render(
      <InWizard>
        <DataConsentView {...props({ view: null })} />
      </InWizard>,
    );
    await expect.element(page.getByText("Cargando fuentes…")).toBeVisible();
    await userEvent.click(acceptBox());
    await expect.element(continueButton()).toBeDisabled();

    await screen.rerender(
      <InWizard>
        <DataConsentView
          {...props({
            view: null,
            loadError: "Los servicios editoriales no están montados en este servidor.",
            onRetry,
          })}
        />
      </InWizard>,
    );
    await expect.element(page.getByText("No se pudieron leer las fuentes")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("fits a phone without horizontal scroll", async () => {
    using _theme = darkTheme();
    await using _viewport = await viewport(390, 844);
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props()} />
      </InWizard>,
    );
    await expect.element(page.getByRole("switch", { name: "Leer Hacker News" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await shot("05-movil-oscuro");
  });
});
