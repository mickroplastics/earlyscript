import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { FirstRunPageView, type FirstRunPageViewProps } from "./FirstRunCard";
import { EMPTY_JOB, FAILED_JOB, RUNNING_JOB } from "./firstRun.fixture";
import { firstRunView } from "./firstRun.logic";

/** Screenshots only when asked: `VITE_EARLYSCRIPT_CAPTURE=1`. Ignored by Git. */
const capture = async (name: string) => {
  if ((import.meta.env as Record<string, unknown>)["VITE_EARLYSCRIPT_CAPTURE"] !== "1") return;
  document.documentElement.classList.add("dark");
  await page.screenshot({ path: `__screenshots__/${name}.png` });
  document.documentElement.classList.remove("dark");
};

const renderPage = async (props: Partial<FirstRunPageViewProps>) => {
  const onRun = vi.fn();
  const onContinueSetup = vi.fn();
  const screen = await render(
    <div className="mx-auto max-w-xl bg-background p-6">
      <FirstRunPageView
        setup={{ pending: false, reached: 3 }}
        view={{ kind: "idle" }}
        first
        nightly="esta noche a las 03:00"
        starting={false}
        error={null}
        jobsKnown
        modelReady
        waitsForModel={false}
        model={<p>Fila del modelo</p>}
        notes={{ collect: "Hacker News, GitHub", run: "Agrupa en tu equipo, sin enviar nada" }}
        onRun={onRun}
        onContinueSetup={onContinueSetup}
        {...props}
      />
    </div>,
  );
  return { screen, onRun, onContinueSetup };
};

describe("FirstRunPageView", () => {
  it("names what the setup still misses and takes the operator back to it", async () => {
    const { screen, onContinueSetup } = await renderPage({ setup: { pending: true, reached: 2 } });
    await using _screen = screen;
    await expect.element(page.getByText("Faltan tu canal y la revisión nocturna.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Continuar" }));
    expect(onContinueSetup).toHaveBeenCalledOnce();
  });

  it("waits for the model when the wizard left the first review to its download", async () => {
    const { screen, onRun } = await renderPage({ modelReady: false, waitsForModel: true });
    await using _screen = screen;
    await expect
      .element(
        page.getByText(
          "La primera revisión empieza sola al terminar de descargar el modelo local.",
        ),
      )
      .toBeVisible();
    await expect.element(page.getByText("Fila del modelo")).toBeVisible();
    expect(page.getByRole("button", { name: "Buscar ahora" }).elements()).toHaveLength(0);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("offers the first review once the model is there", async () => {
    const { screen, onRun } = await renderPage({});
    await using _screen = screen;
    await expect
      .element(
        page.getByText(
          "Busca las primeras ahora o espera a la revisión de esta noche a las 03:00.",
        ),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Buscar ahora" }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("follows the first review with the same five phases", async () => {
    const { screen } = await renderPage({
      view: firstRunView({ active: RUNNING_JOB, latest: null, emptyRun: false }),
    });
    await using _screen = screen;
    await expect
      .element(page.getByRole("heading", { name: "Buscando tus primeras tendencias" }))
      .toBeVisible();
    await expect.element(page.getByText("Hacker News, GitHub")).toBeVisible();
    await expect
      .element(page.getByRole("listitem", { name: /^Encuentra tendencias: en curso/ }))
      .toBeVisible();
    expect(page.getByRole("button").elements()).toHaveLength(0);
    await capture("bandeja-en-curso");
  });

  it("says where a failed first review stopped, retries it and folds the technical detail", async () => {
    const { screen, onRun } = await renderPage({
      view: firstRunView({ active: null, latest: FAILED_JOB, emptyRun: false }),
    });
    await using _screen = screen;
    await expect
      .element(page.getByRole("heading", { name: "La primera revisión no terminó" }))
      .toBeVisible();
    await expect
      .element(page.getByText("No se pudieron agrupar las publicaciones. Lo leído quedó guardado."))
      .toBeVisible();
    await expect
      .element(page.getByText("Si no, se reintenta esta noche a las 03:00."))
      .toBeVisible();
    expect(page.getByText("engine run exited with 1").elements()).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Detalle técnico" }));
    await expect.element(page.getByText("engine run exited with 1")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Reintentar" }));
    expect(onRun).toHaveBeenCalledOnce();
    await capture("bandeja-fallida");
  });

  it("explains a review that ended without trends", async () => {
    const { screen } = await renderPage({
      first: false,
      view: firstRunView({ active: null, latest: EMPTY_JOB, emptyRun: true }),
    });
    await using _screen = screen;
    await expect
      .element(page.getByRole("heading", { name: "La revisión terminó sin tendencias nuevas" }))
      .toBeVisible();
    await expect
      .element(page.getByText(/La revisión no encontró ninguna tendencia en 1284 publicaciones/))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Buscar de nuevo" }).elements()).toHaveLength(0);
  });
});
