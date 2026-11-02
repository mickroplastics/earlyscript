import type { EditorialSourceEntry, EditorialSourcesView } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Dialog } from "../../components/ui/dialog";
import { WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../../components/ui/wizard";
import { COMMON_STORED_LINE, DATA_CONSENT_POLICY } from "./dataConsent.logic";
import { DATA_OUTBOUND, otherOutboundLine } from "./dataOutbound";
import { DataHandlingDialog } from "./DataHandlingDialog";
import { DataConsentView, type DataConsentViewProps } from "./DataConsentStep";
import { ONBOARDING_STAGES } from "./steps";

// Screenshots for review: VITE_EARLYSCRIPT_SHOTS=1 writes them to the git-ignored
// __screenshots__/data-consent/ next to this file; without it the test only asserts.
const SHOTS = import.meta.env.VITE_EARLYSCRIPT_SHOTS === "1";
async function shot(name: string) {
  if (SHOTS) await page.screenshot({ path: `__screenshots__/data-consent/${name}.png` });
}

/** The wizard dialog's only scroll container (WizardPopup's ScrollArea). */
function dialogScroll(): HTMLElement {
  const viewport = document.querySelector<HTMLElement>(
    "[role=dialog] [data-slot=scroll-area-viewport]",
  );
  if (!viewport) throw new Error("wizard scroll area not found");
  return viewport;
}
/**
 * Scrolls the dialog. WizardPanel animates its height, so "bottom" retries until the
 * step's last control is inside the dialog.
 */
async function scrollDialogTo(position: "top" | "middle" | "bottom") {
  const viewport = dialogScroll();
  if (position !== "bottom") {
    const max = viewport.scrollHeight - viewport.clientHeight;
    viewport.scrollTop = position === "top" ? 0 : max / 2;
    return;
  }
  await vi.waitFor(() => {
    viewport.scrollTop = viewport.scrollHeight;
    const last = continueOrSaving().getBoundingClientRect();
    expect(last.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
    expect(viewport.scrollTop + viewport.clientHeight).toBeGreaterThanOrEqual(
      viewport.scrollHeight - 1,
    );
  });
}
function continueOrSaving(): HTMLElement {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")];
  const button = buttons.find((candidate) => /Continuar|Guardando/.test(candidate.textContent));
  if (!button) throw new Error("continue button not found");
  return button;
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

/** The step inside the wizard's own chrome, as the shell mounts it. */
function InWizard({ children }: { readonly children: ReactNode }) {
  return (
    <Dialog open disablePointerDismissal>
      <WizardPopup size="wide" bottomStickOnMobile={false}>
        <WizardHeader title="Configurar Earlyscript">
          <WizardSteps steps={ONBOARDING_STAGES.map((stage) => stage.label)} currentStep={0} />
        </WizardHeader>
        <WizardPanel>{children}</WizardPanel>
      </WizardPopup>
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
const continueButton = () => page.getByRole("button", { name: "Continuar" });

describe("DataConsentStep", () => {
  it.each([
    [1280, 800, "claro"],
    [390, 844, "claro"],
    [1280, 800, "oscuro"],
    [390, 844, "oscuro"],
  ] as const)(
    "lists in the step and in the privacy dialog the same outbound entries (%ix%i, %s)",
    async (width, height, theme) => {
      using _theme = theme === "oscuro" ? darkTheme() : null;
      await using _viewport = await viewport(width, height);
      const ids = (root: ParentNode) =>
        [...root.querySelectorAll<HTMLElement>("[data-outbound-id]")].map(
          (node) => node.dataset.outboundId,
        );
      const tag = `${width}x${height}-${theme}`;
      {
        await using _screen = await render(
          <InWizard>
            <DataConsentView {...props()} />
          </InWizard>,
        );
        const block = page.getByRole("region", { name: "Qué sale de esta máquina" });
        await expect.element(block).toBeVisible();
        expect(ids(block.element())).toEqual(DATA_OUTBOUND.map((entry) => entry.id));
        expect(page.getByTestId("consent-other-outbound").element().textContent).toBe(
          otherOutboundLine(),
        );
        block.element().scrollIntoView({ block: "start" });
        await shot(`40-paso-que-sale-${tag}`);
      }
      await using _dialog = await render(<DataHandlingDialog trigger={<button type="button" />} />);
      await userEvent.click(page.getByRole("button", { name: "Cómo se tratan tus datos" }));
      const dialog = page.getByRole("dialog", { name: "Cómo se tratan tus datos" });
      await expect.element(dialog).toBeVisible();
      expect(ids(dialog.element())).toEqual(DATA_OUTBOUND.map((entry) => entry.id));
      await shot(`41-dialogo-datos-${tag}`);
    },
  );

  it("lists capturable sources apart from the ones without permission", async () => {
    await using _viewport = await viewport(1280, 800);
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props()} />
      </InWizard>,
    );
    await expect.element(page.getByRole("heading", { name: "Datos y permisos" })).toBeVisible();

    const ready = page.getByRole("list", { name: "Fuentes que puedes capturar" });
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
    const locked = page.getByRole("list", { name: "Fuentes sin permiso para capturar" });
    expect(
      locked
        .getByRole("listitem")
        .elements()
        .map((item) => item.dataset.testid),
    ).toEqual([
      "consent-source-stackexchange",
      "consent-source-bluesky",
      "consent-source-lobsters",
    ]);

    const hn = page.getByTestId("consent-source-hn");
    await expect
      .element(hn.getByText("Términos leídos el 26 de octubre de 2026", { exact: false }))
      .toBeVisible();
    await expect
      .element(hn.getByRole("link", { name: "Leer términos" }))
      .toHaveAttribute("href", "https://www.ycombinator.com/legal");
    await expect
      .element(hn.getByText(/^Título; enlace a la discusión; usuario que la envió/))
      .toBeVisible();
    const common = page.getByTestId("consent-common-stored");
    await expect.element(common).toBeVisible();
    expect(common.element().textContent).toBe(COMMON_STORED_LINE);
    await expect
      .element(page.getByTestId("consent-source-rss").getByText(/URL del feed\.$/))
      .toBeVisible();
    await expect.element(hn.getByText("Hasta la revisión del 27 nov 2026.")).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Capturar Hacker News" })).toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Capturar GitHub" })).toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Capturar arXiv" })).not.toBeChecked();
    await expect
      .element(page.getByTestId("consent-source-rss").getByText(/^14 feeds curados/))
      .toBeVisible();
    // Ranking is decided after a backtest, in Settings: the step never offers it.
    expect(page.getByRole("switch", { name: /en el motor/ }).elements()).toHaveLength(0);

    const lobsters = page.getByRole("switch", { name: "Capturar Lobsters" });
    await expect.element(lobsters).toBeDisabled();
    await expect.element(lobsters).toHaveAccessibleDescription(/^Bloqueada: Su robots\.txt/);
    const stack = page.getByRole("switch", { name: "Capturar Stack Exchange" });
    await expect.element(stack).toBeDisabled();
    await expect.element(stack).toHaveAccessibleDescription(/^Pendiente de leer sus términos/);

    await expect
      .element(
        page.getByText(
          "engine purge --corpus /home/operador/earlyscript-data/live --source <fuente>",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    await expect.element(page.getByText(/^Aún no hay capturas\./)).toBeInTheDocument();

    // One scroll for the whole dialog: the list does not scroll on its own.
    const listParents: string[] = [];
    for (let node = ready.element().parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === "auto" || overflow === "scroll") listParents.push(node.dataset.slot ?? "");
    }
    expect(listParents).toEqual(["scroll-area-viewport"]);

    await shot("01-escritorio-claro-arriba");
    await scrollDialogTo("middle");
    await shot("02-escritorio-claro-medio");
    await scrollDialogTo("bottom");
    await shot("03-escritorio-claro-abajo");
  });

  it("saves the switches only on Continuar, after the acceptance", async () => {
    await using _viewport = await viewport(1280, 800);
    const save = vi.fn(async () => null);
    const onContinue = vi.fn();
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props({ save, onContinue })} />
      </InWizard>,
    );
    await userEvent.click(page.getByRole("switch", { name: "Capturar arXiv" }));
    await userEvent.click(page.getByRole("switch", { name: "Capturar GitHub" }));
    await expect.element(page.getByRole("switch", { name: "Capturar arXiv" })).toBeChecked();
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
      policyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
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
    await using _viewport = await viewport(390, 844);
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props({ save, onContinue, onBack: vi.fn() })} />
      </InWizard>,
    );
    await userEvent.click(page.getByRole("switch", { name: "Capturar arXiv" }));
    await userEvent.click(acceptBox());
    await userEvent.click(continueButton());
    const saving = page.getByRole("button", { name: "Guardando…" });
    await expect.element(saving).toBeDisabled();
    await expect.element(page.getByRole("switch", { name: "Capturar arXiv" })).toBeDisabled();
    await scrollDialogTo("bottom");
    await shot("10-movil-claro-guardando");

    resolveSave(
      "No se guardó «Capturar» de arXiv. La base editorial no respondió. Vuelve a intentarlo.",
    );
    // Filtered: the page also holds an empty live region of its own.
    const alert = page.getByRole("alert").filter({ hasText: "No se guardó" });
    await expect.element(alert).toBeVisible();
    expect(alert.element().textContent).toBe(
      "No se guardó «Capturar» de arXiv. La base editorial no respondió. Vuelve a intentarlo.",
    );
    await expect
      .element(continueButton())
      .toHaveAccessibleDescription(/No se guardó «Capturar» de arXiv/);
    expect(onContinue).not.toHaveBeenCalled();
    await scrollDialogTo("bottom");
    await shot("11-movil-claro-error-al-guardar");

    // Changing a switch clears the stale error.
    await userEvent.click(page.getByRole("switch", { name: "Capturar arXiv" }));
    expect(alert.elements()).toHaveLength(0);
  });

  it("says when the server locks a source this client's catalog thinks is ready", async () => {
    await using _viewport = await viewport(390, 844);
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
    const arxiv = page
      .getByRole("list", { name: "Fuentes sin permiso para capturar" })
      .getByTestId("consent-source-arxiv");
    await expect
      .element(arxiv.getByText("Bloqueada en esta instalación", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Capturar arXiv" })).toBeDisabled();
    arxiv.element().scrollIntoView({ block: "center" });
    await shot("12-movil-claro-bloqueada-por-el-servidor");
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
    await shot("04-escritorio-claro-cargando");
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
    await scrollDialogTo("top");
    await shot("05-escritorio-claro-error-al-leer");
    await userEvent.click(page.getByRole("button", { name: "Reintentar" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(["claro", "oscuro"] as const)(
    "fits a phone without horizontal scroll (%s)",
    async (theme) => {
      using _theme = theme === "oscuro" ? darkTheme() : null;
      await using _viewport = await viewport(390, 844);
      await using _screen = await render(
        <InWizard>
          <DataConsentView {...props({ onBack: vi.fn() })} />
        </InWizard>,
      );
      await expect
        .element(page.getByRole("switch", { name: "Capturar Hacker News" }))
        .toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      expect(dialogScroll().scrollWidth).toBeLessThanOrEqual(dialogScroll().clientWidth);
      const prefix = theme === "claro" ? "2" : "3";
      await shot(`${prefix}0-movil-${theme}-arriba`);
      page.getByTestId("consent-source-rss").element().scrollIntoView({ block: "center" });
      await shot(`${prefix}1-movil-${theme}-lista`);
      page.getByTestId("consent-source-lobsters").element().scrollIntoView({ block: "center" });
      await shot(`${prefix}2-movil-${theme}-sin-permiso`);
      await scrollDialogTo("bottom");
      await shot(`${prefix}3-movil-${theme}-abajo`);
    },
  );

  it("renders in the dark theme on a desktop", async () => {
    using _theme = darkTheme();
    await using _viewport = await viewport(1280, 800);
    await using _screen = await render(
      <InWizard>
        <DataConsentView {...props()} />
      </InWizard>,
    );
    await expect.element(page.getByRole("heading", { name: "Datos y permisos" })).toBeVisible();
    await shot("06-escritorio-oscuro-arriba");
    await scrollDialogTo("bottom");
    await shot("07-escritorio-oscuro-abajo");
  });
});
