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
        onModelChange={vi.fn()}
        onLimitChange={onLimitChange}
      />,
    );
    await expect.element(screen.getByText(/^Tope alcanzado: 600 de 600 este mes/)).toBeVisible();
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
        onModelChange={vi.fn()}
        onLimitChange={vi.fn()}
      />,
    );
    await expect.element(screen.getByText(/^Ningún proveedor tiene sesión iniciada/)).toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "Modelo de redacción" }))
      .toBeDisabled();
  });
});
