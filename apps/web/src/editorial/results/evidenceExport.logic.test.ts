import { describe, expect, it } from "vite-plus/test";

import {
  EVIDENCE_MODE_OPTIONS,
  evidenceFailureText,
  evidenceSavedText,
} from "./evidenceExport.logic";

describe("evidence export copy", () => {
  it("offers share first and warns that full is private", () => {
    expect(EVIDENCE_MODE_OPTIONS.map((option) => option.value)).toEqual(["share", "full"]);
    expect(EVIDENCE_MODE_OPTIONS[1]!.description).toContain("No la publiques");
  });

  it("names where the package went and its hash", () => {
    const result = {
      mode: "share" as const,
      packageHash: "0123456789abcdef0123",
      packageName: "earlyscript-evidencia-compartir-2026-10-31",
      files: [
        { name: "resumen.md", sha256: "a", bytes: 1 },
        { name: "decisiones.csv", sha256: "b", bytes: 1 },
      ],
      directory: "/home/m/evidencia/earlyscript-evidencia-compartir-2026-10-31",
      contents: [],
    };
    expect(evidenceSavedText(result)).toBe(
      "3 archivos en /home/m/evidencia/earlyscript-evidencia-compartir-2026-10-31. Huella del paquete: 0123456789ab.",
    );
  });

  it("explains each server reason", () => {
    expect(evidenceFailureText({ reason: "target", message: "/x is not empty" })).toBe(
      "/x is not empty",
    );
    expect(evidenceFailureText({ reason: "unreadable" })).toBe(
      "La base editorial no se pudo leer.",
    );
    expect(evidenceFailureText(null)).toBe(
      "El entorno no respondió. Inténtalo de nuevo en un momento.",
    );
  });
});
