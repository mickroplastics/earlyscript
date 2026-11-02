import type { EditorialProfileVersion, EditorialProfileView } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Dialog } from "../../components/ui/dialog";
import { WizardHeader, WizardPanel, WizardPopup, WizardSteps } from "../../components/ui/wizard";
import { useProfileForm, type ProfileSaveDraft } from "../profile/useProfileEditor";
import {
  StudioProfileSettingsView,
  type StudioProfileSettingsViewProps,
} from "../settings/StudioProfileSettings";
import { StudioStepView, type StudioAcceptance } from "./StudioStep";
import { ONBOARDING_STAGES } from "./steps";

const V1: EditorialProfileVersion = {
  version: 1,
  name: "SingulariDev",
  audience:
    "Solo founders and developers building products with AI agents and automation, in English",
  include: [
    "AI coding agents and agent harnesses for developers",
    "local and open-weight language models running on personal hardware",
    "automation of software and content workflows with LLM tools",
    "developer tooling, SDKs and protocols for building AI products",
    "one-person startups shipping AI products",
  ],
  exclude: [
    "consumer gadget reviews and smartphone launches",
    "cryptocurrency prices and token trading",
    "politics, elections and legislation without a developer angle",
    "video game releases and esports",
  ],
  hash: "sha256:db510e303cb7f3cff7099230a00d36b1918f28a0e6aa6b8be01727649b8bb80d",
  createdAt: "2026-11-02T18:00:00.000Z",
  origin: "earlywindow",
  active: true,
};

const VIEW: EditorialProfileView = {
  active: V1,
  scoring: {
    configVersion: "earlyscript.engine.v1",
    parameters: [
      { key: "profile.include_min", value: 0.6 },
      { key: "profile.exclude_max", value: 0.6 },
      { key: "cluster.threshold", value: 0.7 },
      { key: "stage.growth_min", value: 0.69 },
      { key: "stage.fading_max", value: -0.69 },
      { key: "stage.growing_min_items_7d", value: 3 },
      { key: "rank.weighted.weights.growth", value: 0.5 },
      { key: "rank.weighted.weights.log_authors_7d", value: 0.2 },
      { key: "rank.weighted.weights.include_score", value: 0.3 },
      { key: "emit.max_dossiers", value: 20 },
    ],
  },
};

const V2: EditorialProfileVersion = {
  ...V1,
  version: 2,
  origin: "operator",
  hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  createdAt: "2026-11-02T19:05:00.000Z",
};

const FORM_ID = "studio";

/** Screenshots only when asked: `VITE_EARLYSCRIPT_CAPTURE=1`. Ignored by Git. */
const capture = async (name: string) => {
  if ((import.meta.env as Record<string, unknown>)["VITE_EARLYSCRIPT_CAPTURE"] !== "1") return;
  document.body.classList.add("bg-background");
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.screenshot({ path: `__screenshots__/studio/${name}-${theme}.png` });
  }
  document.documentElement.classList.remove("dark");
  document.body.classList.remove("bg-background");
};

function StepHarness({
  view,
  saveDraft,
  onContinue,
  canEdit,
}: {
  readonly view: EditorialProfileView | null;
  readonly saveDraft: ProfileSaveDraft;
  readonly onContinue: (acceptance: StudioAcceptance) => void;
  readonly canEdit: boolean;
}) {
  const editor = useProfileForm({
    view,
    loadError: null,
    retry: () => {},
    saveDraft,
    formId: FORM_ID,
    canEdit,
  });
  // The wizard's own dialog, as `EarlyscriptWizardView` mounts the steps.
  return (
    <Dialog open disablePointerDismissal>
      <WizardPopup size="wide" bottomStickOnMobile={false}>
        <WizardHeader title="Configurar Earlyscript">
          <WizardSteps
            steps={ONBOARDING_STAGES.map((stage) => stage.label)}
            currentStep={ONBOARDING_STAGES.findIndex((stage) => stage.id === "estudio")}
          />
        </WizardHeader>
        <WizardPanel>
          <StudioStepView
            editor={editor}
            formId={FORM_ID}
            onBack={() => {}}
            onContinue={onContinue}
          />
        </WizardPanel>
      </WizardPopup>
    </Dialog>
  );
}

/** Every scrollable ancestor of `element`, by its `data-slot`. */
const scrollableAncestors = (element: Element): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") found.push(node.dataset.slot ?? node.tagName);
  }
  return found;
};

/** Scrolls the dialog's single scroll to its end and checks the step's buttons are in view. */
async function scrollDialogToBottom() {
  const viewport = document.querySelector<HTMLElement>(
    "[role=dialog] [data-slot=scroll-area-viewport]",
  );
  if (!viewport) throw new Error("wizard scroll area not found");
  const button = page.getByRole("button", { name: /Continuar/ }).element();
  // WizardPanel animates its height, so this retries until the last control is inside.
  await vi.waitFor(() => {
    viewport.scrollTop = viewport.scrollHeight;
    expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().bottom,
    );
  });
}

const renderStep = async (
  options: {
    readonly view?: EditorialProfileView | null;
    readonly saveDraft?: ProfileSaveDraft;
    readonly canEdit?: boolean;
  } = {},
) => {
  const onContinue = vi.fn<(acceptance: StudioAcceptance) => void>();
  const saveDraft =
    options.saveDraft ??
    vi.fn<ProfileSaveDraft>(async (draft) => ({ _tag: "ok", active: { ...V2, ...draft } }));
  const screen = await render(
    <StepHarness
      view={options.view === undefined ? VIEW : options.view}
      saveDraft={saveDraft}
      onContinue={onContinue}
      canEdit={options.canEdit ?? true}
    />,
    { router: false },
  );
  return { screen, onContinue, saveDraft };
};

const field = (label: string) => page.getByLabelText(label, { exact: true });

describe.each([
  ["desktop", 1280, 800],
  ["mobile", 390, 844],
] as const)("StudioStep at %s", (size, width, height) => {
  it("starts from Earlywindow's version and continues without saving when unchanged", async () => {
    await page.viewport(width, height);
    const { screen, onContinue, saveDraft } = await renderStep();
    await using _screen = screen;
    await expect
      .element(page.getByTestId("profile-version"))
      .toHaveTextContent("Versión 1, de Earlywindow");
    await expect.element(field("Temas que cubre: tema 1")).toHaveValue(V1.include[0]!);
    await expect.element(field("Temas que cubre: tema 5")).toHaveValue(V1.include[4]!);
    await expect.element(field("Temas que cubre: tema nuevo")).toHaveValue("");
    await expect.element(page.getByText("5 temas")).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    // One scroll for the whole dialog: neither the step nor the topic list scrolls on its own.
    const topics = page.getByRole("list", { name: "Temas que cubre" }).element();
    expect(scrollableAncestors(topics)).toEqual(["scroll-area-viewport"]);
    expect(
      page
        .getByTestId("studio-step")
        .element()
        .querySelectorAll("[data-slot=scroll-area-viewport]"),
    ).toHaveLength(0);
    await capture(`step-ready-${size}`);
    await userEvent.click(page.getByRole("button", { name: /Pesos de la puntuación/ }));
    await expect.element(page.getByText("Afinidad mínima con los temas")).toBeVisible();
    await expect
      .element(page.getByText(/Se ajustan en Ajustes › Editorial tras el análisis/))
      .toBeVisible();
    await scrollDialogToBottom();
    await capture(`step-scoring-${size}`);
    await userEvent.click(page.getByRole("button", { name: "Continuar" }));
    expect(saveDraft).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledWith({ profileVersion: 1, profileHash: V1.hash });
  });

  it("explains each missing field in Spanish and focuses the first", async () => {
    await page.viewport(width, height);
    const { screen, onContinue, saveDraft } = await renderStep();
    await using _screen = screen;
    await userEvent.clear(field("Nombre del canal"));
    await userEvent.clear(field("Audiencia"));
    for (const topic of V1.include) {
      await userEvent.click(page.getByRole("button", { name: `Quitar «${topic}»` }));
    }
    await expect.element(page.getByText("0 temas")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Guardar y continuar" }));
    await expect.element(page.getByText("Escribe el nombre del canal.")).toBeVisible();
    await expect.element(page.getByText("Describe la audiencia en una frase.")).toBeVisible();
    await expect
      .element(page.getByText("Escribe al menos un tema que cubre el canal."))
      .toBeInTheDocument();
    await expect.element(field("Nombre del canal")).toHaveFocus();
    await expect.element(field("Nombre del canal")).toHaveAttribute("aria-invalid", "true");
    expect(saveDraft).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await capture(`step-error-${size}`);
    // Fixing a field clears its message as the operator types.
    await userEvent.type(field("Nombre del canal"), "SingulariDev");
    await expect.element(page.getByText("Escribe el nombre del canal.")).not.toBeInTheDocument();
  });
});

describe("StudioStep", () => {
  it("saves a changed profile as a new version and hands its hash to the shell", async () => {
    await page.viewport(1280, 800);
    const { screen, onContinue, saveDraft } = await renderStep();
    await using _screen = screen;
    await userEvent.type(field("Temas que cubre: tema nuevo"), "  evaluation of LLM apps  ");
    await expect.element(page.getByText("6 temas")).toBeVisible();
    // Enter opens the next row with the cursor in it; pasted lines become one topic each.
    await userEvent.keyboard("{Enter}");
    await expect.element(field("Temas que cubre: tema nuevo")).toHaveFocus();
    await userEvent.fill(field("Temas que cubre: tema nuevo"), "AI evals\n\nprompt caching\n");
    await expect.element(page.getByText("8 temas")).toBeVisible();
    await expect.element(field("Temas que cubre: tema 8")).toHaveValue("prompt caching");
    // Backspace on an emptied topic removes it and returns to the one above.
    await userEvent.clear(field("Temas que cubre: tema 8"));
    await userEvent.keyboard("{Backspace}");
    await expect.element(field("Temas que cubre: tema 7")).toHaveFocus();
    await expect.element(page.getByText("7 temas")).toBeVisible();
    await expect.element(page.getByText("· con cambios sin guardar")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Guardar y continuar" }));
    await vi.waitFor(() => expect(onContinue).toHaveBeenCalled());
    expect(saveDraft).toHaveBeenCalledWith({
      name: V1.name,
      audience: V1.audience,
      include: [...V1.include, "evaluation of LLM apps", "AI evals"],
      exclude: V1.exclude,
    });
    expect(onContinue).toHaveBeenCalledWith({ profileVersion: 2, profileHash: V2.hash });
  });

  it("shows the server's validation under its field and a storage failure above the buttons", async () => {
    await page.viewport(1280, 800);
    const saveDraft = vi
      .fn<ProfileSaveDraft>()
      .mockResolvedValueOnce({
        _tag: "error",
        error: {
          _tag: "EditorialProfileError",
          reason: "invalid-profile",
          issues: [{ field: "exclude", code: "too-many" }],
        },
      })
      .mockResolvedValueOnce({
        _tag: "error",
        error: { _tag: "EditorialProfileError", reason: "storage", message: "disk" },
      });
    const { screen, onContinue } = await renderStep({ saveDraft });
    await using _screen = screen;
    await userEvent.type(field("Temas que deja fuera: tema nuevo"), "sports");
    await userEvent.click(page.getByRole("button", { name: "Guardar y continuar" }));
    await expect.element(page.getByText("Caben hasta 30 temas.")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Guardar y continuar" }));
    await expect
      .element(page.getByText("La base editorial no respondió; el perfil no se guardó."))
      .toBeVisible();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("shows a read-only session the profile without letting it edit, and still continues", async () => {
    await page.viewport(390, 844);
    const { screen, onContinue, saveDraft } = await renderStep({ canEdit: false });
    await using _screen = screen;
    await expect
      .element(page.getByText("Solo lectura: tu sesión no puede cambiar el perfil."))
      .toBeVisible();
    await expect.element(field("Nombre del canal")).toBeDisabled();
    await expect.element(field("Audiencia")).toBeDisabled();
    await expect.element(field("Temas que cubre: tema nuevo")).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: `Quitar «${V1.include[0]}»` }))
      .toBeDisabled();
    await capture("step-readonly-mobile");
    await userEvent.click(page.getByRole("button", { name: "Continuar" }));
    expect(saveDraft).not.toHaveBeenCalled();
    expect(onContinue).toHaveBeenCalledWith({ profileVersion: 1, profileHash: V1.hash });
  });

  it("waits for the profile before offering to continue", async () => {
    for (const [size, width, height] of [
      ["desktop", 1280, 800],
      ["mobile", 390, 844],
    ] as const) {
      await page.viewport(width, height);
      const { screen } = await renderStep({ view: null });
      await using _screen = screen;
      await expect.element(page.getByText("Leyendo el perfil del estudio…")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Continuar" })).toBeDisabled();
      await capture(`step-loading-${size}`);
    }
  });
});

function SettingsHarness(
  props: Omit<StudioProfileSettingsViewProps, "editor" | "formId" | "onSave">,
) {
  const [view, setView] = useState<EditorialProfileView>(VIEW);
  const editor = useProfileForm({
    view,
    loadError: null,
    retry: () => {},
    formId: FORM_ID,
    canEdit: true,
    saveDraft: async (draft) => {
      const active = { ...V2, ...draft };
      setView({ ...view, active });
      return { _tag: "ok", active };
    },
  });
  return (
    <div className="min-h-screen bg-background p-4 text-foreground sm:p-8">
      <StudioProfileSettingsView
        {...props}
        editor={editor}
        formId={FORM_ID}
        onSave={() => void editor.save()}
      />
    </div>
  );
}

describe.each([
  ["desktop", 1280, 800],
  ["mobile", 390, 844],
] as const)("Settings › Editorial › Perfil del estudio at %s", (size, width, height) => {
  it("saves only an edited profile and lists the versions", async () => {
    await page.viewport(width, height);
    await using _screen = await render(
      <SettingsHarness
        history={[
          { ...V2, active: true },
          { ...V1, active: false },
        ]}
      />,
      { router: false },
    );
    const save = page.getByRole("button", { name: "Guardar versión 2" });
    await expect.element(save).toBeDisabled();
    await expect.element(page.getByText("Versión 1, de Earlywindow").first()).toBeVisible();
    await expect.element(page.getByText("Activa")).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await capture(`settings-${size}`);
    await userEvent.fill(field("Nombre del canal"), "SingulariDev Labs");
    await expect.element(save).toBeEnabled();
    await userEvent.click(save);
    await expect.element(page.getByRole("button", { name: "Guardar versión 3" })).toBeDisabled();
    await expect.element(field("Nombre del canal")).toHaveValue("SingulariDev Labs");
  });
});
