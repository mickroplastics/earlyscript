import { isTransportConnectionErrorMessage } from "@t3tools/client-runtime/errors";

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
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String(error.message)
        : null;
  if (message !== null && isConnectionMessage(message)) return CONNECTION_LOST;
  // Any other message is the transport's or the server's English: keep it for the console.
  console.error("editorial.sources:", error);
  return UNREACHABLE;
}

/** Spanish for every connection failure the client reports, whatever machine it names. */
export const CONNECTION_LOST =
  "Se perdió la conexión con el servidor de Earlyscript; espera a que se reconecte.";
export const UNREACHABLE = "No se pudo contactar con el servidor.";

// T3's own transport patterns ("<machine> is not connected.", "disconnected.", socket and
// ping errors) plus the time-outs and unreachable hosts the RPC layer reports.
const CONNECTION_PATTERN =
  /\b(?:is not connected|disconnected|timed out|not reachable|unreachable)\b/i;
const isConnectionMessage = (message: string) =>
  isTransportConnectionErrorMessage(message) || CONNECTION_PATTERN.test(message);
