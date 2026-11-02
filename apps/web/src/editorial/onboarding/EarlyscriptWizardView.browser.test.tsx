import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { PrivacyNote } from "./DataHandlingDialog";
import { EarlyscriptWizardView, type EarlyscriptWizardViewProps } from "./EarlyscriptWizardView";

/** Screenshots only when asked: `VITE_EARLYSCRIPT_CAPTURE=1`. Ignored by Git. */
const CAPTURE = (import.meta.env as Record<string, unknown>)["VITE_EARLYSCRIPT_CAPTURE"] === "1";
const capture = async (name: string) => {
  if (CAPTURE) await page.screenshot({ path: `__screenshots__/${name}.png` });
};

const ENVIRONMENT_ID = EnvironmentId.make("env-1");

const setup = (props: Partial<EarlyscriptWizardViewProps> = {}) => {
  const onRecord = vi.fn<EarlyscriptWizardViewProps["onRecord"]>(async () => ({ ok: true }));
  const onFinish = vi.fn(async () => true);
  const onLeave = vi.fn();
  const element = (
    <EarlyscriptWizardView
      environmentId={ENVIRONMENT_ID}
      dismissible={false}
      onRecord={onRecord}
      onFinish={onFinish}
      onLeave={onLeave}
      {...props}
    />
  );
  return { element, onRecord, onFinish, onLeave };
};

const continueButton = () => page.getByRole("button", { name: "Continuar" });
const caption = () => page.getByTestId("wizard-step-caption");

describe("EarlyscriptWizardView", () => {
  it("records each step before advancing and finishes after the fourth", async () => {
    const { element, onRecord, onFinish } = setup();
    await using _screen = await render(element);
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await expect.element(caption()).toHaveTextContent("Paso 1 de 4: Datos y permisos");
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «proveedores» en construcción.")).toBeVisible();
    await expect.element(caption()).toHaveTextContent("Paso 2 de 4: Proveedores");
    await userEvent.click(continueButton());
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «motor» en construcción.")).toBeVisible();
    expect(onFinish).not.toHaveBeenCalled();
    await userEvent.click(continueButton());
    await vi.waitFor(() => expect(onFinish).toHaveBeenCalledOnce());
    expect(onRecord.mock.calls.map(([step]) => step)).toEqual([
      "datos",
      "proveedores",
      "estudio",
      "motor",
    ]);
    expect(onRecord.mock.calls[0]![1]).toEqual({ placeholder: true });
  });

  it("goes back from the header to a step already reached, and records it again", async () => {
    const { element, onRecord } = setup();
    await using _screen = await render(element);
    await userEvent.click(continueButton());
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «estudio» en construcción.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Motor y nocturna, paso 4" }))
      .toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: /^Datos y permisos, paso 1/ }));
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «proveedores» en construcción.")).toBeVisible();
    expect(onRecord.mock.calls.map(([step]) => step)).toEqual(["datos", "proveedores", "datos"]);
  });

  it("stays on the step and says so when the decision is not recorded", async () => {
    const { element } = setup({
      onRecord: async () => ({ ok: false, error: "La base editorial no respondió." }),
    });
    await using _screen = await render(element);
    await userEvent.click(continueButton());
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "No se guardó tu decisión: La base editorial no respondió. Vuelve a intentarlo.",
      );
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await capture("wizard-error");
  });

  it("has no close button on the first run and one that leaves when reopened", async () => {
    const first = setup();
    {
      await using _screen = await render(first.element);
      await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Cerrar" })).not.toBeInTheDocument();
    }
    const reopened = setup({ dismissible: true });
    await using _screen = await render(reopened.element);
    await userEvent.click(page.getByRole("button", { name: "Cerrar" }));
    expect(reopened.onLeave).toHaveBeenCalledOnce();
    expect(reopened.onRecord).not.toHaveBeenCalled();
  });

  it("lets the operator in without a local server", async () => {
    const { element, onLeave } = setup({ environmentId: null });
    await using _screen = await render(element);
    await expect
      .element(page.getByText("Este navegador no está conectado al servidor local de Earlyscript."))
      .toBeVisible();
    await capture("wizard-sin-servidor");
    await userEvent.click(page.getByRole("button", { name: "Entrar sin configurar" }));
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("names every close button of the data dialog in Spanish", async () => {
    await using _screen = await render(<PrivacyNote />);
    await userEvent.click(page.getByRole("button", { name: "Cómo se tratan tus datos" }));
    const dialog = page.getByRole("dialog", { name: "Cómo se tratan tus datos" });
    await expect.element(dialog).toBeVisible();
    expect(dialog.getByRole("button", { name: "Cerrar", exact: true }).elements()).toHaveLength(2);
    await expect
      .element(page.getByRole("button", { name: "Close", exact: true }))
      .not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Cerrar", exact: true }).first());
    await expect.element(dialog).not.toBeInTheDocument();
  });
});

// The capture matrix renders sixteen screens; it runs only when asked, apart from the checks above.
if (CAPTURE) {
  describe("EarlyscriptWizardView captures", () => {
    it("captures the four steps in both themes and two sizes", async () => {
      for (const theme of ["light", "dark"] as const) {
        document.documentElement.classList.toggle("dark", theme === "dark");
        for (const [width, height] of [
          [1280, 800],
          [390, 844],
        ] as const) {
          await page.viewport(width, height);
          const { element } = setup();
          await using _screen = await render(element);
          for (const [step, label] of [
            [1, "Datos y permisos"],
            [2, "Proveedores"],
            [3, "Estudio"],
            [4, "Motor y nocturna"],
          ] as const) {
            await expect.element(caption()).toHaveTextContent(`Paso ${step} de 4: ${label}`);
            await page.screenshot({
              path: `__screenshots__/wizard-${theme}-${width}-paso${step}.png`,
            });
            if (step < 4) await userEvent.click(continueButton());
          }
        }
      }
      document.documentElement.classList.remove("dark");
    });
  });
}
