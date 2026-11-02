import { PRESENTATION_EVIDENCE_LIMIT, PRESENTATION_EXCERPT_CHARS } from "@t3tools/contracts";

/**
 * Everything that leaves the machine, once: the «Datos y permisos» step and the «Cómo se tratan
 * tus datos» dialog both render this list, and the step's `policyHash` covers it. Checked
 * against the network inventory in docs/upstream-divergence.md (flags section) and the code
 * each entry names; change the code and the entry together.
 */
export interface DataOutbound {
  readonly id: string;
  /** What leaves, as the start of a sentence in lower case. */
  readonly what: string;
  /** Where it goes. */
  readonly where: string;
  /** When it happens. */
  readonly when: string;
  /** `earlyscript`: the product's own; `t3`: inherited from T3 Code and still on. */
  readonly origin: "earlyscript" | "t3";
  /** The step's long account of a highlighted entry; null for the rest. */
  readonly detail: string | null;
}

const formatCount = (count: number) => count.toLocaleString("es");

export const DATA_OUTBOUND: ReadonlyArray<DataOutbound> = [
  {
    // packages/trend-engine/src/sources (PAUSE_MS in http.ts, robots.ts).
    id: "captures",
    what: "las peticiones de captura",
    where: "cada fuente que actives",
    when: "en cada captura",
    origin: "earlyscript",
    detail:
      "Las peticiones a cada fuente activada para capturar. Earlyscript deja una pausa mínima entre peticiones (de 0,25 s en Hacker News a 6,5 s en GitHub), se detiene ante sus límites de cuota y comprueba el robots.txt del sitio antes de cada petición, salvo en las API de Hacker News y GitHub; arXiv tiene una excepción documentada por los términos de su API.",
  },
  {
    // apps/server/src/editorial/presentationDossierSource.ts and the video thread.
    id: "drafting",
    what: "los textos de las tendencias",
    where: "el proveedor de modelos que elijas (Claude o Codex)",
    when: "cuando redacta presentaciones o guiones",
    origin: "earlyscript",
    detail: `Los textos de las tendencias que pidas redactar. Al proveedor de modelos que elijas (Claude o Codex, con tu cuenta y bajo sus condiciones) van el perfil editorial del canal, las cifras del motor para esa tendencia y como máximo ${formatCount(PRESENTATION_EVIDENCE_LIMIT)} ítems de evidencia con su fuente, fecha, enlace, título y un extracto recortado a ${formatCount(PRESENTATION_EXCERPT_CHARS)} caracteres. En un hilo de video, ese proveedor recibe además lo que escribas y lo que su agente lea del espacio de trabajo.`,
  },
  {
    // packages/trend-engine/src/embed/model.ts.
    id: "embedding-model",
    what: "el modelo de embeddings",
    where: "huggingface.co",
    when: "una vez, para descargarlo",
    origin: "earlyscript",
    detail: null,
  },
  {
    // packages/provider-core/src/server/maintenanceResolver.ts.
    id: "cli-versions",
    what: "las versiones de los CLI de los proveedores",
    where: "registry.npmjs.org",
    when: "al revisar o actualizar proveedores",
    origin: "t3",
    detail: null,
  },
  {
    // apps/server/src/usage/cliproxyApi.ts.
    id: "anthropic-usage",
    what: "el uso de tu cuenta de Anthropic",
    where: "api.anthropic.com",
    when: "al mostrar el uso del proveedor",
    origin: "t3",
    detail: null,
  },
  {
    // apps/server/src/provider/ModelManifest.ts.
    id: "model-catalog",
    what: "el catálogo de modelos",
    where: "GitHub, del proyecto T3 Code",
    when: "al cargar los proveedores",
    origin: "t3",
    detail: null,
  },
  {
    // apps/server/src/usage/UsageService.ts.
    id: "pricing",
    what: "la tabla de precios de los modelos",
    where: "GitHub, del proyecto LiteLLM",
    when: "al calcular el uso",
    origin: "t3",
    detail: null,
  },
  {
    // packages/shared/src/favicon.ts.
    id: "favicons",
    what: "los iconos de los sitios enlazados",
    where: "www.google.com, que recibe sus dominios",
    when: "al mostrar enlaces",
    origin: "t3",
    detail: null,
  },
];

/** The two the step explains at length: captures and drafting. */
export const HIGHLIGHTED_OUTBOUND = DATA_OUTBOUND.filter((entry) => entry.detail !== null);
export const OTHER_OUTBOUND = DATA_OUTBOUND.filter((entry) => entry.detail === null);

const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** «El modelo de embeddings: huggingface.co, una vez, para descargarlo.» */
export const outboundSentence = (entry: DataOutbound) =>
  `${capitalize(entry.what)}: ${entry.where}, ${entry.when}.`;

export const OTHER_OUTBOUND_PREFIX = "Además, la app consulta: ";
export const otherOutboundItem = (entry: DataOutbound) => `${entry.what} (${entry.where})`;

/** The step's one line for the rest: «Además, la app consulta: …». */
export const otherOutboundLine = () =>
  `${OTHER_OUTBOUND_PREFIX}${OTHER_OUTBOUND.map(otherOutboundItem).join("; ")}.`;
