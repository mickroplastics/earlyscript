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
      text: "Recuentos de visitas bajo CC0 (conjuntos de Analytics de Wikimedia); resúmenes de artículos bajo CC BY-SA 4.0 con atribución.",
      url: "https://creativecommons.org/licenses/by-sa/4.0/",
    },
    termsReviewedAt: "2026-10-31",
    termsUrl: "https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "ready",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Términos (vigentes desde el 7 de junio de 2023) leídos: prohíben el uso automatizado abusivo o la carga indebida de una API y exigen la User-Agent Policy (nombre, versión y contacto); no mencionan IA ni minería de textos. Sin datos personales. Puede diluir la señal técnica (hipótesis C05): entra al motor solo tras backtest.",
  },
  npm: {
    id: "npm",
    name: "npm (registro)",
    origin: "https://registry.npmjs.org/-/v1/search",
    license: {
      text: "Metadatos de cada paquete con la licencia que elige su autor (npm Open Source Terms, «Your Content belongs to you»).",
      url: "https://docs.npmjs.com/policies/open-source-terms",
    },
    termsReviewedAt: "2026-10-31",
    termsUrl: "https://docs.npmjs.com/policies/open-source-terms",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "ready",
    coverage: "sample",
    engineBaseline: false,
    notes:
      "Open Source Terms (10 de marzo de 2022) leídos: se permite replicar datos del registro por las API públicas; se prohíbe rastrear el sitio web, usar el registro como base de datos general y superar cinco millones de peticiones al mes. La política de rastreadores pide 1 petición por segundo o menos. Sin mención de IA. Falta la regla de paquete «conocido» (M28).",
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
    termsUrl: "https://stackoverflow.com/legal/api-terms-of-use",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "pending-review",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Sin leer: el 31 de octubre de 2026 las páginas de API Terms y Acceptable Use Policy respondieron 403 con un desafío de Cloudflare. Terceros afirman que el uso para IA generativa exige consentimiento escrito (no verificado). No se captura hasta leerlas (M28).",
  },
  bluesky: {
    id: "bluesky",
    name: "Bluesky",
    origin: "https://api.bsky.app/xrpc/app.bsky.feed.searchPosts",
    license: {
      text: "Bluesky Developer Guidelines; las publicaciones son de sus autores (licencia del contenido por confirmar en los Terms of Service).",
      url: "https://docs.bsky.app/docs/support/developer-guidelines",
    },
    termsReviewedAt: "2026-10-31",
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
      "Guía leída (fuente del sitio en github.com/bluesky-social/bsky-docs; la página redirige a bsky.network y no carga sin JavaScript): «All services must have a method for deleting content a user has requested to be deleted». Earlyscript no tiene ese método por autor y URI, así que queda bloqueada (M29). La guía no habla de IA.",
  },
  huggingface: {
    id: "huggingface",
    name: "Hugging Face Hub",
    origin: "https://huggingface.co/api",
    license: {
      text: "Cada modelo, conjunto o artículo con su propia licencia; los repositorios públicos conceden a cada usuario una licencia de uso perpetua (Terms of Service).",
      url: "https://huggingface.co/terms-of-service",
    },
    termsReviewedAt: "2026-10-31",
    termsUrl: "https://huggingface.co/terms-of-service",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "ready",
    coverage: "sample",
    engineBaseline: false,
    notes:
      "Terms of Service (15 de septiembre de 2022) leídos: no regulan el acceso automatizado ni mencionan IA o minería; el contenido con licencia abierta sigue bajo esa licencia; al cerrar una cuenta, Hugging Face borra su contenido en 90 días. Límite anónimo de 500 peticiones a la API cada 5 minutos por IP (página de rate limits, septiembre de 2025).",
  },
  devto: {
    id: "devto",
    name: "DEV (dev.to)",
    origin: "https://dev.to/api",
    license: {
      text: "Licencia de uso de DEV: una copia temporal solo para visualización personal y no comercial; prohíbe copiar, usar comercialmente o replicar los materiales.",
      url: "https://dev.to/terms",
    },
    termsReviewedAt: "2026-10-31",
    termsUrl: "https://dev.to/terms",
    access: "public",
    retention: "frozen-corpus",
    deletion: MANUAL_CORPUS_DELETION,
    language: "en",
    cost: "none",
    status: "blocked",
    coverage: "sample",
    engineBaseline: false,
    notes:
      "Términos leídos (sin fecha publicada): la sección 2 solo permite ver una copia de forma personal y no comercial y prohíbe copiar o replicar; guardar artículos en el corpus choca con eso. La documentación de la API no trae términos propios. Bloqueada hasta pedir permiso a DEV o decidir retirarla. Sin mención de IA.",
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
