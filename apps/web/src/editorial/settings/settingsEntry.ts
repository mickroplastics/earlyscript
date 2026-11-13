// Earlyscript-only: the editorial pages of Settings. `settingsSearch.ts`, `SettingsSidebarNav.tsx`
// (icons in `settingsNavIcons.ts`) and `SettingsScopeSentence.tsx` take these at one-line hook
// points (docs/upstream-divergence.md §18).

/** Before the split into five pages; old links (and their anchors) redirect to the new pages. */
export const EDITORIAL_SETTINGS_PATH = "/settings/editorial";

export const EDITORIAL_CHANNEL_PATH = "/settings/editorial/channel";
export const EDITORIAL_SOURCES_PATH = "/settings/editorial/sources";
export const EDITORIAL_NIGHTLY_PATH = "/settings/editorial/nightly";
export const EDITORIAL_DRAFTING_PATH = "/settings/editorial/drafting";
export const EDITORIAL_DATA_PATH = "/settings/editorial/data";

export type EditorialSettingsPath =
  | typeof EDITORIAL_CHANNEL_PATH
  | typeof EDITORIAL_SOURCES_PATH
  | typeof EDITORIAL_NIGHTLY_PATH
  | typeof EDITORIAL_DRAFTING_PATH
  | typeof EDITORIAL_DATA_PATH;

export const EDITORIAL_SETTINGS_LABELS: Readonly<Record<EditorialSettingsPath, string>> = {
  [EDITORIAL_CHANNEL_PATH]: "Mi canal",
  [EDITORIAL_SOURCES_PATH]: "Fuentes",
  [EDITORIAL_NIGHTLY_PATH]: "Revisión nocturna",
  [EDITORIAL_DRAFTING_PATH]: "Redacción",
  [EDITORIAL_DATA_PATH]: "Mis datos",
};

/** Every page reads the primary environment, so none offers the project or machine picker. */
export const EDITORIAL_SETTINGS_SCOPES: Readonly<Record<EditorialSettingsPath, null>> = {
  [EDITORIAL_CHANNEL_PATH]: null,
  [EDITORIAL_SOURCES_PATH]: null,
  [EDITORIAL_NIGHTLY_PATH]: null,
  [EDITORIAL_DRAFTING_PATH]: null,
  [EDITORIAL_DATA_PATH]: null,
};

export const EDITORIAL_DEVICE_ONLY_PATHS = [
  EDITORIAL_SETTINGS_PATH,
  EDITORIAL_CHANNEL_PATH,
  EDITORIAL_SOURCES_PATH,
  EDITORIAL_NIGHTLY_PATH,
  EDITORIAL_DRAFTING_PATH,
  EDITORIAL_DATA_PATH,
] as const;

/** `/settings/editorial` opens «Mi canal»; with an anchor, the page that now holds it. */
export const EDITORIAL_RENAMED_SETTINGS_PATHS: Readonly<
  Record<typeof EDITORIAL_SETTINGS_PATH, EditorialSettingsPath>
> = { [EDITORIAL_SETTINGS_PATH]: EDITORIAL_CHANNEL_PATH };

export const EDITORIAL_SETTINGS_NAV_GROUP = {
  heading: "Editorial",
  paths: [
    EDITORIAL_CHANNEL_PATH,
    EDITORIAL_SOURCES_PATH,
    EDITORIAL_NIGHTLY_PATH,
    EDITORIAL_DRAFTING_PATH,
    EDITORIAL_DATA_PATH,
  ],
} as const;

export const EDITORIAL_STATUS_SECTION_ID = "editorial-status";
export const EDITORIAL_PROFILE_SECTION_ID = "editorial-profile";
export const EDITORIAL_SOURCES_SECTION_ID = "editorial-sources";
export const EDITORIAL_RSS_SECTION_ID = "editorial-source-rss";
export const EDITORIAL_NIGHTLY_SECTION_ID = "editorial-nightly";
export const EDITORIAL_PAIRS_SECTION_ID = "editorial-pairs";
export const EDITORIAL_METHOD_SECTION_ID = "editorial-method";
export const EDITORIAL_DRAFTING_SECTION_ID = "editorial-drafting";
export const EDITORIAL_DATA_HANDLING_ID = "editorial-data-handling";
export const EDITORIAL_ONBOARDING_SECTION_ID = "editorial-onboarding";

export const EDITORIAL_SETTINGS_SEARCH_ITEMS = [
  {
    id: EDITORIAL_PROFILE_SECTION_ID,
    title: "Mi canal",
    to: EDITORIAL_CHANNEL_PATH,
    searchTerms: [
      "perfil profile estudio studio canal channel audiencia audience temas topics idioma",
      "incluir include excluir exclude versión version historial history huella hash filtra puntuación",
    ],
  },
  {
    id: EDITORIAL_STATUS_SECTION_ID,
    title: "Estado de la revisión, las fuentes y la redacción",
    to: EDITORIAL_CHANNEL_PATH,
    searchTerms: ["estado status salud health resumen reintentar retry"],
  },
  {
    id: EDITORIAL_SOURCES_SECTION_ID,
    title: "Fuentes",
    to: EDITORIAL_SOURCES_PATH,
    searchTerms: [
      "sources fuentes captura capturar contar cuentan tendencias cobertura coverage",
      "gobernanza governance licencia license términos terms retención borrado borrar",
      "hacker news github arxiv wikipedia npm stack exchange bluesky hugging face lobsters",
    ],
  },
  {
    id: EDITORIAL_RSS_SECTION_ID,
    title: "Feeds RSS de blogs",
    to: EDITORIAL_SOURCES_PATH,
    searchTerms: ["rss atom feed feeds blogs boletines agregar add probar quitar"],
  },
  {
    id: EDITORIAL_NIGHTLY_SECTION_ID,
    title: "Revisión nocturna",
    to: EDITORIAL_NIGHTLY_PATH,
    searchTerms: [
      "nightly revisión nocturna diaria daily schedule horario hora revisar ahora run now",
      "historial noches reintentar retry jobs",
    ],
  },
  {
    id: EDITORIAL_PAIRS_SECTION_ID,
    title: "Evaluación a ciegas (modo pares)",
    to: EDITORIAL_NIGHTLY_PATH,
    searchTerms: [
      "pares pairs revisión review ciegas ciego blind jueces judges opinión opinion modo mode",
    ],
  },
  {
    id: EDITORIAL_METHOD_SECTION_ID,
    title: "Método evaluado y modelo local",
    to: EDITORIAL_NIGHTLY_PATH,
    searchTerms: [
      "método evaluado method configuración config v3 v1 avanzado advanced",
      "modelo local embeddings qwen descargar download procesos workers paralelo",
    ],
  },
  {
    id: EDITORIAL_DRAFTING_SECTION_ID,
    title: "Redacción",
    to: EDITORIAL_DRAFTING_PATH,
    searchTerms: [
      "redacción drafting modelo model texto text generation título resumen haiku luna",
      "tope límite limit cap mensual monthly presupuesto budget uso usage proveedores",
    ],
  },
  {
    id: EDITORIAL_DATA_HANDLING_ID,
    title: "Cómo se tratan tus datos",
    to: EDITORIAL_DATA_PATH,
    searchTerms: [
      "privacidad privacy datos data telemetría telemetry analítica analytics borrar delete política policy",
    ],
  },
  {
    id: EDITORIAL_ONBOARDING_SECTION_ID,
    title: "Primer arranque",
    to: EDITORIAL_DATA_PATH,
    searchTerms: [
      "asistente inicio primer arranque onboarding welcome setup recorrer decisiones aceptaciones aceptaste",
    ],
  },
] as const;
