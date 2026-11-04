import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FIGURE_SCALE, FIGURE_WIDTH, type FigureSpec } from "./figureExport.logic";
import { allFigureFiles, figureFile } from "./figureFiles";
import { FigureFrame } from "./FigureFrame";

const MINUTE = 60_000;
const DAY = new Date(2026, 10, 4, 10, 0);

const SPEC: FigureSpec = {
  id: "etapas",
  title: "Mediana de tiempo activo por etapa",
  caption: "Mediana y RIC por etapa.",
  body: {
    kind: "bars",
    series: [
      { key: "assisted", label: "Asistido", color: "primary" },
      { key: "manual", label: "Manual", color: "neutral" },
    ],
    groups: [
      {
        label: "Escribir",
        rows: [
          {
            series: "assisted",
            value: 26 * MINUTE,
            low: 24 * MINUTE,
            high: 28 * MINUTE,
            text: "26 min",
          },
          { series: "manual", value: 50 * MINUTE, text: "50 min" },
        ],
      },
    ],
    axis: {
      max: 60 * MINUTE,
      ticks: [
        { value: 0, label: "0" },
        { value: 60 * MINUTE, label: "1 h" },
      ],
    },
  },
};

/** Width, height and the pixel at (x, y) of a PNG, decoded by the browser. */
async function decodePng(bytes: Uint8Array, x: number, y: number) {
  const bitmap = await createImageBitmap(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/png" }),
  );
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(bitmap, 0, 0);
  return {
    width: bitmap.width,
    height: bitmap.height,
    pixel: [...context.getImageData(x, y, 1, 1).data],
  };
}

describe("figure images", () => {
  it("rasterises a figure at 1600 px on white, with its print density", async () => {
    const file = await figureFile(SPEC, { threads: 6, exportedAt: DAY }, "png");
    expect(file.name).toBe("figura-etapas-2026-11-04.png");
    const image = await decodePng(file.bytes, 4, 4);
    expect(image.width).toBe(FIGURE_WIDTH * FIGURE_SCALE);
    expect(image.height).toBeGreaterThan(300);
    expect(image.pixel).toEqual([255, 255, 255, 255]);
    // pHYs right after IHDR: 10 000 pixels per metre is 254 dpi.
    expect(String.fromCharCode(...file.bytes.subarray(37, 41))).toBe("pHYs");
    expect(new DataView(file.bytes.buffer).getUint32(41)).toBe(10_000);
  });

  it("packs every figure with figuras.md", async () => {
    const files = await allFigureFiles(
      [SPEC, { ...SPEC, id: "tiempos", title: "Tiempo por ficha" }],
      { threads: 6, exportedAt: DAY },
    );
    expect(files.map((file) => file.name)).toEqual([
      "figura-etapas-2026-11-04.png",
      "figura-tiempos-2026-11-04.png",
      "figuras.md",
    ]);
    const index = new TextDecoder().decode(files[2]!.bytes);
    expect(index).toContain("## Figura 2. Tiempo por ficha");
  });
});

describe("FigureFrame", () => {
  it("offers PNG and SVG beside the figure title and says where the file went", async () => {
    using clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await using screen = await render(
      <FigureFrame id={SPEC.id} title={SPEC.title} caption={SPEC.caption} figure={SPEC.body}>
        <p>Gráfica de la página</p>
      </FigureFrame>,
    );
    await expect.element(screen.getByText(`Figura: ${SPEC.title}`)).toBeVisible();
    await expect
      .element(screen.getByRole("group", { name: `Figura: ${SPEC.title}` }))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: `Guardar imagen: ${SPEC.title}` }));
    await userEvent.click(page.getByRole("menuitem", { name: "SVG vectorial" }));
    await expect.element(screen.getByText("Descargada:", { exact: false })).toBeVisible();
    const status = screen.container.querySelector('[data-figure="etapas"] [role="status"]');
    expect(status?.textContent).toMatch(/^Descargada: figura-etapas-\d{4}-\d{2}-\d{2}\.svg$/);
    expect(clicks).toHaveBeenCalledOnce();
    const anchor = clicks.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^figura-etapas-\d{4}-\d{2}-\d{2}\.svg$/);
  });

  it("stands before an existing chart without wrapping it", async () => {
    await using screen = await render(
      <FigureFrame
        id="bandeja"
        title="Bandeja de tendencias"
        caption="Conteos."
        figure={{ kind: "metrics", metrics: [] }}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Guardar imagen: Bandeja de tendencias" }))
      .toBeVisible();
    expect(
      screen.container.querySelector('[data-figure="bandeja"]')?.getAttribute("role"),
    ).toBeNull();
  });
});
