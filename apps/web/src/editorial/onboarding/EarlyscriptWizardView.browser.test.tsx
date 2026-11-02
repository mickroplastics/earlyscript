import { EnvironmentId } from "@t3tools/contracts";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { PrivacyNote } from "./DataHandlingDialog";
import {
  EarlyscriptWizardView,
  type EarlyscriptWizardViewProps,
  type OnboardingStepComponents,
} from "./EarlyscriptWizardView";
import type { OnboardingStepId, OnboardingStepProps } from "./steps";

/** Screenshots only when asked: `VITE_EARLYSCRIPT_CAPTURE=1`. Ignored by Git. */
const CAPTURE = (import.meta.env as Record<string, unknown>)["VITE_EARLYSCRIPT_CAPTURE"] === "1";
const capture = async (name: string) => {
  if (CAPTURE) await page.screenshot({ path: `__screenshots__/${name}.png` });
};

const ENVIRONMENT_ID = EnvironmentId.make("env-1");

/** The shell's tests drive doubles; each real step has its own browser test. */
const stubStep = (id: OnboardingStepId): ComponentType<OnboardingStepProps> =>
  function StubStep({ onContinue, onBack }: OnboardingStepProps) {
    return (
      <div className="flex flex-col gap-4">
        <p>Paso «{id}» en construcción.</p>
        <div className="flex justify-end gap-2">
          {onBack === null ? null : (
            <button type="button" onClick={onBack}>
              Atrás
            </button>
          )}
          <button type="button" onClick={() => onContinue({ step: id, accepted: true })}>
            Continuar
          </button>
        </div>
      </div>
    );
  };

const STUB_STEPS: OnboardingStepComponents = {
  datos: stubStep("datos"),
  proveedores: stubStep("proveedores"),
  estudio: stubStep("estudio"),
  motor: stubStep("motor"),
};

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
      steps={STUB_STEPS}
      {...props}
    />
  );
  return { element, onRecord, onFinish, onLeave };
};

const continueButton = () => page.getByRole("button", { name: "Continuar" });
const caption = () => page.getByTestId("wizard-step-caption");
const stepTitle = () => page.getByTestId("wizard-step-title");
const privacyLink = () => page.getByRole("button", { name: "Cómo se tratan tus datos" });

describe("EarlyscriptWizardView", () => {
  it("records each step before advancing and finishes after the fourth", async () => {
    const { element, onRecord, onFinish } = setup();
    await using _screen = await render(element);
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await expect.element(caption()).toHaveTextContent("Paso 1 de 4: Datos y permisos");
    await expect.element(stepTitle()).toHaveFocus();
    // The data step explains how data is handled in full; the shell's line starts at step 2.
    await expect.element(privacyLink()).not.toBeInTheDocument();
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «proveedores» en construcción.")).toBeVisible();
    await expect.element(privacyLink()).toBeVisible();
    await expect.element(caption()).toHaveTextContent("Paso 2 de 4: Proveedores");
    await expect.element(stepTitle()).toHaveTextContent("Paso 2 de 4: Proveedores");
    await expect.element(stepTitle()).toHaveFocus();
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
    expect(onRecord.mock.calls.map(([, acceptance]) => acceptance)).toEqual([
      { step: "datos", accepted: true },
      { step: "proveedores", accepted: true },
      { step: "estudio", accepted: true },
      { step: "motor", accepted: true },
    ]);
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
    // The step's own «Atrás» goes back too; the first step gets none.
    await userEvent.click(page.getByRole("button", { name: "Atrás" }));
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Atrás" })).not.toBeInTheDocument();
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
