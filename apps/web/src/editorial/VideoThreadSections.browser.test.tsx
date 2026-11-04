import { RegistryContext } from "@effect/atom-react";
import {
  EditorialVideoError,
  EnvironmentId,
  ThreadId,
  type EditorialVideoState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const testState = vi.hoisted(() => ({
  live: null as null | { view: { threadId: string; video: unknown }; receivedAtMs: number },
  /** Every command run, by atom label, with its input. */
  calls: [] as Array<{ label: string; input: unknown }>,
  /** What the next command answers, by label; success with the current view otherwise. */
  failures: new Map<string, unknown>(),
  /** What a command answers on success, by label; the current view otherwise. */
  answers: new Map<string, unknown>(),
  /** The thread's workspace; null keeps the editor's write flush out of the way. */
  workspace: null as string | null,
  /** The T3 thread shell, when a test needs more of it than its workspace. */
  shell: null as null | Record<string, unknown>,
  flush: (async () => true) as (target: unknown) => Promise<boolean>,
  toast: vi.fn(),
}));

vi.mock(import("./videoState"), async (original) => ({
  ...(await original()),
  useVideoThread: (() => (testState.live?.view.video ? testState.live : null)) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  // No workspace unless a test sets one: auto-versioning stays off and "Abrir guion" disabled.
  useQuietThreadShell: (() =>
    testState.shell ??
    (testState.workspace === null
      ? null
      : {
          environmentId: "environment-video",
          projectId: "project",
          worktreePath: testState.workspace,
        })) as never,
  useProject: (() => null) as never,
}));
vi.mock(import("../components/files/fileSaveSessions"), async (original) => ({
  ...(await original()),
  flushFileSaveSession: ((target: unknown) => testState.flush(target)) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label: string }) => async (value: { input: unknown }) => {
    testState.calls.push({ label: command.label, input: value.input });
    const failure = testState.failures.get(command.label);
    if (failure !== undefined) return AsyncResult.failure(Cause.fail(failure));
    return AsyncResult.success(
      testState.answers.has(command.label)
        ? testState.answers.get(command.label)
        : testState.live?.view.video,
    );
  }) as never,
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import { useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { createFileSaveSessions, type FileSaveTarget } from "../components/files/fileSaveSessions";
import { DECIDED, JUST_CREATED, WRITING } from "./videoThread.fixture";
import { draftRequestPrompt } from "./videoThread.logic";
import { VideoThreadSections } from "./VideoThreadSections";
import { WorkClock } from "./WorkClock";

const THREAD_REF = {
  environmentId: EnvironmentId.make("environment-video"),
  threadId: ThreadId.make("thread-video"),
};

/**
 * When the view arrived, after any real time the page can have: the components never show a
 * moment before arrival, so a running clock reads exactly the server's summary.
 */
const RECEIVED_AT_MS = Date.parse("2100-01-01T00:00:00.000Z");

const setVideo = (video: EditorialVideoState | null) => {
  testState.live = { view: { threadId: "thread-video", video }, receivedAtMs: RECEIVED_AT_MS };
};

const renderWithRegistry = (element: ReactNode) =>
  render(<RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>);

/** The text of one element. The clock re-renders every second, which `toHaveTextContent` polls badly. */
const textOf = (locator: Locator) => locator.element().textContent ?? "";

const callsOf = (label: string) =>
  testState.calls.filter((call) => call.label === label).map((call) => call.input);

/** Fresh doubles for one test. */
function setup(video: EditorialVideoState | null): Disposable {
  testState.live = null;
  testState.calls.length = 0;
  testState.failures.clear();
  testState.answers.clear();
  testState.workspace = null;
  testState.shell = null;
  testState.flush = async () => true;
  testState.toast.mockReset();
  setVideo(video);
  return { [Symbol.dispose]: () => void (testState.live = null) };
}

describe("VideoThreadSections", () => {
  it("renders nothing for a thread with no editorial side", async () => {
    using _setup = setup(null);
    await using screen = await renderWithRegistry(
      <>
        <VideoThreadSections threadRef={THREAD_REF} />
        <WorkClock threadRef={THREAD_REF} />
      </>,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("shows the dossier, the clock and the script version of a video thread", async () => {
    using _setup = setup(WRITING);
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await expect.element(screen.getByRole("heading", { name: "Hilo de video" })).toBeVisible();
    await expect.element(screen.getByText("asistido")).toBeVisible();
    const link = screen.getByRole("link", {
      name: "Computación cuántica: Google, IBM y hardware abierto",
    });
    await expect
      .element(link)
      .toHaveAttribute(
        "href",
        "/editorial/environment-video/trends/dos_bbb80d57481e?run=run_20261019_20261027T003754_2263f7",
      );
    expect(textOf(screen.getByLabelText("Reloj"))).toBe("Escribir 04:00 · total 09:00");
    const version = textOf(screen.getByTestId("video-script-version"));
    expect(version).toContain("Versión 1 · 9f2c1ab0");
    expect(version).toContain("10 de 11 afirmaciones con cita");
    // The result form waits for the decision.
    expect(screen.container.textContent).not.toContain("Guardar resultado");
  });

  it("sends the decision with the version on screen", async () => {
    using _setup = setup(WRITING);
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    const submit = screen.getByRole("button", { name: "Registrar decisión" });
    await expect.element(submit).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Editar" }));
    await userEvent.click(screen.getByRole("button", { name: "Utilidad 4" }));
    await expect.element(screen.getByText("El motivo es obligatorio para editar.")).toBeVisible();
    await userEvent.fill(screen.getByLabelText("Motivo"), "Falta una voz crítica");
    await userEvent.click(submit);
    expect(callsOf("environment-data:editorial:video-decide")).toEqual([
      expect.objectContaining({
        threadId: "thread-video",
        action: "edit",
        utility: 4,
        reason: "Falta una voz crítica",
        scriptVersionHash: "9f2c1ab07d3e4c55aa10",
      }),
    ]);
  });

  it("explains a refused version and returns to the form on the new one", async () => {
    using _setup = setup(WRITING);
    testState.failures.set(
      "environment-data:editorial:video-decide",
      new EditorialVideoError({ reason: "version-changed", message: "changed" }),
    );
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await userEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    await userEvent.click(screen.getByRole("button", { name: "Utilidad 5" }));
    await userEvent.click(screen.getByRole("button", { name: "Registrar decisión" }));
    await expect
      .element(screen.getByText(/El guion cambió después de la versión que leíste \(9f2c1ab0\)/))
      .toBeVisible();
    await expect.element(screen.getByText("Leyendo la versión nueva…")).toBeVisible();
    expect(testState.toast).not.toHaveBeenCalled();

    // The subscription brings the version the server snapshotted while refusing.
    setVideo({
      ...WRITING,
      script: {
        ...WRITING.script,
        head: { ...WRITING.script.head!, contentHash: "b71e00aa55", versionId: "version-2" },
        versionCount: 2,
      },
    });
    await screen.rerender(
      <RegistryContext.Provider value={appAtomRegistry}>
        <VideoThreadSections threadRef={THREAD_REF} />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(/Versión actual: b71e00aa/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Decidir sobre la versión nueva" }));
    // The draft survives; the operator submits again on the version now shown.
    await expect.element(screen.getByRole("button", { name: "Registrar decisión" })).toBeEnabled();
  });

  it("fills the composer with the draft request of a new assisted thread and sends nothing", async () => {
    using _setup = setup(JUST_CREATED);
    const fresh = {
      environmentId: "environment-video",
      projectId: "project",
      worktreePath: "/workspace",
      latestRun: null,
      latestUserMessageAt: null,
    };
    testState.shell = fresh;
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
    const openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    // The server wrote the script with the dossier, so the panel no longer says it is missing.
    expect(screen.container.textContent).toContain("Sin versiones guardadas.");
    expect(screen.container.textContent).not.toContain("Aún no existe");

    await userEvent.click(screen.getByRole("button", { name: "Pedir un borrador del guion" }));
    const prompt = draftRequestPrompt({
      dossierPath: "videos/computacion-cuantica-threadvi/expediente.md",
      scriptPath: "videos/computacion-cuantica-threadvi/guion.md",
    });
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe(prompt);
    // Filling the composer runs no command: the operator sends it.
    expect(testState.calls).toEqual([]);

    // A message the operator was typing stays until they choose to replace it.
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "mi idea");
    await userEvent.click(screen.getByRole("button", { name: "Pedir un borrador del guion" }));
    expect(useComposerDraftStore.getState().getComposerDraft(THREAD_REF)?.prompt).toBe("mi idea");
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Ya hay un mensaje a medio escribir" }),
    );

    // The dossier opens by its host path, read-only in the file surface.
    await userEvent.click(screen.getByRole("button", { name: "Abrir expediente" }));
    expect(openFile).toHaveBeenCalledWith(
      THREAD_REF,
      "/workspace/videos/computacion-cuantica-threadvi/expediente.md",
    );

    // Once the agent has been asked, the button goes.
    testState.shell = { ...fresh, latestRun: { runId: "run-1" } };
    await screen.rerender(
      <RegistryContext.Provider value={appAtomRegistry}>
        <VideoThreadSections threadRef={THREAD_REF} />
      </RegistryContext.Provider>,
    );
    await expect
      .element(screen.getByRole("button", { name: "Pedir un borrador del guion" }))
      .not.toBeInTheDocument();
    useComposerDraftStore.getState().setPrompt(THREAD_REF, "");
    openFile.mockRestore();
  });

  it("offers no draft request in a thread already under way", async () => {
    using _setup = setup(WRITING);
    testState.shell = {
      latestRun: { runId: "run-1" },
      latestUserMessageAt: "2026-10-31T13:01:00.000Z",
    };
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await expect.element(screen.getByRole("heading", { name: "Hilo de video" })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Pedir un borrador");
    expect(screen.container.textContent).not.toContain("Abrir expediente");
  });

  it("is read-only once decided and offers the result form", async () => {
    using _setup = setup(DECIDED);
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    expect(textOf(screen.getByTestId("video-decision-read-only"))).toContain(
      "Editar · utilidad 4 de 5",
    );
    expect(screen.container.querySelector("form[aria-label='Decisión']")).toBeNull();
    await expect.element(screen.getByText(/Descriptivo, no atribuido al sistema/)).toBeVisible();
    await userEvent.fill(screen.getByLabelText("Vistas"), "1200");
    await userEvent.click(screen.getByRole("button", { name: "Guardar resultado" }));
    expect(callsOf("environment-data:editorial:video-save-result")).toEqual([
      expect.objectContaining({ threadId: "thread-video", views: 1200 }),
    ]);
  });
});

/**
 * The editor's save session for the script, with its write to the server held: the latest
 * sentence is on screen and in flight, not yet on disk, as in the review's reproduction.
 */
function heldEditorWrite(contents: string) {
  const target: FileSaveTarget = {
    environmentId: THREAD_REF.environmentId,
    cwd: "/workspace",
    relativePath: "videos/computacion-cuantica-threadvi.md",
  };
  const writes: string[] = [];
  let release: (succeeded: boolean) => void = () => {};
  const sessions = createFileSaveSessions({
    debounceMs: 500,
    canPersist: () => true,
    subscribeWritable: () => () => {},
    persist: (_target, written) => {
      writes.push(written);
      return new Promise((resolve) => {
        release = (succeeded) =>
          resolve(
            succeeded ? AsyncResult.success(undefined) : AsyncResult.failure(Cause.fail("offline")),
          );
      });
    },
    confirm: () => true,
    readUnsaved: () => null,
  });
  sessions.acquire(target, () => {});
  sessions.change(target, contents);
  testState.workspace = "/workspace";
  testState.flush = (flushed) => sessions.flush(flushed as FileSaveTarget);
  return { writes, release: (succeeded: boolean) => release(succeeded) };
}

const DECIDE = "environment-data:editorial:video-decide";
const SAVE_SCRIPT = "environment-data:editorial:video-save-script";
const CLOCK = "environment-data:editorial:video-clock";

async function chooseAccept4(screen: Awaited<ReturnType<typeof renderWithRegistry>>) {
  await userEvent.click(screen.getByRole("button", { name: "Aceptar" }));
  await userEvent.click(screen.getByRole("button", { name: "Utilidad 4" }));
  await userEvent.click(screen.getByRole("button", { name: "Registrar decisión" }));
}

describe("VideoThreadSections, review of 76967e71c6", () => {
  // H1: the decision waits for the held write, snapshots after it, then decides.
  it("waits for the editor's held write before snapshotting and deciding", async () => {
    using _setup = setup(WRITING);
    const editor = heldEditorWrite("Pending latest sentence before decision.");
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await chooseAccept4(screen);
    await expect.poll(() => editor.writes).toEqual(["Pending latest sentence before decision."]);
    expect(callsOf(SAVE_SCRIPT)).toEqual([]);
    expect(callsOf(DECIDE)).toEqual([]);

    editor.release(true);
    await expect.poll(() => callsOf(DECIDE).length).toBe(1);
    expect(callsOf(SAVE_SCRIPT)).toEqual([{ threadId: "thread-video" }]);
    expect(callsOf(DECIDE)[0]).toMatchObject({ scriptVersionHash: "9f2c1ab07d3e4c55aa10" });
  });

  it("does not decide when the held write fails", async () => {
    using _setup = setup(WRITING);
    const editor = heldEditorWrite("Pending latest sentence before decision.");
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await chooseAccept4(screen);
    await expect.poll(() => editor.writes.length).toBe(1);
    editor.release(false);
    await expect.element(screen.getByText(/No se pudo guardar el guion/)).toBeVisible();
    expect(callsOf(SAVE_SCRIPT)).toEqual([]);
    expect(callsOf(DECIDE)).toEqual([]);
  });

  it("asks for a review when the written script is another version", async () => {
    using _setup = setup(WRITING);
    const editor = heldEditorWrite("Pending latest sentence before decision.");
    const written = {
      ...WRITING,
      script: {
        ...WRITING.script,
        head: { ...WRITING.script.head!, contentHash: "d1419323fdb7", versionId: "version-2" },
      },
    };
    testState.answers.set(SAVE_SCRIPT, written);
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await chooseAccept4(screen);
    await expect.poll(() => editor.writes.length).toBe(1);
    editor.release(true);
    await expect
      .element(screen.getByText(/El guion cambió después de la versión que leíste \(9f2c1ab0\)/))
      .toBeVisible();
    expect(callsOf(DECIDE)).toEqual([]);
  });

  // H3: turning to the block opens Decidir, once.
  it("opens Decidir when the operator turns to the decision block", async () => {
    using _setup = setup(WRITING);
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    expect(screen.container.textContent).not.toContain("Pasar a Decidir");
    await userEvent.click(screen.getByRole("button", { name: "Editar" }));
    await expect
      .poll(() => callsOf(CLOCK))
      .toEqual([expect.objectContaining({ command: { _tag: "stage", stage: "decide" } })]);
  });

  /** A click alone, without pointer or focus, as scripted clicks and some assistive tools send. */
  const clickOnly = (locator: Locator) => (locator.element() as HTMLElement).click();

  // The decision's own snapshot ended Leer at submission and left Escribir and Decidir at zero.
  it("opens Decidir before the snapshot when the form is sent without pointer or focus", async () => {
    using _setup = setup({
      ...WRITING,
      clock: {
        ...WRITING.clock,
        state: { _tag: "running", stage: "read", since: "2026-10-31T13:05:00.000Z" },
      },
    });
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    clickOnly(screen.getByRole("button", { name: "Aceptar" }));
    await expect
      .element(screen.getByRole("button", { name: "Aceptar" }))
      .toHaveAttribute("aria-pressed", "true");
    clickOnly(screen.getByRole("button", { name: "Utilidad 4" }));
    await expect.element(screen.getByRole("button", { name: "Registrar decisión" })).toBeEnabled();
    clickOnly(screen.getByRole("button", { name: "Registrar decisión" }));
    await expect.poll(() => callsOf(DECIDE).length).toBe(1);
    const order = testState.calls.map((call) => call.label);
    expect(callsOf(CLOCK)).toEqual([
      expect.objectContaining({ command: { _tag: "stage", stage: "decide" } }),
    ]);
    expect(order.indexOf(CLOCK)).toBeLessThan(order.indexOf(SAVE_SCRIPT));
    expect(order.indexOf(SAVE_SCRIPT)).toBeLessThan(order.indexOf(DECIDE));
  });

  // H3-R: a clock a resolved recovery left stopped starts again in Decidir, once.
  it("starts Decidir from a stopped clock when the operator turns to the block", async () => {
    using _setup = setup({ ...WRITING, clock: { ...WRITING.clock, state: { _tag: "idle" } } });
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await userEvent.click(screen.getByRole("button", { name: "Aceptar" }));
    await expect
      .poll(() => callsOf(CLOCK))
      .toEqual([expect.objectContaining({ command: { _tag: "start", stage: "decide" } })]);
  });

  // H4: once decided, the script opens as the decided snapshot, read-only.
  it("opens the decided version instead of the editable script", async () => {
    using _setup = setup(DECIDED);
    testState.answers.set("environment-data:editorial:video-open-version", {
      path: "/state/editorial/versions/9f2c1ab07d3e4c55aa10/computacion-cuantica-threadvi.md",
    });
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    expect(screen.container.textContent).not.toContain("Abrir guion");
    await userEvent.click(screen.getByRole("button", { name: "Abrir versión decidida" }));
    expect(callsOf("environment-data:editorial:video-open-version")).toEqual([
      { threadId: "thread-video", contentHash: "9f2c1ab07d3e4c55aa10" },
    ]);
  });

  // H6: a recovered segment is resolved before the decision.
  it("asks to resolve a recovered segment before deciding", async () => {
    using _setup = setup({
      ...WRITING,
      clock: {
        ...WRITING.clock,
        state: { _tag: "idle" },
        unresolved: [
          {
            intervalId: "interval-1",
            stage: "write",
            startedAt: "2026-10-31T13:05:00.000Z",
            recoveredAt: "2026-10-31T13:40:00.000Z",
          },
        ],
        definitive: false,
      },
    });
    await using screen = await renderWithRegistry(<VideoThreadSections threadRef={THREAD_REF} />);
    await expect
      .element(screen.getByText("Resuelve el tramo abierto antes de decidir."))
      .toBeVisible();
    expect(screen.container.querySelector("form[aria-label='Decisión']")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Ir a la resolución" }));
    await expect.element(screen.getByLabelText("Dejé de trabajar a las")).toHaveFocus();
  });
});

describe("WorkClock", () => {
  it("pauses with the reason typed", async () => {
    using _setup = setup(WRITING);
    await using screen = await renderWithRegistry(<WorkClock threadRef={THREAD_REF} />);
    await expect.element(screen.getByRole("group", { name: "Reloj de trabajo" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Pausar reloj" }));
    await userEvent.fill(page.getByLabelText("Motivo de la pausa (opcional)"), "Llamada");
    await userEvent.click(page.getByRole("button", { name: "Pausar", exact: true }));
    expect(callsOf("environment-data:editorial:video-clock")).toEqual([
      expect.objectContaining({
        threadId: "thread-video",
        command: { _tag: "pause", reason: "Llamada" },
      }),
    ]);
  });

  it("shows a decided clock as final, without controls", async () => {
    using _setup = setup(DECIDED);
    await using screen = await renderWithRegistry(<WorkClock threadRef={THREAD_REF} />);
    await expect.element(screen.getByText("Decidido")).toBeVisible();
    expect(screen.container.querySelector("button")).toBeNull();
    await act(() => {});
  });
});
