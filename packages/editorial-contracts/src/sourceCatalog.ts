import * as Schema from "effect/Schema";

import { SourceId, UtcDay } from "./source.ts";

// Governance record of every source, shown in Settings and copied into the thesis annex.
// Facts come from the official page in `termsUrl`, read on `termsReviewedAt`; the rest says
// "por confirmar" and keeps the source out of `ready`. Sources: the thesis note
// 08-fuentes-candidatas-y-condiciones.md and early-window/docs/DATA.md.

export const SourceAccess = Schema.Literals(["public", "token", "approval"]);
export type SourceAccess = typeof SourceAccess.Type;

/** `frozen-corpus`: kept in corpus/1 with its hash; `30-days`: must expire; `ephemeral`: never frozen. */
export const SourceRetention = Schema.Literals(["frozen-corpus", "30-days", "ephemeral"]);
export type SourceRetention = typeof SourceRetention.Type;

export const SourceCost = Schema.Literals(["none", "metered", "subscription"]);
export type SourceCost = typeof SourceCost.Type;

/** `ready`: terms read and recorded; `blocked`: a condition of use is not met, so no capture. */
export const SourceReviewStatus = Schema.Literals(["ready", "pending-review", "blocked"]);
export type SourceReviewStatus = typeof SourceReviewStatus.Type;

/** What a full day of the source is: every item (`census`) or a declared ranked sample. */
export const SourceCoveragePolicy = Schema.Literals(["census", "sample"]);
export type SourceCoveragePolicy = typeof SourceCoveragePolicy.Type;

export const DELETION_NONE_DOCUMENTED = "none-documented";

export const SourceGovernance = Schema.Struct({
  id: SourceId,
  name: Schema.String,
  /** Base URL the adapter calls. */
  origin: Schema.String,
  license: Schema.Struct({ text: Schema.String, url: Schema.NullOr(Schema.String) }),
  /** Day the official terms were read; null while they have not been. */
  termsReviewedAt: Schema.NullOr(UtcDay),
  termsUrl: Schema.NullOr(Schema.String),
  access: SourceAccess,
  retention: SourceRetention,
  /** How collected items are removed, or `DELETION_NONE_DOCUMENTED`. */
  deletion: Schema.String,
  language: Schema.String,
  cost: SourceCost,
  status: SourceReviewStatus,
  coverage: SourceCoveragePolicy,
  /**
   * The engine's comparison baseline (`hn`, `github`): it ranks without a backtest of its own,
   * since the backtest of every other source measures it against these.
   */
  engineBaseline: Schema.Boolean,
  notes: Schema.String,
});
export type SourceGovernance = typeof SourceGovernance.Type;

const MANUAL_CORPUS_DELETION =
  "Borrado manual del directorio del corpus o de sus archivos por día; no hay borrado por ítem ni registro de purgas.";

export const SOURCE_CATALOG: Readonly<Record<SourceId, SourceGovernance>> = {
  hn: {
    id: "hn",
    name: "Hacker News",
    origin: "https://hn.algolia.com/api/v1",
    license: {
      text: "Términos de uso de Y Combinator; el contenido no tiene licencia abierta.",
      url: "https://www.ycombinator.com/legal",
    },
    termsReviewedAt: "2026-10-26",
    termsUrl: "https://www.ycombinator.com/legal",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "ready",
    coverage: "census",
    engineBaseline: true,
    notes:
      "Los términos de Y Combinator prohíben la minería de datos, el scraping y el uso comercial; la política de privacidad dice que envíos y comentarios no son información personal. La captura usa la API pública de Algolia, no el sitio: riesgo registrado. El uso comercial o la redistribución del texto quedan bloqueados hasta que Y Combinator lo aclare por escrito (pedido, sin respuesta). Los términos propios de la API de Algolia no se pudieron leer (la página exige JavaScript).",
  },
  github: {
    id: "github",
    name: "GitHub",
    origin: "https://api.github.com/search/repositories",
    license: {
      text: "Políticas de uso aceptable de GitHub, sección 7: uso de información pública no personal para investigación con publicación en acceso abierto.",
      url: "https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies",
    },
    termsReviewedAt: "2026-10-26",
    termsUrl:
      "https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "ready",
    coverage: "sample",
    engineBaseline: true,
    notes:
      "La política aclara que la recolección por la API no es scraping. Sin token, la búsqueda admite 10 peticiones por minuto; GITHUB_TOKEN es opcional. Muestra declarada: los 100 primeros repositorios por estrellas actuales de cada ventana, así que cada día es parcial. Exportar descripciones queda bloqueado hasta revisar la licencia de cada repositorio.",
  },
  arxiv: {
    id: "arxiv",
    name: "arXiv",
    origin: "https://export.arxiv.org/api/query",
    license: {
      text: "Metadatos (título, resumen, autores) bajo CC0 1.0.",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    termsReviewedAt: "2026-10-31",
    termsUrl: "https://info.arxiv.org/help/api/tou.html",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "ready",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Términos de la API leídos: una petición cada 3 segundos y una sola conexión; no almacenar PDFs ni fuentes, solo metadatos. Entra al motor tras un backtest que no empeore P@5.",
  },
  wikipedia: {
    id: "wikipedia",
    name: "Wikipedia (páginas más vistas)",
    origin: "https://wikimedia.org/api/rest_v1/metrics/pageviews",
    license: {
      text: "Textos de Wikipedia bajo CC BY-SA (por confirmar en la fuente oficial).",
      url: null,
    },
    termsReviewedAt: null,
    termsUrl: null,
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "pending-review",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Términos de la API de Wikimedia sin leer (por confirmar). Sin datos personales. Puede diluir la señal técnica (hipótesis C05 de la ola 8): entra al motor solo tras backtest.",
  },
  npm: {
    id: "npm",
    name: "npm (registro)",
    origin: "https://registry.npmjs.org/-/v1/search",
    license: {
      text: "Metadatos públicos de paquetes; licencia y términos por confirmar.",
      url: null,
    },
    termsReviewedAt: null,
    termsUrl: null,
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "pending-review",
    coverage: "sample",
    engineBaseline: false,
    notes:
      "Términos del registro sin leer (por confirmar). Falta la regla de paquete «conocido» (M28 de Earlywindow).",
  },
  stackexchange: {
    id: "stackexchange",
    name: "Stack Exchange",
    origin: "https://api.stackexchange.com/2.3",
    license: {
      text: "Contenido bajo CC BY-SA con atribución (por confirmar en la fuente oficial).",
      url: null,
    },
    termsReviewedAt: null,
    termsUrl: null,
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "pending-review",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Solo captura. Terceros afirman que el uso para IA generativa exige consentimiento escrito (no verificado). No entra al motor ni al redactor hasta leer los API Terms vigentes y anotarlos aquí (M28).",
  },
  bluesky: {
    id: "bluesky",
    name: "Bluesky",
    origin: "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts",
    license: {
      text: "Guía de desarrolladores de Bluesky; pide respetar los borrados (por confirmar, la página no cargó sin JavaScript).",
      url: "https://docs.bsky.app/docs/support/developer-guidelines",
    },
    termsReviewedAt: null,
    termsUrl: "https://docs.bsky.app/docs/support/developer-guidelines",
    access: "public",
    retention: "ephemeral",
    deletion: DELETION_NONE_DOCUMENTED,
    language: "en",
    cost: "none",
    status: "blocked",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Bloqueada: sin un procedimiento de borrado por autor y URI documentado y ejecutable (M29). Prevista como captura efímera fuera del corpus congelado; ese mecanismo no existe todavía.",
  },
  huggingface: {
    id: "huggingface",
    name: "Hugging Face Hub",
    origin: "https://huggingface.co/api",
    license: {
      text: "Cada modelo, conjunto o artículo con su propia licencia; términos del Hub por confirmar.",
      url: null,
    },
    termsReviewedAt: null,
    termsUrl: "https://huggingface.co/docs/hub/rate-limits",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "pending-review",
    coverage: "sample",
    engineBaseline: false,
    notes:
      "Límite anónimo de 500 peticiones cada 5 minutos por IP. El programa «Data for Research» acoge estudios del ecosistema. Términos de servicio sin leer (por confirmar).",
  },
  devto: {
    id: "devto",
    name: "DEV (dev.to)",
    origin: "https://dev.to/api",
    license: {
      text: "Artículos de sus autores; licencia por confirmar.",
      url: null,
    },
    termsReviewedAt: null,
    termsUrl: "https://developers.forem.com/api/v0",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "pending-review",
    coverage: "sample",
    engineBaseline: false,
    notes:
      "Lectura pública que exige User-Agent. Límites sin publicar con claridad (10 peticiones cada 30 s en la referencia beta). Términos sin leer (por confirmar).",
  },
  lobsters: {
    id: "lobsters",
    name: "Lobsters",
    origin: "https://lobste.rs",
    license: {
      text: "Contenido de sus usuarios; licencia por confirmar.",
      url: null,
    },
    termsReviewedAt: null,
    termsUrl: null,
    access: "approval",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "blocked",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Bloqueada: su robots.txt (leído por el adaptador el 31 de octubre de 2026) solo admite buscadores conocidos, con «User-agent: *» y «Disallow: /», y declara «Content-Signal: ai-input=no». No se usa sin permiso escrito de sus administradores; decisión de Miguel: pedirlo o retirar la fuente.",
  },
  rss: {
    id: "rss",
    name: "RSS y Atom curados",
    origin: "Lista de feeds elegida por el operador",
    license: {
      text: "Cada feed con su propia licencia; sin verificar sitio por sitio, se asume el copyright del editor.",
      url: null,
    },
    termsReviewedAt: null,
    termsUrl: null,
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "pending-review",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Lista curada de 14 feeds. Se guarda solo título, enlace, autor y el extracto que publica el feed; el robots.txt de cada feed permite la ruta. Sin ranking cruzado hasta tener volumen.",
  },
};

export const SOURCE_IDS: ReadonlyArray<SourceId> = SourceId.literals;
