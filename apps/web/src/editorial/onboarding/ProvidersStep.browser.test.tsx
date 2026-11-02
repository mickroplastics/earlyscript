import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import {
  notInstalled,
  providerFixture,
  SETTINGS_FIXTURE,
  signedOut,
} from "./providersStep.fixture";
import {
  commitProvidersChoice,
  ProvidersStepView,
  type ProvidersStepViewProps,
} from "./ProvidersStep";

const HAIKU = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };

const renderStep = (props: Partial<ProvidersStepViewProps>) => {
  const onContinue = vi.fn();
  const onRecheck = vi.fn();
  const onRetryBudget = vi.fn();
  return {
    onContinue,
    onRecheck,
    onRetryBudget,
    screen: render(
      <ProvidersStepView
        providers={[providerFixture("claudeAgent"), providerFixture("codex", signedOut)]}
        settings={SETTINGS_FIXTURE}
        os="linux"
        budget={{ monthlyLimit: 600, usedThisMonth: 12, month: "2026-11" }}
        budgetError={null}
        onRetryBudget={onRetryBudget}
        checking={false}
        saving={false}
        error={null}
        onRecheck={onRecheck}
        onBack={null}
        onContinue={onContinue}
        {...props}
      />,
    ),
  };
};

describe("ProvidersStepView", () => {
  it("proposes Haiku, keeps the saved cap and hands both to the shell", async () => {
    const { screen: rendered, onContinue } = renderStep({});
    await using screen = await rendered;
    await expect.element(screen.getByText("Claude Haiku 5.5 · Claude")).toBeVisible();
    await expect.element(screen.getByText(/^Este mes: 12 de 600 redacciones/)).toBeVisible();
    // No zeros where the provider reports nothing.
    await expect
      .element(screen.getByText("Tokens: el proveedor no informa el consumo."))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Continuar", exact: true }));
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({ draftingModel: HAIKU, monthlyDraftLimit: 600 }),
    );
    expect(onContinue.mock.calls[0]?.[0].rows.map((row: { key: string }) => row.key)).toEqual([
      "claudeAgent",
      "codex",
    ]);
  });

  it("warns when the saved model's provider is disabled and proposes the recommended one", async () => {
    const { screen: rendered, onContinue } = renderStep({
      providers: [
        providerFixture("claudeAgent"),
        providerFixture("codex", { enabled: false, status: "disabled" }),
      ],
    });
    await using screen = await rendered;
    await expect
      .element(
        screen.getByText(/^El modelo guardado, GPT-6-Luna · Codex, es de un proveedor desactivado/),
      )
      .toBeVisible();
    await expect.element(screen.getByText("Claude Haiku 5.5 · Claude")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Continuar", exact: true }));
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ draftingModel: HAIKU }));
  });

  it("lets the operator go on without a provider, saying what still works", async () => {
    const { screen: rendered, onContinue } = renderStep({
      providers: [
        providerFixture("claudeAgent", signedOut),
        providerFixture("codex", notInstalled),
      ],
    });
    await using screen = await rendered;
    await expect.element(screen.getByText("Ningún proveedor tiene sesión iniciada")).toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "Modelo de redacción" }))
      .toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Continuar sin proveedor" }));
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({ draftingModel: null, monthlyDraftLimit: 600 }),
    );
  });

  it("shows the exact sign-in command instead of a terminal, and checks again", async () => {
    const { screen: rendered, onRecheck } = renderStep({});
    await using screen = await rendered;
    await userEvent.click(screen.getByRole("button", { name: "Iniciar sesión" }));
    const dialog = page.getByRole("dialog", { name: "Iniciar sesión en Codex" });
    await expect.element(dialog.getByText("codex login", { exact: true })).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Volver a comprobar" }));
    expect(onRecheck).toHaveBeenCalledOnce();
  });

  it("decides nothing while the server has not listed its providers", async () => {
    const { screen: rendered } = renderStep({ providers: null });
    await using screen = await rendered;
    await expect.element(screen.getByText("Comprobando proveedores…")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Continuar", exact: true }))
      .toBeDisabled();
  });

  it("waits for the saved cap instead of proposing the default over it", async () => {
    const { screen: rendered, onContinue } = renderStep({ budget: null });
    await using screen = await rendered;
    await expect.element(screen.getByText("Cargando el tope…")).toBeVisible();
    const proceed = screen.getByRole("button", { name: "Continuar", exact: true });
    await expect.element(proceed).toBeDisabled();
    await userEvent.click(proceed, { force: true });
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("says the cap could not be read, retries, and leaves it unwritten on continue", async () => {
    const {
      screen: rendered,
      onContinue,
      onRetryBudget,
    } = renderStep({
      budget: null,
      budgetError: "La base editorial no respondió.",
    });
    await using screen = await rendered;
    await expect.element(screen.getByText("No se pudo leer el tope mensual")).toBeVisible();
    await expect.element(screen.getByText(/^La base editorial no respondió\./)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onRetryBudget).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Continuar", exact: true }));
    expect(onContinue).toHaveBeenCalledWith(
      expect.objectContaining({ draftingModel: HAIKU, monthlyDraftLimit: null }),
    );

    const saveLimit = vi.fn(async () => null);
    const saved = await commitProvidersChoice(onContinue.mock.calls[0]![0], {
      saveModel: async () => null,
      saveLimit,
    });
    expect(saveLimit).not.toHaveBeenCalled();
    expect(saved).toMatchObject({ ok: true, acceptance: { monthlyDraftLimit: null } });
  });

  it("refuses a cap that is not a whole number and accepts 0 as no cap", async () => {
    const { screen: rendered, onContinue } = renderStep({});
    await using screen = await rendered;
    const input = screen.getByRole("spinbutton", { name: "Tope mensual de redacciones" });
    await userEvent.fill(input, "-3");
    await expect
      .element(screen.getByText("Escribe un número entero; 0 quita el tope."))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Continuar", exact: true }))
      .toBeDisabled();
    await userEvent.fill(input, "0");
    await userEvent.click(screen.getByRole("button", { name: "Continuar", exact: true }));
    expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({ monthlyDraftLimit: 0 }));
  });
});
