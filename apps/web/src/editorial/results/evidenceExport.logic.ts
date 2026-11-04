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
      "Para el informe y los revisores. Solo las columnas de la lista blanca del manifiesto: sin motivos, notas, observaciones del registro manual, URL ni guiones; hilos como h001 y fechas por día.",
  },
  {
    value: "full",
    label: "Completa",
    description:
      "Para ti, en este equipo. Incluye motivos de descarte y de decisión, notas de captura, observaciones del registro manual, URL y títulos de páginas. No la publiques.",
  },
];

/** Fixed date inside the zip, so equal files give an equal archive. */
export const EVIDENCE_ZIP_DATE = new Date(Date.UTC(1980, 0, 1));

export function evidenceSavedText(result: EditorialEvidenceExportResult): string {
  const files = result.files.length + 1;
  return `${files} archivos en ${result.directory ?? result.packageName}. Huella del paquete: ${result.packageHash.slice(0, 12)}.`;
}

/**
 * A refused destination, in words. The server says why in English for its logs; the page
 * reads the reason and tells the person what to choose instead. Unknown wording falls back
 * to a generic sentence rather than leaking the English one.
 */
export function targetFailureText(message: string | null): string {
  const text = message ?? "";
  if (text.includes("does not exist")) return "Esa carpeta no existe. Elige una que exista.";
  if (text.includes("symbolic link")) return "Esa ruta es un enlace. Elige una carpeta real.";
  if (text.includes("is not a folder") || text.includes("not a folder")) {
    return "Esa ruta no es una carpeta.";
  }
  if (text.includes("is outside") || text.includes("resolves outside")) {
    return "Esa carpeta está fuera de tu carpeta personal. Elige una dentro de ella.";
  }
  if (text.includes("absolute path")) return "La ruta de la carpeta debe ser completa.";
  if (text.includes("is not empty")) return "Esa carpeta no está vacía. Elige una vacía.";
  if (text.includes("same file name")) return "Dos figuras tienen el mismo nombre de archivo.";
  return "No se pudo escribir en esa carpeta.";
}

/** Whether the server refused for lack of permission in this environment. */
export function isPermissionFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { readonly _tag: unknown })._tag === "EnvironmentAuthorizationError"
  );
}

export const PERMISSION_FAILURE_TEXT =
  "No tienes permiso para escribir en este entorno. Pide acceso de operación.";

/** Server error reasons in words; anything else falls back to a generic sentence. */
export function evidenceFailureText(error: unknown): string {
  if (isPermissionFailure(error)) return PERMISSION_FAILURE_TEXT;
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
      return targetFailureText(message);
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
