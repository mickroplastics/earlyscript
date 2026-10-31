import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type EditorialVideoState } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const testState = vi.hoisted(() => ({
  live: null as null | { view: { threadId: string; video: unknown }; receivedAtMs: number },
  mode: "unknown" as "unknown" | "manual" | "other",
  calls: [] as Array<{ label: string; input: unknown }>,
  toast: vi.fn(),
}));

vi.mock(import("./videoState"), async (original) => ({
  ...(await original()),
  useVideoThread: (() => (testState.live?.view.video ? testState.live : null)) as never,
  useVideoThreadMode: (() => testState.mode) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  // No workspace: the editor slot says so and no script file is created.
  useQuietThreadShell: (() => null) as never,
  useProject: (() => null) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) => async (value: { input: unknown }) => {
    testState.calls.push({ label: command.label, input: value.input });
    return AsyncResult.success(testState.live?.view.video);
  }) as never,
}));
// The real preview needs a browser runtime; the tests drive its state store instead.
vi.mock(import("./ManualBrowser"), async (original) => ({
  ...(await original()),
  ManualBrowser: (() => <div data-testid="browser-double" />) as never,
}));
// Upstream's route renders ChatView; its double stands for the composer.
vi.mock(import("../components/ThreadRouteView"), () => ({
  ThreadRouteView: (() => <textarea aria-label="Composer" />) as never,
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { applyPreviewServerSnapshot, clearThreadPreviewState } from "../previewStateStore";
import { EditorialThreadRouteView } from "./EditorialThreadRouteView";
import { ManualVideoWorkspace } from "./ManualVideoWorkspace";
import { MANUAL_EXPLORING, MANUAL_WRITING } from "./videoThread.fixture";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-video"),
  threadId: ThreadId.make("thread-manual"),
};
const RECEIVED_AT_MS = Date.parse("2100-01-01T00:00:00.000Z");
const CLOCK = "environment-data:editorial:video-clock";

const renderWithRegistry = (element: ReactNode) =>
  render(<RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>);

const callsOf = (label: string) =>
  testState.calls.filter((call) => call.label === label).map((call) => call.input);

function setup(video: EditorialVideoState | null): Disposable {
  testState.calls.length = 0;
  testState.toast.mockReset();
  testState.mode = "manual";
  testState.live = { view: { threadId: "thread-manual", video }, receivedAtMs: RECEIVED_AT_MS };
  clearThreadPreviewState(THREAD_REF);
  return {
    [Symbol.dispose]: () => {
      testState.live = null;
      clearThreadPreviewState(THREAD_REF);
    },
  };
}

describe("EditorialThreadRouteView", () => {
  const target = { kind: "server" as const, threadRef: THREAD_REF };

  it("shows the manual workspace and no composer in a manual thread", async () => {
    using _setup = setup(MANUAL_EXPLORING);
    await using screen = await renderWithRegistry(
      <EditorialThreadRouteView target={target} background={false} />,
    );
    await expect.element(screen.getByTestId("manual-video-workspace")).toBeVisible();
    await expect.element(screen.getByText("manual", { exact: true })).toBeVisible();
    expect(screen.container.querySelector("[aria-label='Composer']")).toBeNull();
  });

  it("keeps the composer hidden and inert until the thread's kind is known", async () => {
    using _setup = setup(null);
    testState.mode = "unknown";
    await using screen = await renderWithRegistry(
      <EditorialThreadRouteView target={target} background={false} />,
    );
    const composer = screen.getByRole("textbox", { name: "Composer", includeHidden: true });
    await expect.element(composer).not.toBeVisible();
    expect(composer.element().closest("[inert]")).not.toBeNull();

    testState.mode = "other";
    await screen.rerender(
      <RegistryContext.Provider value={appAtomRegistry}>
        <EditorialThreadRouteView target={target} background={false} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByRole("textbox", { name: "Composer" })).toBeVisible();
    expect(screen.container.querySelector("[inert]")).toBeNull();
  });
});

describe("ManualVideoWorkspace", () => {
  it("shows both stage clocks, the captures and the folded browser history", async () => {
    using _setup = setup(MANUAL_WRITING);
    await using screen = await renderWithRegistry(<ManualVideoWorkspace threadRef={THREAD_REF} />);
    const clocks = screen.getByRole("group", { name: "Relojes de trabajo" });
    await expect.element(clocks.getByRole("timer", { name: "Explorar: 22:00" })).toBeVisible();
    await expect.element(clocks.getByRole("timer", { name: "Escribir: 09:00" })).toBeVisible();
    expect(clocks.getByRole("timer", { name: "Escribir: 09:00" }).element().dataset.active).toBe(
      "true",
    );
    expect(screen.getByTestId("manual-version").element().textContent).toContain("Versión 1 ·");

    await userEvent.click(screen.getByRole("button", { name: "Capturas" }));
    await expect
      .element(screen.getByRole("link", { name: /Google breaks open a bottleneck/ }))
      .toBeVisible();
    const history = screen.getByRole("button", { name: /Páginas abiertas/ });
    await expect.element(history).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(history);
    await expect
      .element(screen.getByRole("list", { name: "Páginas abiertas" }).getByRole("listitem"))
      .toHaveLength(3);
  });

  it("captures the page open in the browser with the operator's note", async () => {
    using _setup = setup(MANUAL_EXPLORING);
    await using screen = await renderWithRegistry(<ManualVideoWorkspace threadRef={THREAD_REF} />);
    const capture = screen.getByRole("button", { name: "Capturar la página abierta" });
    await expect.element(capture).toBeDisabled();

    // The integrated browser reports its active tab to the preview store.
    applyPreviewServerSnapshot(THREAD_REF, {
      threadId: "thread-manual",
      tabId: "tab-1",
      navStatus: {
        _tag: "Success",
        url: "https://news.ycombinator.com/item?id=50052",
        title: "Oído: Open-Vocabulary Speech Recognition on a $5 Microcontroller",
      },
      canGoBack: true,
      canGoForward: false,
      updatedAt: "2026-10-31T09:15:00.000Z",
    });
    await expect.element(capture).toBeEnabled();
    await userEvent.click(capture);
    await expect
      .element(screen.getByLabelText("Título"))
      .toHaveValue("Oído: Open-Vocabulary Speech Recognition on a $5 Microcontroller");
    await userEvent.fill(screen.getByLabelText("Nota"), "demo muy visual");
    await userEvent.click(screen.getByRole("button", { name: "Guardar captura" }));
    expect(callsOf("environment-data:editorial:video-capture")).toEqual([
      {
        threadId: "thread-manual",
        url: "https://news.ycombinator.com/item?id=50052",
        title: "Oído: Open-Vocabulary Speech Recognition on a $5 Microcontroller",
        note: "demo muy visual",
      },
    ]);
    // Saved: the form closes and the button is back.
    await expect
      .element(screen.getByRole("button", { name: "Capturar la página abierta" }))
      .toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Quitar github.com" }));
    expect(callsOf("environment-data:editorial:video-remove-capture")).toEqual([
      { threadId: "thread-manual", captureId: "capture-2" },
    ]);
  });

  it("moves the clock when the stage changes", async () => {
    using _setup = setup(MANUAL_EXPLORING);
    await using screen = await renderWithRegistry(<ManualVideoWorkspace threadRef={THREAD_REF} />);
    await expect.element(screen.getByTestId("browser-double")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "2 · Escribir" }));
    expect(callsOf(CLOCK)).toEqual([
      expect.objectContaining({
        threadId: "thread-manual",
        command: { _tag: "stage", stage: "write" },
      }),
    ]);
  });

  it("records the decision with the same block as an assisted thread", async () => {
    using _setup = setup({
      ...MANUAL_WRITING,
      clock: {
        ...MANUAL_WRITING.clock,
        state: { _tag: "running", stage: "decide", since: "2026-10-31T09:31:00.000Z" },
      },
    });
    await using screen = await renderWithRegistry(<ManualVideoWorkspace threadRef={THREAD_REF} />);
    await userEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    await userEvent.click(screen.getByRole("button", { name: "Utilidad 4" }));
    await userEvent.fill(screen.getByLabelText("Motivo"), "Hook claro");
    await userEvent.click(screen.getByRole("button", { name: "Registrar decisión" }));
    expect(callsOf("environment-data:editorial:video-decide")).toEqual([
      expect.objectContaining({
        threadId: "thread-manual",
        action: "accept",
        utility: 4,
        reason: "Hook claro",
        scriptVersionHash: "c0ffee00aa11bb22cc33",
      }),
    ]);
    expect(testState.toast).not.toHaveBeenCalled();
  });

  it("is read-only once decided, with the result form", async () => {
    using _setup = setup({
      ...MANUAL_WRITING,
      clock: { ...MANUAL_WRITING.clock, state: { _tag: "idle" } },
      decision: {
        decisionId: "decision-m",
        action: "accept",
        utility: 4,
        reason: null,
        scriptVersionHash: "c0ffee00aa11bb22cc33",
        durations: {
          exploreMs: 22 * 60_000,
          readMs: null,
          writeMs: 9 * 60_000,
          decideMs: 60_000,
          totalMs: 32 * 60_000,
        },
        clockDefinitive: true,
        decidedAt: "2026-10-31T09:32:00.000Z",
      },
    });
    await using screen = await renderWithRegistry(<ManualVideoWorkspace threadRef={THREAD_REF} />);
    await expect.element(screen.getByTestId("video-decision-read-only")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "Resultado" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "2 · Escribir" })).toBeDisabled();
    expect(screen.container.textContent).not.toContain("Capturar la página abierta");
    expect(screen.container.textContent).toContain("Decidido");
  });
});
