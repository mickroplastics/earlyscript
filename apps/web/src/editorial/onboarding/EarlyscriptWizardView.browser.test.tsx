import { EnvironmentId } from "@t3tools/contracts";
import type { ComponentType } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { DataHandlingDialog } from "./DataHandlingDialog";
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
      entry={{ _tag: "resume", position: { index: 0, reached: 0 } }}
      finishedBefore={false}
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
const later = () => page.getByRole("button", { name: "Seguir más tarde" });

describe("EarlyscriptWizardView", () => {
  it("opens on the welcome, then records each step before advancing and finishes after the fourth", async () => {
    const { element, onRecord, onFinish } = setup({ entry: { _tag: "welcome" } });
    await using _screen = await render(element);
    await expect
      .element(
        page.getByRole("heading", { name: "Cada mañana, los temas que se mueven en tu nicho" }),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Empezar" }));
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await expect.element(caption()).toHaveTextContent("Paso 1 de 4");
    await expect.element(stepTitle()).toHaveTextContent("Paso 1 de 4: Tus datos");
    await expect.element(stepTitle()).toHaveFocus();
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «proveedores» en construcción.")).toBeVisible();
    await expect.element(stepTitle()).toHaveTextContent("Paso 2 de 4: Asistente de IA");
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
      .element(page.getByRole("button", { name: "Revisión nocturna, paso 4" }))
      .toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Tus datos, paso 1, hecho" }));
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «proveedores» en construcción.")).toBeVisible();
    expect(onRecord.mock.calls.map(([step]) => step)).toEqual(["datos", "proveedores", "datos"]);
    // The step's own «Atrás» goes back too; the first step gets none.
    await userEvent.click(page.getByRole("button", { name: "Atrás" }));
    await expect.element(page.getByText("Paso «datos» en construcción.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Atrás" })).not.toBeInTheDocument();
  });

  it("opens a step reached before where it was left, and says so until the operator moves", async () => {
    const { element, onRecord } = setup({
      entry: { _tag: "resume", position: { index: 2, reached: 2 } },
    });
    await using _screen = await render(element);
    await expect.element(page.getByText("Paso «estudio» en construcción.")).toBeVisible();
    await expect.element(page.getByText("Seguimos donde lo dejaste.")).toBeVisible();
    await userEvent.click(continueButton());
    await expect.element(page.getByText("Paso «motor» en construcción.")).toBeVisible();
    await expect.element(page.getByText("Seguimos donde lo dejaste.")).not.toBeInTheDocument();
    expect(onRecord.mock.calls.map(([step]) => step)).toEqual(["estudio"]);
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

  it("leaves from the first run with «Seguir más tarde», and only closes once finished before", async () => {
    const first = setup();
    {
      await using _screen = await render(first.element);
      await userEvent.click(later());
      expect(first.onLeave).toHaveBeenCalledOnce();
      expect(first.onRecord).not.toHaveBeenCalled();
    }
    const reopened = setup({ finishedBefore: true });
    await using _screen = await render(reopened.element);
    await expect.element(later()).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Cerrar" }));
    expect(reopened.onLeave).toHaveBeenCalledOnce();
  });

  it("hides «Seguir más tarde» when the step says only forward is left", async () => {
    const Done = ({ onLeaveHidden }: OnboardingStepProps) => (
      <button type="button" onClick={() => onLeaveHidden?.(true)}>
        Terminada
      </button>
    );
    const { element } = setup({ steps: { ...STUB_STEPS, datos: Done } });
    await using _screen = await render(element);
    await expect.element(later()).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Terminada" }));
    await expect.element(later()).not.toBeInTheDocument();
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
    await using _screen = await render(<DataHandlingDialog trigger={<button type="button" />} />);
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
