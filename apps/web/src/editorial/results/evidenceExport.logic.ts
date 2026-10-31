import type { EditorialEvidenceExportResult, EditorialEvidenceMode } from "@t3tools/contracts";

export interface EvidenceModeOption {
  readonly value: EditorialEvidenceMode;
  readonly label: string;
  readonly description: string;
}

export const EVIDENCE_MODE_OPTIONS: ReadonlyArray<EvidenceModeOption> = [
  {
    value: "share",
    label: "Para compartir",
    description:
      "Para el informe y los revisores. Solo las columnas de la lista blanca del manifiesto: sin motivos, notas, URL ni guiones; hilos como h001 y fechas por día.",
  },
  {
    value: "full",
    label: "Completa",
    description:
      "Para ti, en este equipo. Incluye motivos de descarte y de decisión, notas de captura, URL y títulos de páginas. No la publiques.",
  },
];

/** Fixed date inside the zip, so equal files give an equal archive. */
export const EVIDENCE_ZIP_DATE = new Date(Date.UTC(1980, 0, 1));

export function evidenceSavedText(result: EditorialEvidenceExportResult): string {
  const files = result.files.length + 1;
  return `${files} archivos en ${result.directory ?? result.packageName}. Huella del paquete: ${result.packageHash.slice(0, 12)}.`;
}

/** Server error reasons in words; anything else falls back to a generic sentence. */
export function evidenceFailureText(error: unknown): string {
  const reason =
    typeof error === "object" && error !== null && "reason" in error
      ? (error as { readonly reason: unknown }).reason
      : null;
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { readonly message: unknown }).message)
      : null;
  switch (reason) {
    case "target":
      return message ?? "No se pudo escribir en esa carpeta.";
    case "unreadable":
      return "La base editorial no se pudo leer.";
    case "unavailable":
      return "Este entorno no tiene los servicios editoriales montados.";
    case "invalid-filter":
      return message ?? "El filtro de fechas no es válido.";
    default:
      return "El entorno no respondió. Inténtalo de nuevo en un momento.";
  }
}
