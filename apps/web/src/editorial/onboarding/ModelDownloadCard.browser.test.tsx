import type { EditorialModelState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { modelIsReady } from "../engineState";
import { ModelDownloadCardView, type ModelDownloadCardViewProps } from "./ModelDownloadCard";

const MiB = 1024 * 1024;
const TOTAL = 624_963_256;

const base: EditorialModelState = {
  status: "missing",
  revision: "c25a394dd583836952667c12f008335071b3f43d",
  path: "/home/miguel/earlyscript-data/models/c25a394dd583836952667c12f008335071b3f43d",
  location: "~/earlyscript-data/models",
  bytesPresent: 0,
  bytesExpected: TOTAL,
  download: null,
  error: null,
};

const STATES: Record<string, EditorialModelState | null> = {
  checking: null,
  missing: base,
  downloading: {
    ...base,
    status: "partial",
    bytesPresent: 213 * MiB,
    download: {
      startedAt: "2026-11-02T18:00:00.000Z",
      file: "onnx/model_quantized.onnx",
      bytesDone: 213 * MiB,
      bytesTotal: TOTAL,
      bytesPerSecond: 12.4 * MiB,
    },
  },
  error: {
    ...base,
    status: "partial",
    bytesPresent: 213 * MiB,
    error: { code: "network", message: "fetch failed: other side closed" },
  },
  ready: { ...base, status: "ready", bytesPresent: TOTAL },
};

const SIZES = [
  ["escritorio", 1280, 800],
  ["movil", 390, 844],
] as const;

const SHOTS = import.meta.env.VITE_MODEL_CARD_SHOTS as string | undefined;

function mount(props: Partial<ModelDownloadCardViewProps> & { state: EditorialModelState | null }) {
  const container = document.createElement("div");
  container.className = "bg-background p-4 text-foreground";
  container.style.maxWidth = "560px";
  document.body.append(container);
  return render(
    <ModelDownloadCardView starting={false} requestError={null} onDownload={() => {}} {...props} />,
    { container, router: false },
  );
}

describe("ModelDownloadCardView", () => {
  it("offers the download with the model's size in MiB", async () => {
    const onDownload = vi.fn();
    await using screen = await mount({ state: STATES.missing!, onDownload });
    await expect.element(screen.getByText("Falta el modelo (596 MiB)")).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Modelo local de embeddings Qwen3-Embedding-0.6B; las tendencias se agrupan en esta máquina, sin enviar textos a nadie.",
        ),
      )
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Descargar" }));
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("shows bytes, bar, speed and time left while it downloads", async () => {
    await using screen = await mount({ state: STATES.downloading! });
    await expect.element(screen.getByText("Descargando… 213 de 596 MiB")).toBeVisible();
    await expect.element(screen.getByText("12,4 MiB/s · quedan 31 s")).toBeVisible();
    const bar = screen.getByRole("progressbar", { name: "Descarga del modelo" });
    await expect.element(bar).toHaveAttribute("value", String(213 * MiB));
    await expect.element(screen.getByRole("button")).not.toBeInTheDocument();
  });

  it("words a failure in Spanish and offers a retry", async () => {
    const onDownload = vi.fn();
    await using screen = await mount({ state: STATES.error!, onDownload });
    await expect
      .element(screen.getByText("Error: se cortó la conexión con Hugging Face."))
      .toBeVisible();
    await expect
      .element(screen.getByText("Lo descargado se conserva; «Reintentar» sigue desde ahí."))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("says where the ready model lives", async () => {
    await using screen = await mount({ state: STATES.ready! });
    await expect
      .element(screen.getByRole("status"))
      .toHaveTextContent("Listo · revisión c25a394d · 596 MiB · ~/earlyscript-data/models");
  });

  it("is ready for the wizard only on disk, idle and without an error", () => {
    expect(modelIsReady(STATES.ready!)).toBe(true);
    expect(modelIsReady(null)).toBe(false);
    expect(modelIsReady(STATES.missing!)).toBe(false);
    expect(modelIsReady(STATES.downloading!)).toBe(false);
    // Sizes match but the hash did not: not ready, whatever the status says.
    expect(
      modelIsReady({
        ...STATES.ready!,
        error: { code: "hash", message: "Model hash mismatch: config.json" },
      }),
    ).toBe(false);
  });

  it("keeps the ready line's last part off a line of its own at 390 px", async () => {
    await page.viewport(390, 844);
    await using screen = await mount({ state: STATES.ready! });
    const path = screen.getByText("~/earlyscript-data/models").element() as HTMLElement;
    const status = screen.getByRole("status").element() as HTMLElement;
    // The path is the last thing on the line; nothing wraps after it.
    expect(status.textContent?.trim().endsWith("~/earlyscript-data/models")).toBe(true);
    expect(path.getBoundingClientRect().right).toBeLessThanOrEqual(390);
  });

  it("resumes a partial download instead of starting over", async () => {
    await using screen = await mount({
      state: { ...base, status: "partial", bytesPresent: 213 * MiB },
    });
    await expect.element(screen.getByText("Descarga a medias: 213 de 596 MiB")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Continuar descarga" })).toBeVisible();
  });

  it("keeps the error inside a 390 px screen", async () => {
    await page.viewport(390, 844);
    await using screen = await mount({
      state: {
        ...STATES.error!,
        error: { code: "engine_missing", message: "No trend engine CLI at /a/very/long/path" },
      },
    });
    const card = screen.container.firstElementChild as HTMLElement;
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });

  // Screenshots for review, written only when VITE_MODEL_CARD_SHOTS names a folder under
  // __screenshots__ (git-ignored) next to this file.
  it.skipIf(SHOTS === undefined)("captures every state in both themes and sizes", async () => {
    try {
      for (const [size, width, height] of SIZES) {
        await page.viewport(width, height);
        for (const theme of ["claro", "oscuro"] as const) {
          document.documentElement.classList.toggle("dark", theme === "oscuro");
          for (const [name, state] of Object.entries(STATES)) {
            await using screen = await mount({ state });
            await page.screenshot({
              path: `__screenshots__/${SHOTS}/tarjeta-${name}-${theme}-${size}.png`,
              element: screen.container,
            });
          }
        }
      }
    } finally {
      document.documentElement.classList.remove("dark");
    }
  });
});
