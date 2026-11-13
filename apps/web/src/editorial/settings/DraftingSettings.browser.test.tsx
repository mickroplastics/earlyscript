import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { providerFixture, signedOut } from "../onboarding/providersStep.fixture";
import { DraftingSettingsView } from "./DraftingSettings";

const HAIKU = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-haiku-5-5" };

describe("DraftingSettingsView", () => {
  it("saves a new cap on Enter, ignores one out of range and says when the cap is reached", async () => {
    const onLimitChange = vi.fn();
    await using screen = await render(
      <DraftingSettingsView
        providers={[providerFixture("claudeAgent")]}
        selection={HAIKU}
        budget={{ monthlyLimit: 600, usedThisMonth: 600, month: "2026-11" }}
        budgetError={null}
        modelFailure={null}
        limitFailure={null}
        onModelChange={vi.fn()}
        onLimitChange={onLimitChange}
      />,
    );
    await expect
      .element(screen.getByText(/^Tope alcanzado: 600 de 600\. Se reanuda el 1 de diciembre/))
      .toBeVisible();
    const input = screen.getByRole("spinbutton", { name: "Tope mensual de redacciones" });
    await userEvent.fill(input, "100001");
    await userEvent.keyboard("{Enter}");
    expect(onLimitChange).not.toHaveBeenCalled();
    await expect.element(input).toHaveValue(600);
    await userEvent.fill(input, "900");
    await userEvent.keyboard("{Enter}");
    expect(onLimitChange).toHaveBeenCalledWith(900);
  });

  it("points to Settings › Providers when no provider can draft", async () => {
    await using screen = await render(
      <DraftingSettingsView
        providers={[providerFixture("claudeAgent", signedOut)]}
        selection={HAIKU}
        budget={{ monthlyLimit: 600, usedThisMonth: 0, month: "2026-11" }}
        budgetError={null}
        modelFailure={null}
        limitFailure={null}
        onModelChange={vi.fn()}
        onLimitChange={vi.fn()}
      />,
    );
    await expect.element(screen.getByText(/^Ningún proveedor tiene sesión iniciada/)).toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "Modelo de redacción" }))
      .toBeDisabled();
  });

  it("says beside the cap that a save failed, keeps the saved cap and retries the same value", async () => {
    const onLimitChange = vi.fn();
    await using screen = await render(
      <DraftingSettingsView
        providers={[providerFixture("claudeAgent")]}
        selection={HAIKU}
        budget={{ monthlyLimit: 400, usedThisMonth: 212, month: "2026-11" }}
        budgetError={null}
        modelFailure={null}
        limitFailure={{ value: 900, message: "La base editorial no respondió." }}
        onModelChange={vi.fn()}
        onLimitChange={onLimitChange}
      />,
    );
    await expect
      .element(screen.getByText("212 de 400 este mes · se reinicia el 1 de diciembre"))
      .toBeVisible();
    await expect
      .element(screen.getByRole("alert"))
      .toMatchTextContent(/No se guardó.*Sigue el tope de 400\./);
    await expect
      .element(screen.getByRole("spinbutton", { name: "Tope mensual de redacciones" }))
      .toHaveAttribute("aria-invalid", "true");
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onLimitChange).toHaveBeenCalledExactlyOnceWith(900);
  });
});
