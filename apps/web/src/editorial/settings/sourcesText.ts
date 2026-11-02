/**
 * Spanish sentences for failed `editorial.sources.*` calls, shared by Settings › Editorial ›
 * Fuentes and the first-run «Datos y permisos» step.
 */

const ERROR_TEXT: Readonly<Record<string, string>> = {
  "not-a-feed": "No es un feed RSS ni Atom.",
  "robots-disallowed": "El robots.txt del sitio prohíbe esa ruta a Earlyscript.",
  "robots-unavailable": "El robots.txt del sitio no responde; no se puede comprobar el permiso.",
  unreachable: "El feed no responde.",
  "too-large": "El feed supera el límite de 4 MiB.",
  "invalid-url": "La URL debe empezar con http:// o https://.",
  "duplicate-feed": "Ese feed ya está en la lista.",
  "unknown-feed": "Ese feed ya no está en la lista.",
  "not-acknowledged": "Falta aceptar el uso para análisis privado, sin republicar.",
  "rank-blocked": "La fuente todavía no puede entrar al motor.",
  "collect-blocked": "La fuente no se puede capturar: sus términos están sin leer o la bloquean.",
  "unknown-source": "Este servidor no conoce la fuente.",
  unavailable: "Los servicios editoriales no están montados en este servidor.",
  storage: "La base editorial no respondió.",
};

export function failureText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    if ("_tag" in error && error._tag === "EnvironmentAuthorizationError")
      return "Este dispositivo no tiene permiso para leer o cambiar las fuentes del servidor.";
    if ("reason" in error) {
      const text = ERROR_TEXT[String(error.reason)];
      if (text) return text;
    }
  }
  return error instanceof Error ? error.message : "Error desconocido.";
}
