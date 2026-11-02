import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { NIGHTLY_OFF, NIGHTLY_ON, RUNNING_JOB } from "../firstRun.fixture";
import { firstRunView } from "../firstRun.logic";
import { EngineStepView, type EngineStepViewProps } from "./EngineStep";

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
});
