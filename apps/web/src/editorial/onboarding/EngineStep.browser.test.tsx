import { EnvironmentId, type EditorialNightlySettings } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NIGHTLY_OFF, NIGHTLY_ON, RUNNING_JOB } from "../firstRun.fixture";
import { firstRunView } from "../firstRun.logic";
import { EngineStep, EngineStepView, type EngineStepViewProps } from "./EngineStep";

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
      starting: false,
      error: null,
      start: async () => true,
    }),
  };
});

const answer = (index: number, result: Settled) => saves.calls[index]?.resolve(result);

const renderStep = async (props: Partial<EngineStepViewProps>) => {
  const onChange = vi.fn();
  const onRun = vi.fn();
  const onContinue = vi.fn();
  const screen = await render(
    <EngineStepView
      settings={NIGHTLY_OFF}
      loadError={null}
      model={<p>Modelo</p>}
      modelReady
      run={{ kind: "idle" }}
      starting={false}
      runError={null}
      firstRunStarted={false}
      saving={false}
      saveError={null}
      onRetrySave={() => {}}
      onChange={onChange}
      onRun={onRun}
      onRetry={() => {}}
      onBack={() => {}}
      onContinue={onContinue}
      {...props}
    />,
  );
  return { screen, onChange, onRun, onContinue };
};

describe("EngineStep", () => {
  it("names the schedule in the machine's zone and saves the switch and the time", async () => {
    const { screen, onChange } = await renderStep({});
    await using _screen = screen;
    await expect
      .element(screen.getByTestId("engine-schedule"))
      .toHaveTextContent("03:00, hora de America/Guayaquil");
    await userEvent.click(screen.getByRole("switch", { name: "Activar la corrida nocturna" }));
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
    await userEvent.fill(screen.getByLabelText("Hora de la corrida nocturna"), "04:30");
    expect(onChange).toHaveBeenCalledWith({ timeOfDay: "04:30" });
  });

  it("holds the first run until the model is ready", async () => {
    const { screen, onRun } = await renderStep({ modelReady: false });
    await using _screen = screen;
    await expect
      .element(screen.getByRole("button", { name: "Ejecutar la primera corrida ahora" }))
      .toBeDisabled();
    await expect.element(screen.getByText(/^Primero descarga el modelo local/)).toBeVisible();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("lets the operator continue while the first run is in flight", async () => {
    const { screen, onContinue } = await renderStep({
      settings: NIGHTLY_ON,
      run: firstRunView({ active: RUNNING_JOB, latest: null, emptyRun: false }),
      firstRunStarted: true,
    });
    await using _screen = screen;
    await expect.element(screen.getByRole("list", { name: "Fases de la corrida" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(onContinue).toHaveBeenCalledWith({
      nightlyEnabled: true,
      timeOfDay: "03:00",
      timezone: "America/Guayaquil",
      firstRunStarted: true,
      modelReady: true,
    });
  });

  it("waits for the settings before continuing", async () => {
    const { screen } = await renderStep({ settings: null, loadError: "sin conexión" });
    await using _screen = screen;
    await expect
      .element(screen.getByText("No se pudo leer la corrida nocturna: sin conexión"))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
  });

  it("holds Continuar while a change saves and accepts what the server confirmed", async () => {
    saves.calls = [];
    const onContinue = vi.fn();
    await using screen = await render(
      <EngineStep
        environmentId={EnvironmentId.make("env-1")}
        onContinue={onContinue}
        onBack={null}
      />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Activar la corrida nocturna" }));
    expect(saves.calls.map((call) => call.input)).toEqual([{ enabled: true }]);
    await expect
      .element(screen.getByRole("switch", { name: "Activar la corrida nocturna" }))
      .toBeChecked();
    await expect.element(screen.getByRole("button", { name: "Guardando…" })).toBeDisabled();
    expect(onContinue).not.toHaveBeenCalled();

    answer(0, AsyncResult.success({ ...NIGHTLY_OFF, enabled: true, timeOfDay: "03:00" }));
    await expect.element(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(onContinue).toHaveBeenCalledWith({
      nightlyEnabled: true,
      timeOfDay: "03:00",
      timezone: "America/Guayaquil",
      firstRunStarted: false,
      modelReady: false,
    });
  });

  it("shows a failed save beside the control and does not advance until it saves", async () => {
    saves.calls = [];
    const onContinue = vi.fn();
    await using screen = await render(
      <EngineStep
        environmentId={EnvironmentId.make("env-1")}
        onContinue={onContinue}
        onBack={null}
      />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Activar la corrida nocturna" }));
    answer(0, AsyncResult.fail({ reason: "storage" }));
    await expect
      .element(
        screen.getByText("No se guardó la corrida nocturna: La base editorial no respondió."),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("switch", { name: "Activar la corrida nocturna" }))
      .not.toBeChecked();
    await expect.element(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(saves.calls.map((call) => call.input)).toEqual([{ enabled: true }, { enabled: true }]);
    answer(1, AsyncResult.success({ ...NIGHTLY_OFF, enabled: true }));
    await expect.element(screen.getByRole("button", { name: "Continuar" })).toBeEnabled();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ nightlyEnabled: true }));
  });
});
