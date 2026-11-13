import { EnvironmentId, type EditorialNightlySettings } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Dialog, DialogPopup, DialogTitle } from "../../components/ui/dialog";
import { DONE_JOB, FAILED_JOB, NIGHTLY_OFF, NIGHTLY_ON, RUNNING_JOB } from "../firstRun.fixture";
import { firstRunView } from "../firstRun.logic";
import { EngineStep, EngineStepView, type EngineStepViewProps } from "./EngineStep";

/** Screenshots only when asked: `VITE_EARLYSCRIPT_CAPTURE=1`. Ignored by Git. */
const capture = async (name: string) => {
  if ((import.meta.env as Record<string, unknown>)["VITE_EARLYSCRIPT_CAPTURE"] !== "1") return;
  document.documentElement.classList.add("dark");
  await page.screenshot({ path: `__screenshots__/${name}.png` });
  document.documentElement.classList.remove("dark");
};

type Settled = AsyncResult.AsyncResult<EditorialNightlySettings, unknown>;

// The wired step with `updateSettings` answered by hand: each call waits for the test.
const saves = vi.hoisted(() => ({
  calls: [] as Array<{ input: unknown; resolve: (result: unknown) => void }>,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => (value: { input: unknown }) =>
    new Promise((resolve) => saves.calls.push({ input: value.input, resolve })),
}));
vi.mock("../FirstRunCard", async () => {
  const actual = await vi.importActual<typeof import("../FirstRunCard")>("../FirstRunCard");
  const { NIGHTLY_OFF: settings } =
    await vi.importActual<typeof import("../firstRun.fixture")>("../firstRun.fixture");
  return {
    ...actual,
    useFirstRun: () => ({
      settings: { data: settings, error: null, refresh: () => {} },
      active: null,
      latest: null,
      jobsKnown: true,
      jobCount: 0,
      starting: false,
      error: null,
      start: async () => true,
    }),
  };
});

const answer = (index: number, result: Settled) => saves.calls[index]?.resolve(result);

const NOW = Date.parse("2026-11-02T23:13:00.000Z");

const renderStep = async (props: Partial<EngineStepViewProps>) => {
  const onChange = vi.fn();
  const onRun = vi.fn();
  const onContinue = vi.fn();
  const onBack = vi.fn();
  const screen = await render(
    <InDialog>
      <EngineStepView
        settings={NIGHTLY_OFF}
        loadError={null}
        model={<p>Modelo</p>}
        modelProgress="ready"
        run={{ kind: "idle" }}
        first
        starting={false}
        runError={null}
        firstRunStarted={false}
        saving={false}
        saveError={null}
        notes={{ collect: "Hacker News, GitHub" }}
        nowMs={NOW}
        onRetrySave={() => {}}
        onChange={onChange}
        onRun={onRun}
        onRetry={() => {}}
        onBack={onBack}
        onContinue={onContinue}
        {...props}
      />
    </InDialog>,
  );
  return { screen, onChange, onRun, onContinue, onBack };
};

/** A dialog of the wizard's last step, as `EarlyscriptWizardView` mounts it. */
function InDialog({ children }: { readonly children: ReactNode }) {
  return (
    <Dialog open disablePointerDismissal>
      <DialogPopup
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="h-[min(39rem,calc(100dvh-2rem))] w-[min(62.5rem,calc(100vw-2rem))] max-w-none overflow-hidden"
      >
        <DialogTitle className="sr-only">Configurar Earlyscript</DialogTitle>
        {children}
      </DialogPopup>
    </Dialog>
  );
}

const finish = (name: string | RegExp) => page.getByRole("button", { name });

describe("EngineStep", () => {
  it("shows the machine's zone and saves the switch and the time", async () => {
    const { screen, onChange } = await renderStep({});
    await using _screen = screen;
    await expect
      .element(page.getByTestId("engine-schedule"))
      .toHaveTextContent("America/Guayaquil");
    await userEvent.click(page.getByRole("switch", { name: "Revisión nocturna" }));
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
    await userEvent.fill(page.getByLabelText("Revisar a las"), "04:30");
    expect(onChange).toHaveBeenCalledWith({ timeOfDay: "04:30" });
  });

  it("explains each night before the first review, and finishes on the model's download", async () => {
    const { screen, onContinue } = await renderStep({ modelProgress: "downloading" });
    await using _screen = screen;
    await expect.element(page.getByText("Qué pasa cada noche")).toBeVisible();
    const phases = page.getByRole("list", { name: "Fases de la revisión" });
    await expect.element(phases.getByText("Hacker News, GitHub")).toBeVisible();
    await userEvent.click(finish("Terminar y buscar al acabar la descarga"));
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({ firstRunStarted: false, modelReady: false }),
    );
  });

  it("follows the review in flight and lets the operator finish", async () => {
    const { screen, onContinue } = await renderStep({
      settings: NIGHTLY_ON,
      run: firstRunView({ active: RUNNING_JOB, latest: null, emptyRun: false }),
      firstRunStarted: true,
    });
    await using _screen = screen;
    await expect.element(page.getByText("Ahora mismo")).toBeVisible();
    await expect.element(page.getByText(/^En marcha · \d+ min$/)).toBeVisible();
    await expect
      .element(page.getByRole("listitem", { name: /^Encuentra tendencias: en curso/ }))
      .toBeVisible();
    await userEvent.click(finish("Terminar y ver el progreso"));
    expect(onContinue).toHaveBeenCalledWith({
      nightlyEnabled: true,
      timeOfDay: "03:00",
      timezone: "America/Guayaquil",
      firstRunStarted: true,
      modelReady: true,
    });
  });

  it("offers only the way forward once the first review is done", async () => {
    const { screen, onContinue } = await renderStep({
      settings: NIGHTLY_ON,
      run: firstRunView({ active: null, latest: DONE_JOB, emptyRun: false }),
      firstRunStarted: true,
    });
    await using _screen = screen;
    await expect.element(page.getByText("Terminada")).toBeVisible();
    await expect.element(page.getByText(/^Lista · \d+ tendencias$/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Atrás" })).not.toBeInTheDocument();
    await userEvent.click(finish("Ver mis tendencias"));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("says where the review stopped, retries it, and lets the operator finish anyway", async () => {
    const { screen, onRun, onContinue } = await renderStep({
      settings: NIGHTLY_ON,
      run: firstRunView({ active: null, latest: FAILED_JOB, emptyRun: false }),
      firstRunStarted: true,
    });
    await using _screen = screen;
    await expect.element(page.getByText("Se detuvo aquí")).toBeVisible();
    await expect.element(page.getByText("No se pudieron agrupar las publicaciones.")).toBeVisible();
    await expect
      .element(page.getByText("Lo leído quedó guardado; al reintentar no se vuelve a leer."))
      .toBeVisible();
    await expect.element(page.getByText("Si terminas, se reintenta esta noche.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Detalle técnico" }));
    await expect.element(page.getByText("engine run exited with 1")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Reintentar" }));
    expect(onRun).toHaveBeenCalledOnce();
    await userEvent.click(finish("Terminar igual"));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it("waits for the settings before finishing", async () => {
    const { screen } = await renderStep({ settings: null, loadError: "sin conexión" });
    await using _screen = screen;
    await expect
      .element(page.getByText("No se pudo leer la revisión nocturna: sin conexión"))
      .toBeVisible();
    await expect.element(finish("Terminar")).toBeDisabled();
  });

  it("holds «Terminar» while a change saves and accepts what the server confirmed", async () => {
    saves.calls = [];
    const onContinue = vi.fn();
    await using _screen = await render(
      <InDialog>
        <EngineStep
          environmentId={EnvironmentId.make("env-1")}
          onContinue={onContinue}
          onBack={null}
        />
      </InDialog>,
    );
    await userEvent.click(page.getByRole("switch", { name: "Revisión nocturna" }));
    expect(saves.calls.map((call) => call.input)).toEqual([{ enabled: true }]);
    await expect.element(page.getByRole("switch", { name: "Revisión nocturna" })).toBeChecked();
    await expect.element(page.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    expect(onContinue).not.toHaveBeenCalled();

    answer(0, AsyncResult.success({ ...NIGHTLY_OFF, enabled: true, timeOfDay: "03:00" }));
    await expect.element(finish("Terminar")).toBeEnabled();
    await userEvent.click(finish("Terminar"));
    expect(onContinue).toHaveBeenCalledWith({
      nightlyEnabled: true,
      timeOfDay: "03:00",
      timezone: "America/Guayaquil",
      firstRunStarted: false,
      modelReady: false,
    });
  });

  it("shows a failed save beside the control and does not finish until it saves", async () => {
    saves.calls = [];
    const onContinue = vi.fn();
    await using _screen = await render(
      <InDialog>
        <EngineStep
          environmentId={EnvironmentId.make("env-1")}
          onContinue={onContinue}
          onBack={null}
        />
      </InDialog>,
    );
    await userEvent.click(page.getByRole("switch", { name: "Revisión nocturna" }));
    answer(0, AsyncResult.fail({ reason: "storage" }));
    await expect
      .element(page.getByText("No se guardó la revisión nocturna: La base editorial no respondió."))
      .toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Revisión nocturna" })).not.toBeChecked();
    await expect.element(finish("Terminar")).toBeDisabled();

    await userEvent.click(page.getByRole("button", { name: "Reintentar" }));
    expect(saves.calls.map((call) => call.input)).toEqual([{ enabled: true }, { enabled: true }]);
    answer(1, AsyncResult.success({ ...NIGHTLY_OFF, enabled: true }));
    await expect.element(finish("Terminar")).toBeEnabled();
    await userEvent.click(finish("Terminar"));
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ nightlyEnabled: true }));
  });
});

describe.each([
  ["1440", 1440, 900],
  ["1280", 1280, 800],
] as const)("EngineStep at %s", (size, width, height) => {
  it("keeps «Terminar» in view below the two columns", async () => {
    await page.viewport(width, height);
    const { screen } = await renderStep({
      settings: NIGHTLY_ON,
      run: firstRunView({ active: null, latest: FAILED_JOB, emptyRun: false }),
    });
    await using _screen = screen;
    const button = finish("Terminar igual").element();
    expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(height);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await capture(`engine-fallida-${size}`);
  });
});
