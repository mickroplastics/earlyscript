import type { EditorialResultsSummary } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ManualBaselineView, type BaselineImportState } from "./ManualBaselineSection";
import { BASELINE_RECORD, EMPTY_BASELINE } from "./manualBaseline.fixture";

const MINUTE = 60_000;
const stats = (n: number, median: number) => ({
  n,
  medianMs: median * MINUTE,
  q1Ms: (median - 2) * MINUTE,
  q3Ms: (median + 2) * MINUTE,
  minMs: (median - 2) * MINUTE,
  maxMs: (median + 2) * MINUTE,
});
const SUMMARY = {
  comparisons: [
    {
      key: "explore",
      assisted: stats(3, 12),
      manual: stats(0, 0),
      partial: { assisted: 0, manual: 0 },
    },
    {
      key: "write",
      assisted: stats(3, 26),
      manual: stats(0, 0),
      partial: { assisted: 0, manual: 0 },
    },
  ],
} as unknown as EditorialResultsSummary;

const IDLE: BaselineImportState = { _tag: "idle" };

describe("ManualBaselineView", () => {
  it("offers the import and shows no zeros before a log exists", async () => {
    await using screen = await render(
      <ManualBaselineView
        record={EMPTY_BASELINE}
        failure={null}
        summary={SUMMARY}
        importState={IDLE}
        onImport={() => {}}
      />,
    );
    await expect
      .element(screen.getByRole("heading", { name: "Antes de la app: registro manual" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Importar registro CSV" }))
      .toBeEnabled();
    await expect.element(screen.getByText(/Aún no hay un registro manual importado/)).toBeVisible();
    expect(screen.container.querySelector("[data-baseline-comparison]")).toBeNull();
    expect(screen.container.textContent).not.toContain("0 min");
  });

  it("shows provenance, the side-by-side medians, the chart, the blocks and folded notes", async () => {
    await using screen = await render(
      <ManualBaselineView
        record={BASELINE_RECORD}
        failure={null}
        summary={SUMMARY}
        importState={IDLE}
        onImport={() => {}}
      />,
    );
    await expect
      .element(
        screen.getByText(/^Registro manual del 1 al 14 de octubre de 2026, un solo operador/),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reemplazar registro" })).toBeVisible();
    const search = screen.container.querySelector('[data-baseline-comparison="search"]')!;
    expect(search.querySelector('[data-series="assisted"]')!.textContent).toContain("12 min");
    expect(search.querySelector('[data-series="cronometrado"]')!.textContent).toContain(
      "cifra principal",
    );
    expect(search.querySelector('[data-series="reconstruido"]')!.textContent).toContain(
      "estimación",
    );
    const writing = screen.container.querySelector('[data-baseline-comparison="writing"]')!;
    expect(writing.querySelector('[data-series="cronometrado"]')!.textContent).toContain(
      "1 h 52,5 min",
    );
    expect(screen.container.querySelectorAll("[data-baseline-bar]")).toHaveLength(6);
    // The long tables stay folded, and unmounted, until asked for.
    expect(screen.container.querySelector("table")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Tabla con RIC/ }));
    await expect
      .element(
        screen.getByRole("table", {
          name: "Búsqueda y escritura, asistido frente al registro manual",
        }),
      )
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /^Semanas y en qué terminó/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Los 4 bloques del registro/ }));
    const blocks = screen.getByRole("table", { name: "Bloques del registro manual" });
    await expect.element(blocks).toBeVisible();
    expect(screen.container.querySelectorAll("[data-baseline-block]")).toHaveLength(4);
    expect(screen.container.querySelectorAll("[data-baseline-missing]")).toHaveLength(2);
    expect(
      screen.container.querySelector('[data-baseline-block="2026-10-05#2"]')!.textContent,
    ).toContain("sin separar");
    await expect
      .element(screen.getByText("al menos 16 h 5 min en 9 bloques", { exact: false }))
      .toBeVisible();
    // The operator's notes sit in their block's row.
    await expect.element(screen.getByText(/Desde el historial/)).toBeVisible();
    expect(
      screen
        .getByText(/Desde el historial/)
        .element()
        .closest("tr"),
    ).not.toBeNull();
    expect(screen.container.textContent).not.toMatch(/ahorro/i);
  });

  it("sends the chosen file and reports saving, the result and row errors", async () => {
    const onImport = vi.fn();
    const file = new File(["fecha\n"], "registro.csv", { type: "text/csv" });
    await using screen = await render(
      <ManualBaselineView
        record={EMPTY_BASELINE}
        failure={null}
        summary={null}
        importState={IDLE}
        onImport={onImport}
      />,
    );
    const input = screen.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, file);
    expect(onImport).toHaveBeenCalledWith(file);

    await screen.rerender(
      <ManualBaselineView
        record={EMPTY_BASELINE}
        failure={null}
        summary={null}
        importState={{ _tag: "saving" }}
        onImport={onImport}
      />,
    );
    await expect.element(screen.getByRole("button", { name: "Guardando…" })).toBeDisabled();

    await screen.rerender(
      <ManualBaselineView
        record={EMPTY_BASELINE}
        failure={null}
        summary={null}
        importState={{
          _tag: "done",
          result: {
            status: "rejected",
            errors: [{ line: 3, column: "modo", message: "«a ojo» no es un modo." }],
            warnings: [],
            blocks: 0,
            missingDays: 0,
            from: null,
            to: null,
            sourceHash: "x",
            replaced: false,
          },
        }}
        onImport={onImport}
      />,
    );
    await expect
      .element(screen.getByText("No se importó nada: hay un error en el archivo."))
      .toBeVisible();
    await expect.element(screen.getByText("Línea 3, modo: «a ojo» no es un modo.")).toBeVisible();
  });

  it("explains a failed read", async () => {
    await using screen = await render(
      <ManualBaselineView
        record={null}
        failure="La base editorial de este entorno no se pudo leer."
        summary={null}
        importState={IDLE}
        onImport={() => {}}
      />,
    );
    await expect.element(screen.getByText("No se pudo leer el registro manual")).toBeVisible();
  });
});
