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

/**
 * Retired by its conditions of use: dev.to on 31 October 2026 (its use license allows only
 * personal, non-commercial viewing). The id stays in SourceId until its adapter leaves.
 */
export type RetiredSourceId = Extract<SourceId, "devto">;
export type CatalogSourceId = Exclude<SourceId, RetiredSourceId>;

export const SOURCE_CATALOG: Readonly<Record<CatalogSourceId, SourceGovernance>> = {
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
      "Open Source Terms (10 de marzo de 2022): se permite replicar datos del registro por las API públicas; se prohíbe rastrear el sitio web y usar el registro como base de datos general. La carga debe ser razonable, y cinco millones de peticiones en un mes ya incumplen ese umbral; una cifra menor no queda garantizada. La regla de 1 petición por segundo es para rastreadores experimentales del sitio web (https://docs.npmjs.com/policies/crawlers); Earlyscript la adopta como límite propio para la API del registro (decisión interna). Falta la regla de paquete «conocido» (M28).",
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
      text: "Cada modelo, conjunto o artículo con su propia licencia; un repositorio público concede a cada usuario una licencia de uso «through our Services and functionalities» (ToS, «Your Content»).",
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
      "ToS (15 de septiembre de 2022): la licencia de un repositorio público a otros usuarios es perpetua pero acotada al uso mediante los servicios y funcionalidades de Hugging Face («Your Content»); el contenido con licencia abierta sigue bajo ella. Al cancelar una cuenta, Hugging Face usa «commercially reasonable efforts» para borrar en 90 días, salvo contribuciones a repositorios ajenos, copias suyas o de otros usuarios y lo retenido por ley o respaldo («Termination»). En esa lectura no encontré una cláusula sobre minería de textos ni sobre acceso automatizado; los ToS sí mencionan aprendizaje automático e inteligencia artificial (definiciones, servicios y exención de garantías). Límite anónimo: 500 peticiones a la API cada 5 minutos por IP (https://huggingface.co/docs/hub/rate-limits, septiembre de 2025).",
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
      text: "Copyright de cada editor; sindicación publicada para redistribuir títulos y extractos.",
      url: null,
    },
    termsReviewedAt: "2026-10-31",
    termsUrl: null,
    access: "public",
    retention: "frozen-corpus",
    deletion:
      "Borrado a petición con engine purge --source rss --url <enlace> | --feed <url del feed> | --author <nombre>.",
    language: "en",
    cost: "none",
    status: "ready",
    coverage: "census",
    engineBaseline: false,
    notes:
      "Política de extracto (decisión de Miguel del 31 de octubre de 2026): se guarda solo título, enlace, autor y extracto de hasta 500 caracteres (body_kind, truncated); borrado a petición con engine purge --source rss --url|--feed|--author; retención del corpus congelado con revisión el 27 de noviembre de 2026; cada feed lleva su nota de licencia y el robots.txt de su sitio se comprueba en cada petición. Los feeds del operador exigen aceptar «uso para análisis privado, sin republicar» al agregarlos.",
  },
};

/** Catalog order; a retired id is not listed. */
export const SOURCE_IDS = Object.keys(SOURCE_CATALOG) as ReadonlyArray<CatalogSourceId>;

export const isCatalogSourceId = (id: string): id is CatalogSourceId =>
  Object.hasOwn(SOURCE_CATALOG, id);
