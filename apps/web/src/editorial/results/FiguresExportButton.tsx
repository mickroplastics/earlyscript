import { ImagesIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { figuresZipName } from "./figureExport.logic";
import { allFigureFiles, type FigureFile } from "./figureFiles";
import { figureContext, useFigures } from "./FigureFrame";

/**
 * «Guardar todas las figuras»: every `FigureFrame` of the page as PNG, in page order, plus
 * `figuras.md` with each caption and its data in words. On the desktop app the files go into
 * the folder the native dialog picks; elsewhere the browser downloads `figuras-<día>.zip`.
 */
export function FiguresExportButton() {
  const figures = useFigures();
  const [pending, setPending] = useState(false);

  const run = async () => {
    const specs = figures.figures();
    if (specs.length === 0) {
      toastManager.add({
        type: "error",
        title: "No hay figuras que guardar",
        description: "Esta página todavía no muestra ninguna gráfica.",
      });
      return;
    }
    setPending(true);
    const context = figureContext(figures.threads);
    let files: ReadonlyArray<FigureFile>;
    try {
      files = await allFigureFiles(specs, context);
    } catch {
      setPending(false);
      toastManager.add({
        type: "error",
        title: "No se guardaron las figuras",
        description: "No se pudieron dibujar las imágenes en este navegador.",
      });
      return;
    }
    const outcome = await figures.save(files, figuresZipName(context.exportedAt));
    setPending(false);
    if (outcome._tag === "cancelled") return;
    if (outcome._tag === "failed") {
      toastManager.add({
        type: "error",
        title: "No se guardaron las figuras",
        description: outcome.message,
      });
      return;
    }
    const images = files.length - 1;
    toastManager.add({
      type: "success",
      title: outcome.toFolder ? "Figuras guardadas" : "Figuras descargadas",
      description: `${images} ${images === 1 ? "imagen" : "imágenes"} y figuras.md en ${outcome.where}.`,
    });
  };

  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => void run()}>
      <ImagesIcon />
      {pending ? "Guardando figuras…" : "Guardar todas las figuras"}
    </Button>
  );
}
