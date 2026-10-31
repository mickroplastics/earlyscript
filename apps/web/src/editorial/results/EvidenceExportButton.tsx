import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EditorialEvidenceExportResult,
  EditorialEvidenceMode,
  EnvironmentId,
} from "@t3tools/contracts";
import { DownloadIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { toastManager } from "../../components/ui/toast";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { readLocalApi } from "../../localApi";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { editorialResultsEnvironment } from "../resultsState";
import {
  EVIDENCE_MODE_OPTIONS,
  EVIDENCE_ZIP_DATE,
  evidenceFailureText,
  evidenceSavedText,
} from "./evidenceExport.logic";

/** Packs the returned files into `<package>.zip` under a folder of the same name. */
async function downloadZip(result: EditorialEvidenceExportResult): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const folder = zip.folder(result.packageName)!;
  for (const file of result.contents) {
    folder.file(file.name, file.content, { date: EVIDENCE_ZIP_DATE });
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${result.packageName}.zip`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * «Exportar evidencia» in Results. On the desktop app over its own server, the package goes
 * into a folder the native dialog picks; anywhere else, the browser downloads a zip.
 */
export function EvidenceExportButton({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <DownloadIcon />
        Exportar evidencia
      </Button>
      {open ? (
        <EvidenceExportDialog environmentId={environmentId} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function EvidenceExportDialog({
  environmentId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [mode, setMode] = useState<EditorialEvidenceMode>("share");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exportEvidence = useAtomCommand(editorialResultsEnvironment.exportEvidence, {
    reportFailure: false,
  });
  const environment = useEnvironment(environmentId);
  const toFolder =
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    environment !== null &&
    isDesktopLocalConnectionTarget(environment.entry.target);

  const run = async () => {
    setError(null);
    let directory: string | null = null;
    if (toFolder) {
      directory = (await readLocalApi()?.dialogs.pickFolder()) ?? null;
      if (directory === null) return;
    }
    setPending(true);
    const result = await exportEvidence({
      environmentId,
      input: { mode, ...(directory === null ? {} : { directory }) },
    });
    if (result._tag !== "Success") {
      setPending(false);
      if (!isAtomCommandInterrupted(result)) {
        setError(evidenceFailureText(squashAtomCommandFailure(result)));
      }
      return;
    }
    try {
      if (result.value.directory === null) await downloadZip(result.value);
    } catch {
      setPending(false);
      setError("No se pudo preparar el archivo .zip en el navegador.");
      return;
    }
    setPending(false);
    toastManager.add({
      type: "success",
      title: result.value.directory === null ? "Evidencia descargada" : "Evidencia guardada",
      description: evidenceSavedText(result.value),
    });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Exportar evidencia</DialogTitle>
          <DialogDescription>
            Resumen, decisiones, tiempos, eventos y corridas en un paquete reproducible: la misma
            base da los mismos archivos y la misma huella.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <span id={`${id}-mode`} className="text-xs font-medium text-foreground">
              Contenido
            </span>
            <RadioGroup
              aria-labelledby={`${id}-mode`}
              value={mode}
              disabled={pending}
              onValueChange={(next) => setMode(next as EditorialEvidenceMode)}
            >
              {EVIDENCE_MODE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-sm"
                >
                  <Radio value={option.value} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-foreground">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <p className="text-xs text-muted-foreground">
              {toFolder
                ? "Elige una carpeta: el paquete se guarda en una subcarpeta nueva con el modo y la fecha."
                : "El navegador descarga un archivo .zip con el paquete."}
            </p>
            {error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" disabled={pending} onClick={() => void run()}>
            {pending ? "Exportando…" : toFolder ? "Elegir carpeta y exportar" : "Descargar .zip"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
