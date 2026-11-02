import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { FirstRunPanel, NightlyNote, type FirstRunPanelProps } from "./FirstRunCard";
import { EMPTY_JOB, FAILED_JOB, NIGHTLY_OFF, NIGHTLY_ON, RUNNING_JOB } from "./firstRun.fixture";
import { firstRunView } from "./firstRun.logic";

const renderPanel = async (props: Partial<FirstRunPanelProps>) => {
  const onRun = vi.fn();
  const screen = await render(
    <div style={{ width: 260 }}>
      <FirstRunPanel
        view={{ kind: "idle" }}
        starting={false}
        error={null}
        onRun={onRun}
        runLabel="Ejecutar la primera corrida"
        density="sidebar"
        {...props}
      />
    </div>,
  );
  return { screen, onRun };
};

describe("FirstRunPanel", () => {
  it("starts the first run and shows why one did not start", async () => {
    const { screen, onRun } = await renderPanel({});
    await using _screen = screen;
    await userEvent.click(screen.getByRole("button", { name: "Ejecutar la primera corrida" }));
    expect(onRun).toHaveBeenCalledOnce();
    expect(screen.container.querySelector("ol")).toBeNull();
  });

  it("reports a start that failed", async () => {
    const { screen } = await renderPanel({
      error: "Ninguna fuente está activada para el motor (Ajustes › Editorial › Fuentes).",
    });
    await using _screen = screen;
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "Ninguna fuente está activada para el motor (Ajustes › Editorial › Fuentes).",
      );
  });

  it("holds the button while the model is missing and says why", async () => {
    const { screen, onRun } = await renderPanel({
      blockedReason: "Primero descarga el modelo local de arriba.",
    });
    await using _screen = screen;
    await expect
      .element(screen.getByRole("button", { name: "Ejecutar la primera corrida" }))
      .toBeDisabled();
    await expect
      .element(screen.getByText("Primero descarga el modelo local de arriba."))
      .toBeVisible();
    expect(onRun).not.toHaveBeenCalled();
  });

  it("lists the phases of a running job without a run button", async () => {
    const { screen } = await renderPanel({
      view: firstRunView({ active: RUNNING_JOB, latest: null, emptyRun: false }),
    });
    await using _screen = screen;
    const rows = screen.container.querySelectorAll("li[data-phase]");
    expect(Array.from(rows, (row) => row.getAttribute("data-status"))).toEqual([
      "done",
      "running",
      "pending",
      "pending",
      "pending",
    ]);
    await expect
      .element(screen.getByRole("listitem", { name: "Captura: hecha, 1284 publicaciones · 40 s" }))
      .toBeVisible();
    expect(screen.container.querySelector("button")).toBeNull();
  });

  it("offers a retry for a failed job, with its reason in Spanish", async () => {
    const { screen, onRun } = await renderPanel({
      view: firstRunView({ active: null, latest: FAILED_JOB, emptyRun: false }),
    });
    await using _screen = screen;
    await expect.element(screen.getByRole("alert")).toHaveTextContent("La corrida falló");
    await expect.element(screen.getByText("Falló el motor en la fase de motor.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("explains a run that ended without trends and offers nothing to run again", async () => {
    const { screen } = await renderPanel({
      view: firstRunView({ active: null, latest: EMPTY_JOB, emptyRun: true }),
    });
    await using _screen = screen;
    await expect
      .element(screen.getByText("La corrida terminó sin tendencias nuevas"))
      .toBeVisible();
    expect(screen.container.querySelector("button")).toBeNull();
  });
});

describe("NightlyNote", () => {
  it("links to the settings while the nightly run is off, and names the next run when on", async () => {
    await using off = await render(<NightlyNote settings={NIGHTLY_OFF} />);
    await expect
      .element(off.getByRole("link", { name: "Ajustes › Editorial" }))
      .toHaveAttribute("href", "/settings/editorial#editorial-nightly");
    await using on = await render(<NightlyNote settings={NIGHTLY_ON} />);
    await expect
      .element(on.getByText("Próxima: mar, 3 nov, 03:00 (America/Guayaquil)."))
      .toBeVisible();
  });
});
